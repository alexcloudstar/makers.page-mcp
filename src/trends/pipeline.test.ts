import { describe, expect, test } from "bun:test"
import type { XClient } from "../channels/x/client.js"
import { runTrendPipeline } from "./pipeline.js"
import { NoSignalsError } from "./types.js"
import type { RawSignal, TrendSource, TrendSourceInput } from "./types.js"

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

const fakeSource = (signals: RawSignal[]): TrendSource => ({
  name: "fake",
  fetchSignals: async () => signals,
})

const baseInput: TrendSourceInput = {
  niche: "indie hackers",
  keywords: [],
  productDescription: "A tool for founders.",
  targetAudience: "solo founders",
}

const dummyXClient = {} as unknown as XClient

describe("runTrendPipeline", () => {
  test("assembles the full response shape from collected signals", async () => {
    const buildInPublicPosts = [
      "Shipping in public today, #BuildInPublic is such a good habit",
      "Just hit 100 users thanks to #BuildInPublic accountability",
      "Loving the #BuildInPublic community lately, so much energy",
    ]
    const signals = [
      ...buildInPublicPosts.map((text) =>
        signal({ text, metrics: { likes: 10, reposts: 2, replies: 1, quotes: 0 } }),
      ),
      signal({ text: "Looking for a good alternative to spreadsheets" }),
    ]

    const result = await runTrendPipeline(baseInput, {
      trendSources: [fakeSource(signals)],
      xClient: dummyXClient,
      annotateGlobalTrends: false,
    })

    expect(result.query.niche).toBe("indie hackers")
    expect(result.query.searchQueriesUsed.length).toBeGreaterThan(0)
    expect(result.trendingTopics.length).toBeGreaterThan(0)
    expect(result.trendingTopics[0]!.topic).toBe("#BuildInPublic")
    expect(result.painPointSignals.length).toBe(1)
    expect(result.recommendation.urgency).toBeDefined()
  })

  test("merges signals from multiple trend sources", async () => {
    const sourceA = fakeSource(
      ["Shipping #SourceA news today", "Excited about #SourceA progress"].map((text) => signal({ text })),
    )
    const sourceB = fakeSource(
      ["Just discovered #SourceB works great", "Anyone else using #SourceB daily"].map((text) => signal({ text })),
    )

    const result = await runTrendPipeline(baseInput, {
      trendSources: [sourceA, sourceB],
      xClient: dummyXClient,
      annotateGlobalTrends: false,
    })

    const topics = result.trendingTopics.map((topic) => topic.topic)
    expect(topics).toContain("#SourceA")
    expect(topics).toContain("#SourceB")
  })

  test("throws NoSignalsError when nothing survives spam/dedup filtering", async () => {
    const spamOnly = fakeSource([signal({ text: "RT to win a free giveaway now" })])

    await expect(
      runTrendPipeline(baseInput, { trendSources: [spamOnly], xClient: dummyXClient, annotateGlobalTrends: false }),
    ).rejects.toBeInstanceOf(NoSignalsError)
  })

  test("throws NoSignalsError when the trend source returns nothing", async () => {
    await expect(
      runTrendPipeline(baseInput, { trendSources: [fakeSource([])], xClient: dummyXClient, annotateGlobalTrends: false }),
    ).rejects.toBeInstanceOf(NoSignalsError)
  })

  test("annotates topics using global trends when enabled", async () => {
    const signals = ["Everyone is talking about #GlobalHit right now", "Can't believe how big #GlobalHit got"].map(
      (text) => signal({ text }),
    )
    const stubXClient = {
      getTrendsByWoeid: async () => [{ name: "#GlobalHit" }],
    } as unknown as XClient

    const result = await runTrendPipeline(baseInput, {
      trendSources: [fakeSource(signals)],
      xClient: stubXClient,
    })

    expect(result.trendingTopics[0]!.alsoTrendingGlobally).toBe(true)
  })
})
