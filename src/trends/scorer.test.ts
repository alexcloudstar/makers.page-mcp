import { describe, expect, test } from "bun:test"
import { scoreTrends } from "./scorer.js"
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

describe("scoreTrends", () => {
  test("ranks a higher-engagement, higher-frequency topic above a low-engagement one", () => {
    const now = new Date()
    const popular = Array.from({ length: 4 }, () =>
      signal({ text: "#PopularTool", metrics: { likes: 10, reposts: 0, replies: 0, quotes: 0 }, createdAt: now.toISOString() }),
    )
    const rare = Array.from({ length: 2 }, () =>
      signal({ text: "#RareThing", metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0 }, createdAt: now.toISOString() }),
    )

    const topics = scoreTrends([...popular, ...rare], now)

    expect(topics.length).toBe(2)
    expect(topics[0]!.topic).toBe("#PopularTool")
    expect(topics[0]!.score).toBe(90)
    expect(topics[0]!.tweetCount).toBe(4)
    expect(topics[0]!.confidence).toBe(80)
    expect(topics[0]!.growth).toBe("exploding")
    expect(topics[1]!.topic).toBe("#RareThing")
    expect(topics[1]!.score).toBe(10)
    expect(topics[1]!.growth).toBe("fading")
  })

  test("weights recent engagement higher than older engagement (same frequency and totals)", () => {
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const recent = Array.from({ length: 2 }, () =>
      signal({ text: "#TopicA", metrics: { likes: 10, reposts: 0, replies: 0, quotes: 0 }, createdAt: now.toISOString() }),
    )
    const old = Array.from({ length: 2 }, () =>
      signal({ text: "#TopicB", metrics: { likes: 10, reposts: 0, replies: 0, quotes: 0 }, createdAt: dayAgo.toISOString() }),
    )

    const topics = scoreTrends([...recent, ...old], now)

    expect(topics[0]!.topic).toBe("#TopicA")
    expect(topics[0]!.score).toBe(100)
    expect(topics[0]!.growth).toBe("exploding")
    expect(topics[1]!.topic).toBe("#TopicB")
    expect(topics[1]!.score).toBe(70)
    expect(topics[1]!.growth).toBe("fading")
  })

  test("excludes topics mentioned only once", () => {
    const now = new Date()
    const oneOff = signal({ text: "#OnlyOnce", metrics: { likes: 1000, reposts: 0, replies: 0, quotes: 0 } })
    const recurring = Array.from({ length: 2 }, () => signal({ text: "#Recurring" }))

    const topics = scoreTrends([oneOff, ...recurring], now)

    expect(topics.some((topic) => topic.topic === "#OnlyOnce")).toBe(false)
    expect(topics.some((topic) => topic.topic === "#Recurring")).toBe(true)
  })

  test("returns an empty array when no signals are given", () => {
    expect(scoreTrends([], new Date())).toEqual([])
  })

  test("sets alsoTrendingGlobally to false by default", () => {
    const topics = scoreTrends(
      Array.from({ length: 2 }, () => signal({ text: "#SomeTopic" })),
      new Date(),
    )
    expect(topics[0]!.alsoTrendingGlobally).toBe(false)
  })
})
