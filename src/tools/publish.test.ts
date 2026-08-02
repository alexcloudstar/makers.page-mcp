import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DraftStore } from "../drafts/store.js"
import {
  NotAuthenticatedError,
  XApiError,
  type CreateTweetInput,
  type CreatedTweet,
} from "../channels/x/client.js"
import { NetworkError } from "../util/fetch-with-timeout.js"
import { registerPublishTools } from "./publish.js"

// A minimal stand-in for McpServer: just enough for registerTool to capture
// the handler so tests can invoke it directly, without spinning up a real
// MCP transport.
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

class FakeXClient {
  calls: CreateTweetInput[] = []
  deleted: string[] = []
  uploads: string[] = []
  private readonly impl: (input: CreateTweetInput) => Promise<CreatedTweet>
  private readonly uploadImpl?: (filePath: string) => Promise<string>
  private readonly deleteImpl?: (id: string) => Promise<void>

  constructor(
    impl: (input: CreateTweetInput) => Promise<CreatedTweet>,
    extras?: {
      uploadMedia?: (filePath: string) => Promise<string>
      deleteTweet?: (id: string) => Promise<void>
    },
  ) {
    this.impl = impl
    this.uploadImpl = extras?.uploadMedia
    this.deleteImpl = extras?.deleteTweet
  }

  async createTweet(input: CreateTweetInput) {
    this.calls.push(input)
    return this.impl(input)
  }

  async uploadMedia(filePath: string) {
    this.uploads.push(filePath)
    if (this.uploadImpl) return this.uploadImpl(filePath)
    return `media-${this.uploads.length}`
  }

  async deleteTweet(id: string) {
    this.deleted.push(id)
    if (this.deleteImpl) return this.deleteImpl(id)
  }
}

let draftsDir: string
let store: DraftStore
let config: Config

beforeEach(async () => {
  draftsDir = await mkdtemp(path.join(os.tmpdir(), "publish-test-"))
  store = new DraftStore({ draftsDir })
  config = { requireApproval: true, maxPostLength: 280 } as Config
})

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true })
})

const noApprovalConfig = { requireApproval: false, maxPostLength: 280 } as Config

const registerTools = (xClient: FakeXClient, cfg: Config = config, storeOverride?: typeof store) => {
  const server = new StubServer()
  registerPublishTools(server as unknown as never, cfg, {
    store: storeOverride ?? store,
    xClient,
  })
  return server
}

describe("publish_draft error handling", () => {
  test("a definitive XApiError reverts the draft and reports an error", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async () => {
      throw new XApiError("bad request", 400, { detail: "bad request" })
    })

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("X API error (400)")

    const reverted = await store.get(draft.id)
    expect(reverted.status).toBe("approved")
  })

  test("NotAuthenticatedError reverts the draft and reports an error", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async () => {
      throw new NotAuthenticatedError()
    })

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    const reverted = await store.get(draft.id)
    expect(reverted.status).toBe("approved")
  })

  test("a NetworkError (e.g. timeout) leaves the draft in 'publishing' without reverting", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async () => {
      throw new NetworkError("Request timed out after 20000ms")
    })

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("network error")
    expect(text).toContain("publishing")

    const stuck = await store.get(draft.id)
    expect(stuck.status).toBe("publishing")
  })

  test("an unexpected error after createTweet was attempted leaves publishing (duplicate-post guard)", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async () => {
      // Simulates HTTP 200 with a body we failed to parse (result.data.id throws).
      throw new TypeError("cannot read properties of undefined")
    })

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("after a create request was sent")

    const stuck = await store.get(draft.id)
    expect(stuck.status).toBe("publishing")
  })

  test("an unexpected error during media upload (before createTweet) still reverts", async () => {
    const mediaPath = path.join(draftsDir, "pic.png")
    await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const draft = await store.create({
      channel: "x",
      text: "hello",
      mediaPaths: [mediaPath],
    })
    await store.approve(draft.id)
    const xClient = new FakeXClient(
      async () => {
        throw new Error("createTweet should not be called")
      },
      {
        uploadMedia: async () => {
          throw new TypeError("cannot read properties of undefined")
        },
      },
    )

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("before reaching X")

    const reverted = await store.get(draft.id)
    expect(reverted.status).toBe("approved")
  })
})

