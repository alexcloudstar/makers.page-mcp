import { describe, expect, test } from "bun:test"
import { buildSearchQueries } from "./queryBuilder.js"
import type { TrendSourceInput } from "./types.js"

const baseInput = (overrides: Partial<TrendSourceInput> = {}): TrendSourceInput => ({
  niche: "indie hackers",
  keywords: [],
  productDescription: "A tool for founders.",
  targetAudience: "solo founders",
  ...overrides,
})

describe("buildSearchQueries", () => {
  test("returns an empty array when there are no usable terms", () => {
    expect(buildSearchQueries(baseInput({ niche: "  ", keywords: [] }))).toEqual([])
  })

  test("builds a broad query and a demand-signal query for a single niche", () => {
    const queries = buildSearchQueries(baseInput())
    expect(queries.length).toBe(2)
    expect(queries[0]).toContain('"indie hackers"')
    expect(queries[0]).toContain("-is:retweet")
    expect(queries[0]).toContain("-is:reply")
    expect(queries[1]).toContain("looking for")
  })

  test("chunks a large keyword list into multiple broad queries", () => {
    const keywords = Array.from({ length: 12 }, (_, i) => `keyword${i}`)
    const queries = buildSearchQueries(baseInput({ keywords }))
    // 13 total terms (niche + 12 keywords) at 5 per chunk -> 3 broad queries + 1 demand query.
    expect(queries.length).toBe(4)
  })

  test("deduplicates case-insensitive duplicate terms", () => {
    const queries = buildSearchQueries(baseInput({ keywords: ["Indie Hackers", "INDIE HACKERS"] }))
    const broadQuery = queries[0]
    expect(broadQuery.toLowerCase().match(/indie hackers/g)?.length).toBe(1)
  })

  test("appends a lang filter when language is provided", () => {
    const queries = buildSearchQueries(baseInput({ language: "en" }))
    expect(queries.every((query) => query.includes("lang:en"))).toBe(true)
  })

  test("caps query length at 500 characters", () => {
    const keywords = Array.from({ length: 5 }, (_, i) => `a very long keyword phrase number ${i} that takes up space`)
    const queries = buildSearchQueries(baseInput({ keywords }))
    expect(queries.every((query) => query.length <= 500)).toBe(true)
  })
})
