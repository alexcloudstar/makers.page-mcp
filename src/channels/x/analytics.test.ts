import { describe, expect, test } from "bun:test"
import {
  aggregateTweetAnalytics,
  analyzePostingTimes,
  buildAccountSummaryFromAnalytics,
  getDayBoundsUtc,
} from "./analytics.js"
import type { XTweetAnalytics, XTweetWithMetrics } from "./analytics.js"

const post = (
  id: string,
  createdAt: string,
  impressions: number,
): XTweetWithMetrics => ({
  id,
  text: `post ${id}`,
  createdAt,
  url: `https://x.com/i/web/status/${id}`,
  metrics: {
    impressionCount: impressions,
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    quoteCount: 0,
    bookmarkCount: 0,
  },
})

describe("analytics window aggregation", () => {
  test("aggregateTweetAnalytics sums buckets in calendar day", () => {
    const analytics: XTweetAnalytics[] = [
      {
        id: "1",
        timestampedMetrics: [
          {
            timestamp: "2026-08-02T08:00:00.000Z",
            metrics: { impressions: 100, engagements: 10, likes: 5, reposts: 1, replies: 2, quotes: 0 },
          },
          {
            timestamp: "2026-08-01T08:00:00.000Z",
            metrics: { impressions: 999, engagements: 1, likes: 1, reposts: 0, replies: 0, quotes: 0 },
          },
        ],
      },
    ]

    const { start, end, dateKey } = getDayBoundsUtc(new Date("2026-08-02T12:00:00.000Z"), "UTC")
    const { totals } = aggregateTweetAnalytics(analytics, start, end, "UTC", dateKey)
    expect(totals.impressions).toBe(100)
    expect(totals.engagements).toBe(10)
  })

  test("buildAccountSummaryFromAnalytics uses analytics totals", () => {
    const reference = new Date("2026-08-02T15:00:00.000Z")
    const analytics: XTweetAnalytics[] = [
      {
        id: "2",
        timestampedMetrics: [
          {
            timestamp: "2026-08-02T10:00:00.000Z",
            metrics: { impressions: 500, engagements: 20, likes: 10, reposts: 2, replies: 3, quotes: 0 },
          },
        ],
      },
    ]

    const summary = buildAccountSummaryFromAnalytics({
      account: { id: "u1", username: "me" },
      posts: [post("2", "2026-08-02T10:00:00.000Z", 9999)],
      analytics,
      days: 1,
      timezone: "UTC",
      topLimit: 1,
      referenceDate: reference,
    })

    expect(summary.metricSource).toBe("tweet_analytics_api")
    expect(summary.today.impressions).toBe(500)
    expect(summary.topPosts[0]?.windowMetrics.impressions).toBe(500)
  })

  test("analyzePostingTimes picks best hours with minimum sample size", () => {
    const posts = [
      post("1", "2026-08-01T09:00:00.000Z", 100),
      post("2", "2026-08-02T09:00:00.000Z", 120),
      post("3", "2026-08-01T15:00:00.000Z", 400),
      post("4", "2026-08-02T15:00:00.000Z", 500),
    ]
    const analysis = analyzePostingTimes(posts, 30, "UTC", 2)
    expect(analysis.bestHoursByImpressions[0]?.hour).toBe(15)
  })
})
