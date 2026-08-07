import { describe, expect, test } from "bun:test"
import { extractPainPointSignals } from "./painPoints.js"
import type { RawSignal } from "./types.js"

const signal = (overrides: Partial<RawSignal>): RawSignal => ({
  id: Math.random().toString(36),
  text: "",
  url: "https://x.com/i/web/status/1",
  author: "@founder",
  metrics: { likes: 0, reposts: 0, replies: 0, quotes: 0 },
  source: "x",
  createdAt: new Date().toISOString(),
  ...overrides,
})

describe("extractPainPointSignals", () => {
  test("keeps posts matching demand-signal phrasing", () => {
    const signals = [
      signal({ text: "Looking for a good alternative to Notion for solo founders" }),
      signal({ text: "Just had lunch, nice day out today" }),
    ]
    const result = extractPainPointSignals(signals)
    expect(result.length).toBe(1)
    expect(result[0].text).toContain("Looking for")
  })

  test("ranks matches by engagement, highest first", () => {
    const low = signal({ text: "Anyone know a good tool for this?", metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0 } })
    const high = signal({ text: "Anyone recommend a good tool for indie hackers?", metrics: { likes: 50, reposts: 10, replies: 5, quotes: 2 } })
    const result = extractPainPointSignals([low, high])
    expect(result[0].text).toBe(high.text)
  })

  test("caps the result at 10 entries", () => {
    const signals = Array.from({ length: 15 }, (_, i) =>
      signal({ text: `Looking for a solution number ${i}`, metrics: { likes: i, reposts: 0, replies: 0, quotes: 0 } }),
    )
    const result = extractPainPointSignals(signals)
    expect(result.length).toBe(10)
  })

  test("returns an empty array when nothing matches", () => {
    expect(extractPainPointSignals([signal({ text: "Shipped a new feature today" })])).toEqual([])
  })
})
