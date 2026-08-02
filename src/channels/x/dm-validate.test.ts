import { describe, expect, test } from "bun:test"
import { validateCreateDmDraftInput, validateDmText } from "./dm-validate.js"

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
})
