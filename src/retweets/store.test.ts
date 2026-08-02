import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  InvalidRetweetDraftTransitionError,
  RetweetDraftNotFoundError,
  RetweetDraftStore,
} from "./store.js"

let draftsDir: string
let store: RetweetDraftStore

beforeEach(async () => {
  draftsDir = await mkdtemp(path.join(os.tmpdir(), "retweet-drafts-test-"))
  store = new RetweetDraftStore({ retweetDraftsDir: draftsDir })
})

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true })
})

describe("RetweetDraftStore", () => {
  test("create produces a draft in status draft", async () => {
    const draft = await store.create({ tweetId: "1234567890", action: "retweet" })
    expect(draft.status).toBe("draft")
    expect(draft.tweetId).toBe("1234567890")
    expect(draft.action).toBe("retweet")
    expect(draft.tweetUrl).toBe("https://x.com/i/web/status/1234567890")
  })

  test("approve moves draft to approved", async () => {
    const created = await store.create({ tweetId: "123", action: "undo" })
    const approved = await store.approve(created.id)
    expect(approved.status).toBe("approved")
  })

  test("reject allows moving out of executing", async () => {
    const created = await store.create({ tweetId: "123", action: "retweet" })
    await store.beginExecuting(created.id)
    const rejected = await store.reject(created.id)
    expect(rejected.status).toBe("rejected")
  })

  test("reject refuses completed drafts", async () => {
    const created = await store.create({ tweetId: "123", action: "retweet" })
    await store.beginExecuting(created.id)
    await store.markCompleted(created.id)
    await expect(store.reject(created.id)).rejects.toThrow(InvalidRetweetDraftTransitionError)
  })

  test("get rejects malformed ids", async () => {
    await expect(store.get("../../etc/passwd")).rejects.toThrow(RetweetDraftNotFoundError)
  })
})
