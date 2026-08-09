import { describe, expect, test } from "bun:test"
import type { XClient, XSearchTweet } from "../channels/x/client.js"
import { getTopEngagers } from "./pipeline.js"
import { NoTopLevelPostsError } from "./types.js"

const zeroMetrics = { impressionCount: 0, likeCount: 0, replyCount: 0, repostCount: 0, quoteCount: 0, bookmarkCount: 0 }

const reply = (overrides: Partial<XSearchTweet>): XSearchTweet => ({
  id: Math.random().toString(36),
  text: "",
  url: "https://x.com/i/web/status/1",
  createdAt: new Date().toISOString(),
  metrics: zeroMetrics,
  ...overrides,
})

describe("getTopEngagers", () => {
  test("checks every top-level post for the day and ranks commenters across all of them", async () => {
    const repliesByConversation: Record<string, XSearchTweet[]> = {
      "post-1": [
        reply({ authorUsername: "alice", metrics: { ...zeroMetrics, likeCount: 1 } }),
        reply({ authorUsername: "bob", metrics: { ...zeroMetrics, likeCount: 5 } }),
      ],
      "post-2": [reply({ authorUsername: "alice", metrics: { ...zeroMetrics, likeCount: 2 } })],
    }

    const fakeXClient = {
      getMe: async () => ({ id: "me-1", username: "me", name: "Me" }),
      listTopLevelUserPostsInRange: async () => [
        { id: "post-1", text: "First post", url: "https://x.com/i/web/status/post-1", createdAt: new Date().toISOString(), metrics: zeroMetrics },
        { id: "post-2", text: "Second post", url: "https://x.com/i/web/status/post-2", createdAt: new Date().toISOString(), metrics: zeroMetrics },
      ],
      searchRecentTweets: async (query: string) => {
        const conversationId = query.match(/conversation_id:(\S+)/)?.[1]
        return { tweets: repliesByConversation[conversationId ?? ""] ?? [] }
      },
    } as unknown as XClient

    const result = await getTopEngagers({ date: "2026-08-07", timezone: "UTC" }, { xClient: fakeXClient })

    expect(result.postsChecked).toHaveLength(2)
    expect(result.totalDistinctCommenters).toBe(2)
    expect(result.topEngagers[0]).toMatchObject({ username: "alice", commentCount: 2, likesOnComments: 3 })
    expect(result.topEngagers[1]).toMatchObject({ username: "bob", commentCount: 1, likesOnComments: 5 })
    expect(result.notes).toHaveLength(0)
  })

  test("throws NoTopLevelPostsError when nothing was posted that day", async () => {
    const fakeXClient = {
      getMe: async () => ({ id: "me-1", username: "me", name: "Me" }),
      listTopLevelUserPostsInRange: async () => [],
    } as unknown as XClient

    await expect(
      getTopEngagers({ date: "2026-08-07", timezone: "UTC" }, { xClient: fakeXClient }),
    ).rejects.toBeInstanceOf(NoTopLevelPostsError)
  })

  test("warns when the requested date is outside Recent Search's 7-day window", async () => {
    const fakeXClient = {
      getMe: async () => ({ id: "me-1", username: "me", name: "Me" }),
      listTopLevelUserPostsInRange: async () => [
        { id: "post-1", text: "Old post", url: "https://x.com/i/web/status/post-1", createdAt: "2020-01-01T00:00:00Z", metrics: zeroMetrics },
      ],
      searchRecentTweets: async () => ({ tweets: [] }),
    } as unknown as XClient

    const result = await getTopEngagers({ date: "2020-01-01", timezone: "UTC" }, { xClient: fakeXClient })
    expect(result.notes[0]).toContain("Recent Search")
  })

  test("defaults to yesterday when no date is given", async () => {
    let requestedRange: { start: string; end: string } | undefined
    const fakeXClient = {
      getMe: async () => ({ id: "me-1", username: "me", name: "Me" }),
      listTopLevelUserPostsInRange: async (_userId: string, start: string, end: string) => {
        requestedRange = { start, end }
        return []
      },
    } as unknown as XClient

    await expect(
      getTopEngagers({ timezone: "UTC" }, { xClient: fakeXClient }),
    ).rejects.toBeInstanceOf(NoTopLevelPostsError)

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(requestedRange?.start.slice(0, 10)).toBe(yesterday)
  })
})
