import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DraftStore } from "../drafts/store.js"
import { NotAuthenticatedError, XApiError } from "../channels/x/client.js"
import { NetworkError } from "../util/fetch-with-timeout.js"
import { registerPublishTools } from "./publish.js"

// A minimal stand-in for McpServer: just enough for registerTool to capture
// the handler so tests can invoke it directly, without spinning up a real
// MCP transport.
class StubServer {
  private handlers = new Map<string, (args: { id: string }) => Promise<CallToolResult>>()

  registerTool(
    name: string,
    _definition: unknown,
    handler: (args: { id: string }) => Promise<CallToolResult>,
  ): void {
    this.handlers.set(name, handler)
  }

  call(name: string, args: { id: string }): Promise<CallToolResult> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`Tool "${name}" was not registered.`)
    return handler(args)
  }
}

class FakeXClient {
  calls: string[] = []
  private readonly impl: (text: string) => Promise<{ id: string; text: string; url: string }>

  constructor(impl: (text: string) => Promise<{ id: string; text: string; url: string }>) {
    this.impl = impl
  }

  async createTweet(text: string) {
    this.calls.push(text)
    return this.impl(text)
  }
}

let draftsDir: string
let store: DraftStore
let config: Config

beforeEach(async () => {
  draftsDir = await mkdtemp(path.join(os.tmpdir(), "publish-test-"))
  store = new DraftStore({ draftsDir })
  config = { requireApproval: true } as Config
})

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true })
})

const registerAndGetPublish = (xClient: Pick<FakeXClient, "createTweet">, cfg: Config = config) => {
  const server = new StubServer()
  registerPublishTools(server as unknown as never, cfg, { store, xClient })
  return (id: string) => server.call("publish_draft", { id })
}

describe("publish_draft error handling", () => {
  test("a definitive XApiError reverts the draft and reports an error", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async () => {
      throw new XApiError("bad request", 400, { detail: "bad request" })
    })

    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

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

    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

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

    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("network error")
    expect(text).toContain("publishing")

    const stuck = await store.get(draft.id)
    expect(stuck.status).toBe("publishing")
  })

  test("an unexpected local error (not from the network) reverts the draft, since nothing was sent", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async () => {
      throw new TypeError("cannot read properties of undefined")
    })

    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("failed unexpectedly before reaching X")

    const reverted = await store.get(draft.id)
    expect(reverted.status).toBe("approved")
  })
})

describe("publish_draft happy path", () => {
  test("publishes an approved draft and records the result", async () => {
    const draft = await store.create({ channel: "x", text: "hello world" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async (text) => ({
      id: "123",
      text,
      url: "https://x.com/i/web/status/123",
    }))

    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

    expect(result.isError).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain("https://x.com/i/web/status/123")

    const published = await store.get(draft.id)
    expect(published.status).toBe("published")
    expect(published.externalId).toBe("123")
  })

  test("markPublished failure still reports success, since the tweet already went out", async () => {
    const draft = await store.create({ channel: "x", text: "hello world" })
    await store.approve(draft.id)
    const xClient = new FakeXClient(async (text) => ({
      id: "123",
      text,
      url: "https://x.com/i/web/status/123",
    }))

    const failingStore: Pick<DraftStore, "get" | "beginPublishing" | "revertPublishing" | "markPublished"> = {
      get: (id) => store.get(id),
      beginPublishing: (id) => store.beginPublishing(id),
      revertPublishing: (id, status) => store.revertPublishing(id, status),
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
    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

    expect(result.isError).toBe(true)
    expect(xClient.calls).toEqual([])
  })

  test("refuses to retry a draft already stuck in 'publishing' without calling the X client", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(draft.id)

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const publish = registerAndGetPublish(xClient)
    const result = await publish(draft.id)

    expect(result.isError).toBe(true)
    expect(xClient.calls).toEqual([])
  })

  test("requires approval before publishing when requireApproval is true", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })

    const xClient = new FakeXClient(async () => {
      throw new Error("should not be called")
    })
    const publish = registerAndGetPublish(xClient, { requireApproval: true } as Config)
    const result = await publish(draft.id)

    expect(result.isError).toBe(true)
    expect(xClient.calls).toEqual([])
  })

  test("allows publishing an unapproved draft when requireApproval is false", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })

    const xClient = new FakeXClient(async (text) => ({
      id: "1",
      text,
      url: "https://x.com/i/web/status/1",
    }))
    const publish = registerAndGetPublish(xClient, { requireApproval: false } as Config)
    const result = await publish(draft.id)

    expect(result.isError).toBeUndefined()
    expect(xClient.calls).toEqual(["hello"])
  })

  test("rejects an unsupported channel without calling the X client", async () => {
    // DraftStore.create only accepts channel "x" at the type level; write a
    // draft file directly to simulate a legacy/foreign-channel record.
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
    const publish = registerAndGetPublish(xClient)
    const result = await publish(id)

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
    const xClient = new FakeXClient(async (text) => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return { id: "1", text, url: "https://x.com/i/web/status/1" }
    })

    const publish = registerAndGetPublish(xClient)
    const [first, second] = await Promise.all([publish(draft.id), publish(draft.id)])

    expect(maxConcurrent).toBe(1)
    expect(xClient.calls.length).toBe(1)
    // The second call runs after the draft is already "published", so it
    // should be rejected by the status guard rather than posting again.
    const results = [first, second]
    expect(results.filter((r) => r.isError).length).toBe(1)
    expect(results.filter((r) => !r.isError).length).toBe(1)
  })
})
