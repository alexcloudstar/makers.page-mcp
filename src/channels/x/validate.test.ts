import { describe, expect, test } from "bun:test"
import { validateXPostText, weightedLength } from "./validate.js"

describe("weightedLength", () => {
  test("counts plain ASCII text by code point", () => {
    expect(weightedLength("hello world")).toBe(11)
  })

  test("counts surrogate-pair emoji as a single unit, unlike string.length", () => {
    const emoji = "🚀"
    expect(emoji.length).toBe(2) // UTF-16 code units
    expect(weightedLength(emoji)).toBe(1)
  })

  test("weights each URL as 23 regardless of its real length", () => {
    const url = "https://example.com/a/very/long/path/that/is/definitely/over/23/chars"
    expect(weightedLength(url)).toBe(23)
  })

  test("combines plain text and URL weighting", () => {
    const text = "check this out https://example.com/x"
    const withoutUrl = "check this out "
    expect(weightedLength(text)).toBe(withoutUrl.length + 23)
  })

  test("handles multiple URLs", () => {
    const text = "https://a.com https://b.com"
    expect(weightedLength(text)).toBe(1 /* space between */ + 23 * 2)
  })

  test("counts trailing sentence punctuation after a URL as plain text, not part of the link", () => {
    const text = "See https://example.com/foo. Thanks"
    const withoutUrl = "See . Thanks"
    expect(weightedLength(text)).toBe([...withoutUrl].length + TCO_WEIGHT_FOR_TEST)
  })

  test("counts a trailing closing paren after a URL as plain text", () => {
    const text = "(https://example.com/foo)"
    const withoutUrl = "()"
    expect(weightedLength(text)).toBe([...withoutUrl].length + TCO_WEIGHT_FOR_TEST)
  })

  test("handles a URL with a query string", () => {
    const text = "go to https://example.com/search?q=a&b=1"
    const withoutUrl = "go to "
    expect(weightedLength(text)).toBe([...withoutUrl].length + TCO_WEIGHT_FOR_TEST)
  })
})

// Mirrors the internal TCO_WEIGHT constant; kept local since it isn't exported.
const TCO_WEIGHT_FOR_TEST = 23

describe("validateXPostText", () => {
  test("rejects empty text", () => {
    const result = validateXPostText("   ", 280)
    expect(result.ok).toBe(false)
  })

  test("accepts text within the limit", () => {
    const result = validateXPostText("hello world", 280)
    expect(result).toEqual({ ok: true })
  })

  test("rejects text over the weighted limit", () => {
    const result = validateXPostText("a".repeat(281), 280)
    expect(result.ok).toBe(false)
  })

  test("a long URL does not push a short post over the limit", () => {
    const text = `check this out https://example.com/${"a".repeat(200)}`
    const result = validateXPostText(text, 280)
    expect(result).toEqual({ ok: true })
  })

  test("emoji-heavy text is not overcounted", () => {
    const text = "🚀".repeat(100)
    // 100 code points, well under 280, even though string.length would be 200.
    const result = validateXPostText(text, 280)
    expect(result).toEqual({ ok: true })
  })

  test("accepts text exactly at the limit", () => {
    const result = validateXPostText("a".repeat(280), 280)
    expect(result).toEqual({ ok: true })
  })

  test("rejects text one character over the limit", () => {
    const result = validateXPostText("a".repeat(281), 280)
    expect(result.ok).toBe(false)
  })
})