describe("publish_draft happy path", () => {
  test("publishes an approved draft and records the result", async () => {
    const draft = await store.create({ channel: "x", text: "hello world" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async (input) => ({
      id: "123",
      text: input.text,
      url: "https://x.com/i/web/status/123",
    }))

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain("https://x.com/i/web/status/123")

    const published = await store.get(draft.id)
    expect(published.status).toBe("published")
    expect(published.externalId).toBe("123")
    expect(published.externalIds).toEqual(["123"])
  })

  test("publishes a thread by chaining replyToId to the previous part", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two", "part three"],
    })
    await store.approve(draft.id)

    let n = 0
    const xClient = new FakeXClient(async (input) => {
      n += 1
      return { id: String(n), text: input.text, url: `https://x.com/i/web/status/${n}` }
    })

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect(xClient.calls.map((c) => c.text)).toEqual(["part one", "part two", "part three"])
    expect(xClient.calls[0]?.replyToId).toBeUndefined()
    expect(xClient.calls[1]?.replyToId).toBe("1")
    expect(xClient.calls[2]?.replyToId).toBe("2")

    const published = await store.get(draft.id)
    expect(published.externalIds).toEqual(["1", "2", "3"])
    expect(published.urls).toEqual([
      "https://x.com/i/web/status/1",
      "https://x.com/i/web/status/2",
      "https://x.com/i/web/status/3",
    ])
  })

  test("partial thread failure records posted ids and leaves status publishing", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two"],
    })
    await store.approve(draft.id)

    let n = 0
    const xClient = new FakeXClient(async (input) => {
      n += 1
      if (n === 2) throw new XApiError("rate limited", 429, {})
      return { id: String(n), text: input.text, url: `https://x.com/i/web/status/${n}` }
    })

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("1 of 2")

    const stuck = await store.get(draft.id)
    expect(stuck.status).toBe("publishing")
    expect(stuck.externalIds).toEqual(["1"])
  })

  test("refuses to retry publish after partial publish with recorded live ids", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two"],
    })
    await store.beginPublishing(draft.id)
    await store.recordPartialPublish(draft.id, {
      externalIds: ["1"],
      urls: ["https://x.com/i/web/status/1"],
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("delete_published_draft")
    expect(xClient.calls).toEqual([])
  })

  test("uploads media before creating the tweet", async () => {
    const mediaPath = path.join(draftsDir, "pic.png")
    await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const draft = await store.create({
      channel: "x",
      text: "with media",
      mediaPaths: [mediaPath],
    })
    await store.approve(draft.id)

    const xClient = new FakeXClient(
      async (input) => ({
        id: "9",
        text: input.text,
        url: "https://x.com/i/web/status/9",
      }),
      { uploadMedia: async () => "media-abc" },
    )

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect(xClient.uploads).toEqual([mediaPath])
    expect(xClient.calls[0]?.mediaIds).toEqual(["media-abc"])
  })

  test("network error during media upload (before any tweet) reverts the draft", async () => {
    const mediaPath = path.join(draftsDir, "pic.png")
    await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const draft = await store.create({
      channel: "x",
      text: "with media",
      mediaPaths: [mediaPath],
    })
    await store.approve(draft.id)

    const xClient = new FakeXClient(
      async () => {
        throw new Error("createTweet should not be called")
      },
      {
        uploadMedia: async () => {
          throw new NetworkError("upload timed out")
        },
      },
    )

    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("preparing media")
    expect(xClient.calls).toEqual([])

    const reverted = await store.get(draft.id)
    expect(reverted.status).toBe("approved")
  })

  test("refuses to publish when media file disappeared since draft creation", async () => {
    const mediaPath = path.join(draftsDir, "missing.png")
    await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const draft = await store.create({
      channel: "x",
      text: "with media",
      mediaPaths: [mediaPath],
    })
    await store.approve(draft.id)
    await rm(mediaPath, { force: true })

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("does not exist")
    expect(xClient.calls).toEqual([])
    const stillApproved = await store.get(draft.id)
    expect(stillApproved.status).toBe("approved")
  })

  test("markPublished failure still reports success, since the tweet already went out", async () => {
    const draft = await store.create({ channel: "x", text: "hello world" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async (input) => ({
      id: "123",
      text: input.text,
      url: "https://x.com/i/web/status/123",
    }))

    const failingStore: Pick<
      DraftStore,
      | "get"
      | "beginPublishing"
      | "revertPublishing"
      | "markPublished"
      | "recordPartialPublish"
      | "markDeleted"
      | "setRemainingLiveIds"
      | "applyEdit"
    > = {
      get: (id) => store.get(id),
      beginPublishing: (id) => store.beginPublishing(id),
      revertPublishing: (id, status) => store.revertPublishing(id, status),
      recordPartialPublish: (id, result) => store.recordPartialPublish(id, result),
      markDeleted: (id) => store.markDeleted(id),
      setRemainingLiveIds: (id, result) => store.setRemainingLiveIds(id, result),
      applyEdit: (id, result) => store.applyEdit(id, result),
      markPublished: async () => {
        throw new Error("disk full")
      },
    }

    const server = new StubServer()
    registerPublishTools(server as unknown as never, config, { store: failingStore, xClient })
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("https://x.com/i/web/status/123")
    expect(text).toContain("WARNING")
  })
})

