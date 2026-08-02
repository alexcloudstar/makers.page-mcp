import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DraftStore } from "../drafts/store.js"
import { registerDraftTools } from "./draft.js"

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

let draftsDir: string
let config: Config

beforeEach(async () => {
  draftsDir = await mkdtemp(path.join(os.tmpdir(), "draft-tools-"))
  config = {
    draftsDir,
    requireApproval: true,
    maxPostLength: 280,
  } as Config
})

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true })
})

const register = () => {
  const server = new StubServer()
  registerDraftTools(server as unknown as never, config)
  return server
}

describe("update_draft", () => {
  test("text-only update on a thread syncs parts[0]", async () => {
    const store = new DraftStore({ draftsDir })
    const created = await store.create({
      channel: "x",
      text: "one",
      parts: ["one", "two"],
    })

    const server = register()
    const result = await server.call("update_draft", { id: created.id, text: "one edited" })

    expect(result.isError).toBeUndefined()
    const updated = await store.get(created.id)
    expect(updated.text).toBe("one edited")
    expect(updated.parts).toEqual(["one edited", "two"])
  })

  test("rejects updates to published drafts", async () => {
    const store = new DraftStore({ draftsDir })
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)
    await store.markPublished(created.id, {
      externalId: "1",
      url: "https://x.com/i/web/status/1",
    })

    const server = register()
    const result = await server.call("update_draft", { id: created.id, text: "nope" })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("edit_published_draft")
    expect((await store.get(created.id)).text).toBe("hello")
  })

  test("rejects updates with no content fields", async () => {
    const store = new DraftStore({ draftsDir })
    const created = await store.create({ channel: "x", text: "hello" })
    const before = await store.get(created.id)

    const server = register()
    const result = await server.call("update_draft", { id: created.id })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("at least one content field")
    const after = await store.get(created.id)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  test("rejects updates when publishing with recorded live ids", async () => {
    const store = new DraftStore({ draftsDir })
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)
    await store.recordPartialPublish(created.id, {
      externalIds: ["1"],
      urls: ["https://x.com/i/web/status/1"],
    })

    const server = register()
    const result = await server.call("update_draft", { id: created.id, text: "nope" })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("delete_published_draft")
    expect((await store.get(created.id)).status).toBe("publishing")
  })
})
