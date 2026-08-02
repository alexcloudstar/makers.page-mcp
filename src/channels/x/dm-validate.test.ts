import { describe, expect, test } from "bun:test"
import type { DmDraft } from "../../dm/types.js"
import { mergeDmDraftFields, validateCreateDmDraftInput, validateDmText } from "./dm-validate.js"

const baseDraft = (): DmDraft => ({
  id: "11111111-1111-1111-1111-111111111111",
  text: "hello",
  status: "draft",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  recipientId: "42",
  recipientUsername: "alice",
  mediaPaths: ["/tmp/pic.png"],
})

describe("mergeDmDraftFields", () => {
  test("keeps current values when update fields are omitted", () => {
    const merged = mergeDmDraftFields(baseDraft(), { text: "updated" })
    expect(merged.text).toBe("updated")
    expect(merged.recipientId).toBe("42")
    expect(merged.recipientUsername).toBe("alice")
    expect(merged.mediaPaths).toEqual(["/tmp/pic.png"])
  })

  test("clears optional fields when update passes null", () => {
    const merged = mergeDmDraftFields(baseDraft(), {
      recipientId: null,
      recipientUsername: null,
      mediaPaths: null,
    })
    expect(merged.recipientId).toBeUndefined()
    expect(merged.recipientUsername).toBeUndefined()
    expect(merged.mediaPaths).toBeUndefined()
  })

  test("normalizes usernames and strips @ prefix", () => {
    const merged = mergeDmDraftFields(baseDraft(), { recipientUsername: "@Bob" })
    expect(merged.recipientUsername).toBe("Bob")
  })

  test("ignores empty username updates and keeps the current value", () => {
    const merged = mergeDmDraftFields(baseDraft(), { recipientUsername: "" })
    expect(merged.recipientUsername).toBe("alice")
  })
})

describe("dm-validate", () => {
  test("rejects empty text", () => {
    expect(validateDmText("   ", 100).ok).toBe(false)
  })

  test("requires a recipient", async () => {
    const result = await validateCreateDmDraftInput({ text: "hi" }, 100)
    expect(result.ok).toBe(false)
  })

  test("accepts username recipient", async () => {
    const result = await validateCreateDmDraftInput(
      { text: "thanks!", recipientUsername: "someone" },
      100,
    )
    expect(result.ok).toBe(true)
  })

  test("rejects more than one media attachment", async () => {
    const result = await validateCreateDmDraftInput(
      {
        text: "hi",
        recipientId: "1",
        mediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      },
      100,
    )
    expect(result.ok).toBe(false)
  })

  test("accepts group participant ids", async () => {
    const result = await validateCreateDmDraftInput(
      { text: "hi all", conversationType: "group", participantIds: ["1", "2"] },
      100,
    )
    expect(result.ok).toBe(true)
  })

  test("rejects group with only recipient fields", async () => {
    const result = await validateCreateDmDraftInput(
      {
        text: "hi",
        conversationType: "group",
        recipientId: "1",
        participantIds: ["1", "2"],
      },
      100,
    )
    expect(result.ok).toBe(false)
  })
})