describe("publish_draft guards", () => {
  test("refuses to publish an already-published draft without calling the X client", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, { externalId: "1", url: "https://x.com/i/web/status/1" })

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect(xClient.calls).toEqual([])
  })

  test("refuses to retry a draft already stuck in 'publishing' without calling the X client", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(draft.id)

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect(xClient.calls).toEqual([])
  })

  test("requires approval before publishing when requireApproval is true", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient, { requireApproval: true, maxPostLength: 280 } as Config)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect(xClient.calls).toEqual([])
  })

  test("allows publishing an unapproved draft when requireApproval is false", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })

    const xClient = new FakeXClient(async (input) => ({
      id: "1",
      text: input.text,
      url: "https://x.com/i/web/status/1",
    }))
    const server = registerTools(xClient, { requireApproval: false, maxPostLength: 280 } as Config)
    const result = await server.call("publish_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect(xClient.calls.map((c) => c.text)).toEqual(["hello"])
  })

  test("rejects an unsupported channel without calling the X client", async () => {
    const id = "11111111-1111-1111-1111-111111111111"
    await writeFile(
      path.join(draftsDir, `${id}.json`),
      JSON.stringify({
        id,
        channel: "linkedin",
        text: "hello",
        status: "approved",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    )

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient)
    const result = await server.call("publish_draft", { id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("Unsupported channel")
    expect(xClient.calls).toEqual([])
  })
})

describe("publish_draft concurrency", () => {
  test("withDraftLock serializes two concurrent publish_draft calls for the same id", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)

    let inFlight = 0
    let maxConcurrent = 0
    const xClient = new FakeXClient(async (input) => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return { id: "1", text: input.text, url: "https://x.com/i/web/status/1" }
    })

    const server = registerTools(xClient)
    const [first, second] = await Promise.all([
      server.call("publish_draft", { id: draft.id }),
      server.call("publish_draft", { id: draft.id }),
    ])

    expect(maxConcurrent).toBe(1)
    expect(xClient.calls.length).toBe(1)
    const results = [first, second]
    expect(results.filter((r) => r.isError).length).toBe(1)
    expect(results.filter((r) => !r.isError).length).toBe(1)
  })
})

