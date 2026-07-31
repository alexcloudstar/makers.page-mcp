import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_MAX_POST_LENGTH, resolveMaxPostLength } from "./config.js"

const ENV_KEY = "MAKERS_PAGE_MAX_POST_LENGTH"
let original: string | undefined

beforeEach(() => {
  original = process.env[ENV_KEY]
})

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = original
})

describe("resolveMaxPostLength", () => {
  test("defaults when the env var is unset", () => {
    delete process.env[ENV_KEY]
    expect(resolveMaxPostLength()).toBe(DEFAULT_MAX_POST_LENGTH)
  })

  test("uses a valid positive integer as-is", () => {
    process.env[ENV_KEY] = "500"
    expect(resolveMaxPostLength()).toBe(500)
  })

  test("falls back to the default for a non-numeric string", () => {
    process.env[ENV_KEY] = "abc"
    expect(resolveMaxPostLength()).toBe(DEFAULT_MAX_POST_LENGTH)
  })

  test("falls back to the default for a negative number", () => {
    process.env[ENV_KEY] = "-5"
    expect(resolveMaxPostLength()).toBe(DEFAULT_MAX_POST_LENGTH)
  })

  test("falls back to the default for zero", () => {
    process.env[ENV_KEY] = "0"
    expect(resolveMaxPostLength()).toBe(DEFAULT_MAX_POST_LENGTH)
  })

  test("falls back to the default for Infinity", () => {
    process.env[ENV_KEY] = "Infinity"
    expect(resolveMaxPostLength()).toBe(DEFAULT_MAX_POST_LENGTH)
  })

  test("falls back to the default for a whitespace-only string", () => {
    // Number(" ") is 0, a distinct code path from a truly non-numeric string.
    process.env[ENV_KEY] = "   "
    expect(resolveMaxPostLength()).toBe(DEFAULT_MAX_POST_LENGTH)
  })

  test("floors a non-integer value instead of rejecting it", () => {
    process.env[ENV_KEY] = "280.9"
    expect(resolveMaxPostLength()).toBe(280)
  })
})
