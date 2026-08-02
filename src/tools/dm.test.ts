import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
    if (!handler) throw new Error(`Tool "${name}" was not registered.`)
    return handler(args)
  }
}

const textOf = (result: CallToolResult): string => (result.content[0] as { text: string }).text

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
      xClient: {
        getUserByUsername: async () => ({ id: "42", username: "u", name: "U" }),
        sendDmByParticipantId: async (participantId, input) => {
          sends.push(`${participantId}:${input.text}`)
          return { dmEventId: "evt-1", dmConversationId: "conv-1" }
        },
        sendDmByConversationId: async () => {
          throw new Error("unexpected")
        },
        listDmEventsByParticipant: async () => [],
        uploadMedia: async () => "media-1",
      },
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
      xClient: {
        getUserByUsername: async () => ({ id: "42", username: "u", name: "U" }),
        sendDmByParticipantId: async () => ({ dmEventId: "1", dmConversationId: "2" }),
        sendDmByConversationId: async () => ({ dmEventId: "1", dmConversationId: "2" }),
        listDmEventsByParticipant: async () => [],
        uploadMedia: async () => "m",
      },
    })

    const result = await server.call("send_dm_draft", { id: draft.id })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("approve_dm_draft")
  })
})