describe("delete_published_draft", () => {
  test("requires approval when requireApproval is true", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server = registerTools(xClient, { requireApproval: true, maxPostLength: 280 } as Config)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("MAKERS_PAGE_REQUIRE_APPROVAL")
    expect(xClient.deleted).toEqual([])
  })

  test("deletes live ids from a publishing draft after partial thread publish", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two"],
    })
    await store.beginPublishing(draft.id)
    await store.recordPartialPublish(draft.id, {
      externalIds: ["1"],
      urls: ["https://x.com/i/web/status/1"],
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect(xClient.deleted).toEqual(["1"])
    expect((await store.get(draft.id)).status).toBe("deleted")
  })

  test("deletes live ids even if status is draft (legacy/corrupt record)", async () => {
    const id = "22222222-2222-2222-2222-222222222222"
    await writeFile(
      path.join(draftsDir, `${id}.json`),
      JSON.stringify({
        id,
        channel: "x",
        text: "hello",
        status: "draft",
        externalId: "9",
        externalIds: ["9"],
        url: "https://x.com/i/web/status/9",
        urls: ["https://x.com/i/web/status/9"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    )

    const xClient = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id })

    expect(result.isError).toBeUndefined()
    expect(xClient.deleted).toEqual(["9"])
    expect((await store.get(id)).status).toBe("deleted")
  })

  test("deletes all stored ids and marks the draft deleted", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two"],
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
      externalIds: ["1", "2"],
      urls: ["https://x.com/i/web/status/1", "https://x.com/i/web/status/2"],
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect(xClient.deleted).toEqual(["1", "2"])
    const deleted = await store.get(draft.id)
    expect(deleted.status).toBe("deleted")
  })

  test("mid-delete failure records remaining ids so a retry can finish", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two", "part three"],
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
      externalIds: ["1", "2", "3"],
      urls: [
        "https://x.com/i/web/status/1",
        "https://x.com/i/web/status/2",
        "https://x.com/i/web/status/3",
      ],
    })

    let deletes = 0
    const xClient = new FakeXClient(
      async () => {
        throw new Error("create should not be called")
      },
      {
        deleteTweet: async () => {
          deletes += 1
          if (deletes === 2) throw new XApiError("rate limited", 429, {})
        },
      },
    )
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    const afterFailure = await store.get(draft.id)
    expect(afterFailure.status).toBe("published")
    expect(afterFailure.externalIds).toEqual(["2", "3"])

    // Retry: first remaining id was the one that failed; succeed for both.
    const xClient2 = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server2 = registerTools(xClient2, noApprovalConfig)
    const retry = await server2.call("delete_published_draft", { id: draft.id })
    expect(retry.isError).toBeUndefined()
    expect(xClient2.deleted).toEqual(["2", "3"])
    expect((await store.get(draft.id)).status).toBe("deleted")
  })

  test("treats 404 on delete as already gone and continues", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
      externalIds: ["1", "2"],
      urls: ["https://x.com/i/web/status/1", "https://x.com/i/web/status/2"],
    })

    const xClient = new FakeXClient(
      async () => {
        throw new Error("create should not be called")
      },
      {
        deleteTweet: async (id) => {
          if (id === "1") throw new XApiError("not found", 404, {})
        },
      },
    )
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect((await store.get(draft.id)).status).toBe("deleted")
  })

  test("does not treat 403 as already gone (post may still be live)", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
      externalIds: ["1", "2"],
      urls: ["https://x.com/i/web/status/1", "https://x.com/i/web/status/2"],
    })

    const xClient = new FakeXClient(
      async () => {
        throw new Error("create should not be called")
      },
      {
        deleteTweet: async () => {
          throw new XApiError("forbidden", 403, {})
        },
      },
    )
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("403")
    const still = await store.get(draft.id)
    expect(still.status).toBe("published")
    expect(still.externalIds).toEqual(["1", "2"])
  })

  test("normalizes mismatched urls/ids length when deleting", async () => {
    const draft = await store.create({
      channel: "x",
      text: "part one",
      parts: ["part one", "part two"],
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
      externalIds: ["1", "2"],
      // Corrupt / partial: only one url for two ids
      urls: ["https://x.com/i/web/status/1"],
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("delete_published_draft", { id: draft.id })

    expect(result.isError).toBeUndefined()
    expect(xClient.deleted).toEqual(["1", "2"])
    expect((await store.get(draft.id)).status).toBe("deleted")
  })
})

