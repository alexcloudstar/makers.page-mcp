import { describe, expect, test } from "bun:test"
import { resolveTargetDay } from "./dateRange.js"

describe("resolveTargetDay", () => {
  test("defaults to the previous UTC calendar day", () => {
    const reference = new Date("2026-08-07T15:30:00.000Z")
    const range = resolveTargetDay(undefined, reference)
    expect(range.dateKey).toBe("2026-08-06")
    expect(range.startIso).toBe("2026-08-06T00:00:00.000Z")
    expect(range.endIso).toBe("2026-08-07T00:00:00.000Z")
  })

  test("resolves an explicit YYYY-MM-DD date to its full UTC range", () => {
    const range = resolveTargetDay("2026-01-15")
    expect(range).toEqual({
      dateKey: "2026-01-15",
      startIso: "2026-01-15T00:00:00.000Z",
      endIso: "2026-01-16T00:00:00.000Z",
    })
  })

  test("rejects a malformed date string", () => {
    expect(() => resolveTargetDay("08/06/2026")).toThrow()
  })
})
