import { describe, expect, test } from "bun:test"
import { validateTweetId } from "./retweet-validate.js"

describe("validateTweetId", () => {
  test("accepts numeric ids", () => {
    expect(validateTweetId("2243440580845564842")).toEqual({
      ok: true,
      tweetId: "2243440580845564842",
    })
  })

  test("trims whitespace", () => {
    expect(validateTweetId("  123  ")).toEqual({ ok: true, tweetId: "123" })
  })

  test("rejects non-numeric ids", () => {
    const result = validateTweetId("abc")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Invalid tweet id")
  })
})
