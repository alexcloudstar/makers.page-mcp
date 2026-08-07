import type { XClient } from "../channels/x/client.js"
import { buildSearchQueries } from "./queryBuilder.js"
import type { RawSignal, TrendSource, TrendSourceInput } from "./types.js"

const MAX_SIGNALS = 300
const RESULTS_PER_QUERY = 100

export class XTrendSource implements TrendSource {
  readonly name = "x"

  constructor(private readonly xClient: XClient) {}

  async fetchSignals(input: TrendSourceInput): Promise<RawSignal[]> {
    const queries = buildSearchQueries(input)
    if (queries.length === 0) return []

    const results = await Promise.allSettled(
      queries.map((query) => this.xClient.searchRecentTweets(query, { maxResults: RESULTS_PER_QUERY })),
    )

    const allFailed = results.every((result) => result.status === "rejected")
    if (allFailed) {
      const firstRejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      throw firstRejected?.reason
    }

    const seen = new Set<string>()
    const signals: RawSignal[] = []

    outer: for (const result of results) {
      if (result.status !== "fulfilled") continue
      for (const tweet of result.value.tweets) {
        if (seen.has(tweet.id)) continue
        seen.add(tweet.id)
        signals.push({
          id: tweet.id,
          text: tweet.text,
          url: tweet.url,
          createdAt: tweet.createdAt,
          author: tweet.authorUsername ? `@${tweet.authorUsername}` : (tweet.authorId ?? "unknown"),
          metrics: {
            likes: tweet.metrics.likeCount,
            reposts: tweet.metrics.repostCount,
            replies: tweet.metrics.replyCount,
            quotes: tweet.metrics.quoteCount,
            impressions: tweet.metrics.impressionCount,
          },
          source: this.name,
        })
        if (signals.length >= MAX_SIGNALS) break outer
      }
    }

    return signals
  }
}
