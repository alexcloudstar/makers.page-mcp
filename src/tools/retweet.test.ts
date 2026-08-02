import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { RetweetDraftStore } from "../retweets/store.js"
import { registerRetweetTools } from "./retweet.js"

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

let dataDir: string
let config: Config

const setup = async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "retweet-tools-data-"))
  config = {
    dataDir,
    retweetDraftsDir: path.join(dataDir, "retweet-drafts"),
    requireApproval: true,
  } as Config
}

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

describe("retweet_post", () => {
  test("retweets an approved draft", async () => {
    await setup()
    const store = new RetweetDraftStore(config)
    const draft = await store.create({ tweetId: "999", action: "retweet" })
    await store.approve(draft.id)

    const retweeted: string[] = []
    const server = new StubServer()
    registerRetweetTools(server as unknown as never, config, {
      store,
      xClient: {
        retweet: async (tweetId: string) => {
          retweeted.push(tweetId)
        },
        undoRetweet: async () => {},
      },
    })

    const result = await server.call("retweet_post", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("Retweeted")
    expect(retweeted).toEqual(["999"])

    const updated = await store.get(draft.id)
    expect(updated.status).toBe("completed")
  })

  test("returns success with warning when markCompleted fails after X retweet", async () => {
    await setup()
    const baseStore = new RetweetDraftStore(config)
    const draft = await baseStore.create({ tweetId: "999", action: "retweet" })
    await baseStore.approve(draft.id)

    const store = Object.assign(Object.create(Object.getPrototypeOf(baseStore)), baseStore, {
      markCompleted: async () => {
        throw new Error("disk full")
      },
    }) as RetweetDraftStore

    const server = new StubServer()
    registerRetweetTools(server as unknown as never, config, {
      store,
      xClient: {
        retweet: async () => {},
        undoRetweet: async () => {},
      },
    })

    const result = await server.call("retweet_post", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("WARNING")
    expect(textOf(result)).toContain("Retweeted")

    const updated = await baseStore.get(draft.id)
    expect(updated.status).toBe("executing")
  })

  test("refuses unapproved draft when approval required", async () => {
    await setup()
    const store = new RetweetDraftStore(config)
    const draft = await store.create({ tweetId: "999", action: "retweet" })

    const server = new StubServer()
    registerRetweetTools(server as unknown as never, config, {
      store,
      xClient: { retweet: async () => {}, undoRetweet: async () => {} },
    })

    const result = await server.call("retweet_post", { id: draft.id })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("approve_retweet_draft")
  })

  test("rejects wrong action type", async () => {
    await setup()
    const store = new RetweetDraftStore(config)
    const draft = await store.create({ tweetId: "999", action: "undo" })
    await store.approve(draft.id)

    const server = new StubServer()
    registerRetweetTools(server as unknown as never, config, {
      store,
      xClient: { retweet: async () => {}, undoRetweet: async () => {} },
    })

    const result = await server.call("retweet_post", { id: draft.id })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('action "undo"')
  })
})

describe("undo_retweet", () => {
  test("undoes an approved draft", async () => {
    await setup()
    const store = new RetweetDraftStore(config)
    const draft = await store.create({ tweetId: "888", action: "undo" })
    await store.approve(draft.id)

    const undone: string[] = []
    const server = new StubServer()
    registerRetweetTools(server as unknown as never, config, {
      store,
      xClient: {
        retweet: async () => {},
        undoRetweet: async (tweetId: string) => {
          undone.push(tweetId)
        },
      },
    })

    const result = await server.call("undo_retweet", { id: draft.id })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("Undo retweet completed")
    expect(undone).toEqual(["888"])
  })
})

describe("create_retweet_draft", () => {
  test("rejects invalid tweet ids", async () => {
    await setup()
    const server = new StubServer()
    registerRetweetTools(server as unknown as never, config, {
      xClient: { retweet: async () => {}, undoRetweet: async () => {} },
    })

    const result = await server.call("create_retweet_draft", {
      tweetId: "not-a-number",
      action: "retweet",
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Invalid tweet id")
  })
})
