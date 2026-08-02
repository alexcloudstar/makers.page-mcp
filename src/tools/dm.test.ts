import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DmDraftStore } from "../dm/store.js"
import { DmRateLimiter } from "../dm/rate-limit.js"
import { registerDmTools } from "./dm.js"

class StubServer {
  private handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>()

  registerTool(
    name: string,
    _definition: unknown,
    handler: (args: never) => Promise<CallToolResult>,
  ): void {
    this.handlers.set(name, handler as (args: Record<string, unknown>) => Promise<CallToolResult>)
  }

  call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error('Tool "' + name + '" was not registered.')
    return handler(args)
  }
}

const textOf = (result: CallToolResult): string => (result.content[0] as { text: string }).text

const stubXClient = (overrides: Record<string, unknown> = {}) => ({
  getUserByUsername: async () => ({ id: "42", username: "u", name: "U" }),
  sendDmByParticipantId: async () => ({ dmEventId: "1", dmConversationId: "2" }),
  sendDmByConversationId: async () => ({ dmEventId: "1", dmConversationId: "2" }),
  listDmEventsByParticipant: async () => [],
  listDmEventsByConversationId: async () => [],
  listDmInbox: async () => [],
  createGroupDmConversation: async () => ({ dmEventId: "g-1", dmConversationId: "gc-1" }),
  uploadMedia: async () => "media-1",
  ...overrides,
})

let dmDraftsDir: string
let dataDir: string
let config: Config

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "dm-tools-data-"))
  dmDraftsDir = path.join(dataDir, "dm-drafts")
  config = {
    dataDir,
    dmDraftsDir,
    requireApproval: true,
    maxDmLength: 10_000,
    dmRateLimit: { maxPerHour: 10, maxPerDay: 50, minIntervalMs: 0 },
  } as Config
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe("send_dm_draft", () => {
  test("sends an approved draft and records rate limit", async () => {
    const store = new DmDraftStore(config)
    const draft = await store.create({ text: "hey!", recipientId: "42" })
    await store.approve(draft.id)

    const sends: string[] = []
    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient({
        sendDmByParticipantId: async (participantId: string, input: { text: string }) => {
          sends.push(participantId + ":" + input.text)
          return { dmEventId: "evt-1", dmConversationId: "conv-1" }
        },
        sendDmByConversationId: async () => {
          throw new Error("unexpected")
        },
      }),
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("DM sent")
    expect(sends).toEqual(["42:hey!"])

    const updated = await store.get(draft.id)
    expect(updated.status).toBe("sent")
    expect(updated.dmEventId).toBe("evt-1")
  })

  test("refuses unapproved draft when approval required", async () => {
    const store = new DmDraftStore(config)
    const draft = await store.create({ text: "hey!", recipientId: "42" })

    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient(),
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("approve_dm_draft")
  })

  test("sends a group dm via createGroupDmConversation", async () => {
    const store = new DmDraftStore(config)
    const draft = await store.create({
      text: "hey group",
      conversationType: "group",
      participantIds: ["1", "2"],
    })
    await store.approve(draft.id)

    let groupCalled = false
    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient({
        createGroupDmConversation: async (ids: string[], input: { text: string }) => {
          groupCalled = true
          expect(ids).toEqual(["1", "2"])
          expect(input.text).toBe("hey group")
          return { dmEventId: "gevt", dmConversationId: "gconv" }
        },
      }),
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(groupCalled).toBe(true)
  })

  test("sends dm with media attachment", async () => {
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), "dm-media-"))
    const mediaPath = path.join(mediaDir, "x.png")
    await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]))

    const store = new DmDraftStore(config)
    const draft = await store.create({
      text: "pic",
      recipientId: "42",
      mediaPaths: [mediaPath],
    })
    await store.approve(draft.id)

    let uploaded = false
    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient({
        sendDmByParticipantId: async (_id: string, input: { text: string; mediaIds?: string[] }) => {
          expect(input.mediaIds).toEqual(["media-xyz"])
          return { dmEventId: "e1", dmConversationId: "c1" }
        },
        uploadMedia: async () => {
          uploaded = true
          return "media-xyz"
        },
      }),
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(uploaded).toBe(true)

    await rm(mediaDir, { recursive: true, force: true })
  })

  test("returns success with warning when markSent and recordSentOutcome both fail after X send", async () => {
    const baseStore = new DmDraftStore(config)
    const draft = await baseStore.create({ text: "hey!", recipientId: "42" })
    await baseStore.approve(draft.id)

    const store = Object.assign(Object.create(Object.getPrototypeOf(baseStore)), baseStore, {
      markSent: async () => {
        throw new Error("disk full")
      },
      recordSentOutcome: async () => {
        throw new Error("disk full")
      },
    }) as DmDraftStore

    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient(),
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("WARNING")
    expect(textOf(result)).toContain("event id: 1")

    const updated = await baseStore.get(draft.id)
    expect(updated.status).toBe("sending")
  })

  test("persists sent outcome via recordSentOutcome when markSent fails after X send", async () => {
    const baseStore = new DmDraftStore(config)
    const draft = await baseStore.create({ text: "hey!", recipientId: "42" })
    await baseStore.approve(draft.id)

    const store = Object.assign(Object.create(Object.getPrototypeOf(baseStore)), baseStore, {
      markSent: async () => {
        throw new Error("disk full")
      },
    }) as DmDraftStore

    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient(),
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).not.toContain("WARNING")

    const updated = await baseStore.get(draft.id)
    expect(updated.status).toBe("sent")
    expect(updated.dmEventId).toBe("1")
  })
})

describe("reject_dm_draft", () => {
  test("refuses to reject a draft stuck in sending", async () => {
    const store = new DmDraftStore(config)
    const draft = await store.create({ text: "hey!", recipientId: "42" })
    await store.beginSending(draft.id)

    const server = new StubServer()
    registerDmTools(server as unknown as never, config, {
      store,
      rateLimiter: new DmRateLimiter(config),
      xClient: stubXClient(),
    })

    const result = await server.call("reject_dm_draft", { id: draft.id })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("sending")
  })
})
