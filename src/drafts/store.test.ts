import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DraftNotFoundError, DraftStore, InvalidDraftTransitionError } from "./store.js"

let draftsDir: string
let store: DraftStore

beforeEach(async () => {
  draftsDir = await mkdtemp(path.join(os.tmpdir(), "drafts-test-"))
  store = new DraftStore({ draftsDir })
})

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true })
})

describe("DraftStore", () => {
  test("create produces a draft in status 'draft'", async () => {
    const draft = await store.create({ channel: "x", text: "hello" })
    expect(draft.status).toBe("draft")
    expect(draft.channel).toBe("x")
    expect(draft.text).toBe("hello")
  })

  test("get returns a previously created draft", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    const fetched = await store.get(created.id)
    expect(fetched).toEqual(created)
  })

  test("get rejects ids that aren't well-formed UUIDs (path traversal guard)", async () => {
    await expect(store.get("../../etc/passwd")).rejects.toThrow(DraftNotFoundError)
  })

  test("get throws DraftNotFoundError for an unknown but valid-looking id", async () => {
    await expect(store.get("00000000-0000-0000-0000-000000000000")).rejects.toThrow(DraftNotFoundError)
  })

  test("approve moves a draft from draft -> approved", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    const approved = await store.approve(created.id)
    expect(approved.status).toBe("approved")
  })

  test("approve rejects a non-draft status", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.approve(created.id)
    await expect(store.approve(created.id)).rejects.toThrow(InvalidDraftTransitionError)
  })

  test("reject allows moving out of 'publishing' for manual reconciliation", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)
    const rejected = await store.reject(created.id)
    expect(rejected.status).toBe("rejected")
  })

  test("reject refuses to touch a published draft", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)
    await store.markPublished(created.id, { externalId: "1", url: "https://x.com/i/web/status/1" })
    await expect(store.reject(created.id)).rejects.toThrow(InvalidDraftTransitionError)
  })

  test("updateText resets an approved draft back to 'draft'", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.approve(created.id)
    const updated = await store.updateText(created.id, "hello v2")
    expect(updated.status).toBe("draft")
    expect(updated.text).toBe("hello v2")
  })

  test("updateText resets a draft stuck in 'publishing' back to 'draft'", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)
    const updated = await store.updateText(created.id, "hello v2")
    expect(updated.status).toBe("draft")
  })

  test("updateText does not change the status of a plain draft", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    const updated = await store.updateText(created.id, "hello v2")
    expect(updated.status).toBe("draft")
  })

  test("updateText does not resurrect a published draft out of its terminal status", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)
    await store.markPublished(created.id, { externalId: "1", url: "https://x.com/i/web/status/1" })
    const updated = await store.updateText(created.id, "edited after publish")
    expect(updated.status).toBe("published")
    expect(updated.text).toBe("edited after publish")
  })

  test("full reconciliation round-trip: publishing -> updateText -> draft -> approve -> approved", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.beginPublishing(created.id)

    const backToDraft = await store.updateText(created.id, "hello, reconciled")
    expect(backToDraft.status).toBe("draft")

    const approved = await store.approve(created.id)
    expect(approved.status).toBe("approved")
    expect(approved.text).toBe("hello, reconciled")
  })

  test("beginPublishing then markPublished records the live post", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.approve(created.id)
    await store.beginPublishing(created.id)
    const published = await store.markPublished(created.id, {
      externalId: "123",
      url: "https://x.com/i/web/status/123",
    })
    expect(published.status).toBe("published")
    expect(published.externalId).toBe("123")
    expect(published.publishedAt).toBeDefined()
  })

  test("revertPublishing restores a prior status after a failed publish attempt", async () => {
    const created = await store.create({ channel: "x", text: "hello" })
    await store.approve(created.id)
    await store.beginPublishing(created.id)
    const reverted = await store.revertPublishing(created.id, "approved")
    expect(reverted.status).toBe("approved")
  })

  test("list filters by status and sorts newest first", async () => {
    const first = await store.create({ channel: "x", text: "first" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.create({ channel: "x", text: "second" })
    await store.approve(second.id)

    const drafts = await store.list()
    expect(drafts.map((d) => d.id)).toEqual([second.id, first.id])

    const approvedOnly = await store.list("approved")
    expect(approvedOnly.map((d) => d.id)).toEqual([second.id])
  })
})