describe("edit_published_draft", () => {
  test("requires approval when requireApproval is true", async () => {
    const draft = await store.create({ channel: "x", text: "original" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("create should not be called")
    })
    const server = registerTools(xClient, { requireApproval: true, maxPostLength: 280 } as Config)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("MAKERS_PAGE_REQUIRE_APPROVAL")
    expect(xClient.calls).toEqual([])
  })

  test("edits the root post and stores the new id", async () => {
    const draft = await store.create({ channel: "x", text: "original" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(async (input) => ({
      id: "11",
      text: input.text,
      url: "https://x.com/i/web/status/11",
    }))
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBeUndefined()
    expect(xClient.calls[0]?.editPreviousPostId).toBe("10")
    expect(xClient.calls[0]?.text).toBe("edited")

    const updated = await store.get(draft.id)
    expect(updated.externalId).toBe("11")
    expect(updated.text).toBe("edited")
    expect(updated.status).toBe("published")
  })

  test("re-uploads media on edit so attachments are not stripped", async () => {
    const mediaPath = path.join(draftsDir, "pic.png")
    await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const draft = await store.create({
      channel: "x",
      text: "original",
      mediaPaths: [mediaPath],
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(
      async (input) => ({
        id: "11",
        text: input.text,
        url: "https://x.com/i/web/status/11",
      }),
      { uploadMedia: async () => "media-edited" },
    )
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBeUndefined()
    expect(xClient.uploads).toEqual([mediaPath])
    expect(xClient.calls[0]?.mediaIds).toEqual(["media-edited"])
    expect(xClient.calls[0]?.editPreviousPostId).toBe("10")
  })

  test("re-sends quoteTweetId on edit", async () => {
    const draft = await store.create({
      channel: "x",
      text: "original",
      quoteTweetId: "99",
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(async (input) => ({
      id: "11",
      text: input.text,
      url: "https://x.com/i/web/status/11",
    }))
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBeUndefined()
    expect(xClient.calls[0]?.quoteTweetId).toBe("99")
  })

  test("preserves paidPartnership on edit when not overridden", async () => {
    const draft = await store.create({
      channel: "x",
      text: "original",
      paidPartnership: true,
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(async (input) => ({
      id: "11",
      text: input.text,
      url: "https://x.com/i/web/status/11",
    }))
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBeUndefined()
    expect(xClient.calls[0]?.paidPartnership).toBe(true)
    expect((await store.get(draft.id)).paidPartnership).toBe(true)
  })

  test("rejects editing a poll draft", async () => {
    const draft = await store.create({
      channel: "x",
      text: "vote",
      poll: { options: ["a", "b"], durationMinutes: 60 },
    })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("polls")
    expect(xClient.calls).toEqual([])
  })

  test("unexpected error after edit request warns against blind retry and keeps old externalId", async () => {
    const draft = await store.create({ channel: "x", text: "original" })
    await store.beginPublishing(draft.id)
    await store.markPublished(draft.id, {
      externalId: "10",
      url: "https://x.com/i/web/status/10",
    })

    const xClient = new FakeXClient(async () => {
      throw new TypeError("cannot read properties of undefined")
    })
    const server = registerTools(xClient, noApprovalConfig)
    const result = await server.call("edit_published_draft", { id: draft.id, text: "edited" })

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("may or may not have applied")
    expect(text).toContain("Do NOT retry")

    const unchanged = await store.get(draft.id)
    expect(unchanged.status).toBe("published")
    expect(unchanged.externalId).toBe("10")
    expect(unchanged.text).toBe("original")
  })
})
