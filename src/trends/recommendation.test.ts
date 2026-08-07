import { describe, expect, test } from "bun:test"
import { classifyMomentum } from "./recommendation.js"
import type { TrendingTopic } from "./types.js"

const topic = (overrides: Partial<TrendingTopic>): TrendingTopic => ({
  topic: "#Test",
  score: 50,
  growth: "stable",
  confidence: 50,
  tweetCount: 5,
  alsoTrendingGlobally: false,
  sampleTweets: [],
  ...overrides,
})

describe("classifyMomentum", () => {
  test("returns later with no urgent reason when there are no topics", () => {
    const result = classifyMomentum([])
    expect(result.urgency).toBe("later")
  })

  test("returns post_now for an exploding, high-confidence top topic", () => {
    const result = classifyMomentum([topic({ growth: "exploding", confidence: 80 })])
    expect(result.urgency).toBe("post_now")
  })

  test("does not treat a low-confidence exploding topic as post_now", () => {
    const result = classifyMomentum([topic({ growth: "exploding", confidence: 20 })])
    expect(result.urgency).toBe("today")
  })

  test("returns today for a rising top topic", () => {
    const result = classifyMomentum([topic({ growth: "rising" })])
    expect(result.urgency).toBe("today")
  })

  test("returns later for a stable or fading top topic", () => {
    expect(classifyMomentum([topic({ growth: "stable" })]).urgency).toBe("later")
    expect(classifyMomentum([topic({ growth: "fading" })]).urgency).toBe("later")
  })

  test("reason references the top topic name", () => {
    const result = classifyMomentum([topic({ topic: "#ClaudeCode", growth: "rising" })])
    expect(result.reason).toContain("#ClaudeCode")
  })
})
