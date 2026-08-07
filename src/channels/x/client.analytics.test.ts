import { afterEach, describe, expect, test } from "bun:test"
import type { Config } from "../../config.js"
import { XClient } from "./client.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const config = {
  configDir: "/tmp/makers-page-mcp-test-config",
  dataDir: "/tmp/makers-page-mcp-test-data",
  draftsDir: "/tmp/makers-page-mcp-test-drafts",
  dmDraftsDir: "/tmp/makers-page-mcp-test-dm-drafts",
  retweetDraftsDir: "/tmp/makers-page-mcp-test-retweet-drafts",
  credentialsPath: "/tmp/makers-page-mcp-test-config/credentials.json",
  requireApproval: true,
  maxPostLength: 280,
  maxDmLength: 10_000,
  dmRateLimit: { maxPerHour: 10, maxPerDay: 50, minIntervalMs: 0 },
  x: {
    clientId: "test",
    clientSecret: undefined,
    redirectUri: "http://127.0.0.1:8879/callback",
  },
} satisfies Config

const withMockedAuth = (client: XClient) => {
  Object.defineProperty(client, "getAccessToken", {
    value: async () => "test-token",
  })
  return client
}

describe("XClient analytics", () => {
  test("getTweetsByIds requests tweet.fields public_metrics", async () => {
    let url = ""
    globalThis.fetch = (async (input) => {
      url = String(input)
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "10",
              text: "hello",
              created_at: "2026-08-02T10:00:00.000Z",
              public_metrics: {
                impression_count: 42,
                like_count: 3,
                reply_count: 1,
                retweet_count: 2,
                quote_count: 0,
                bookmark_count: 1,
              },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const posts = await client.getTweetsByIds(["10"])
    expect(url).toContain("/2/tweets?ids=10")
    expect(url).toContain("tweet.fields=created_at,text,public_metrics")
    expect(posts[0]?.metrics.impressionCount).toBe(42)
  })

  test("getPostsAnalytics calls /2/tweets/analytics", async () => {
    let url = ""
    globalThis.fetch = (async (input) => {
      url = String(input)
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "10",
              timestamped_metrics: [
                {
                  timestamp: "2026-08-02T10:00:00.000Z",
                  metrics: {
                    impressions: 42,
                    engagements: 5,
                    likes: 3,
                    retweets: 1,
                    replies: 1,
                    quote_tweets: 0,
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const rows = await client.getPostsAnalytics(
      ["10"],
      "2026-08-02T00:00:00.000Z",
      "2026-08-02T23:59:59.000Z",
      "total",
    )
    expect(url).toContain("/2/tweets/analytics")
    expect(url).not.toContain("analytics.fields")
    expect(url).toContain("granularity=total")
    expect(rows[0]?.timestampedMetrics[0]?.metrics.impressions).toBe(42)
  })

  test("listUserTweetsInRange paginates until maxPosts reached", async () => {
    let calls = 0
    globalThis.fetch = (async (input) => {
      calls += 1
      const url = String(input)
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1",
                text: "a",
                created_at: "2026-08-02T10:00:00.000Z",
                public_metrics: { impression_count: 1 },
              },
            ],
            meta: { next_token: "token-2" },
          }),
          { status: 200 },
        )
      }
      expect(url).toContain("pagination_token=token-2")
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "2",
              text: "b",
              created_at: "2026-08-02T11:00:00.000Z",
              public_metrics: { impression_count: 2 },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const posts = await client.listUserTweetsInRange(
      "42",
      "2026-08-01T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      2,
    )
    expect(calls).toBe(2)
    expect(posts.map((item) => item.id)).toEqual(["1", "2"])
  })

  test("getPostsAnalytics accepts total buckets without timestamps", async () => {
    globalThis.fetch = (async (input) => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "10",
              timestamped_metrics: [
                { metrics: { impressions: 42, likes: 3, retweets: 1, replies: 1 } },
              ],
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const rows = await client.getPostsAnalytics(
      ["10"],
      "2026-08-02T00:00:00.000Z",
      "2026-08-02T23:59:59.000Z",
      "total",
    )
    expect(rows[0]?.timestampedMetrics[0]?.metrics.impressions).toBe(42)
  })

  test("getLikingUsers requests liking_users and maps user fields", async () => {
    let url = ""
    globalThis.fetch = (async (input) => {
      url = String(input)
      return new Response(
        JSON.stringify({
          data: [
            { id: "1", username: "alice", name: "Alice" },
            { id: "2", username: "bob" },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const users = await client.getLikingUsers("10", 50)
    expect(url).toContain("/2/tweets/10/liking_users")
    expect(url).toContain("max_results=50")
    expect(users).toEqual([
      { id: "1", username: "alice", name: "Alice" },
      { id: "2", username: "bob", name: "bob" },
    ])
  })

})
