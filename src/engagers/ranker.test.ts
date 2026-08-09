import { describe, expect, test } from "bun:test"
import type { XSearchTweet } from "../channels/x/client.js"
import { rankEngagers } from "./ranker.js"

const reply = (overrides: Partial<XSearchTweet>): XSearchTweet => ({
  id: Math.random().toString(36),
  text: "",
  url: "https://x.com/i/web/status/1",
  createdAt: new Date().toISOString(),
  metrics: { impressionCount: 0, likeCount: 0, replyCount: 0, repostCount: 0, quoteCount: 0, bookmarkCount: 0 },
  authorUsername: "someone",
  ...overrides,
})

describe("rankEngagers", () => {
  test("ranks by comment count, then likes on comments as a tiebreak", () => {
    const { ranked, totalDistinct } = rankEngagers(
      [
        {
          tweets: [
            reply({ authorUsername: "alice", metrics: { impressionCount: 0, likeCount: 1, replyCount: 0, repostCount: 0, quoteCount: 0, bookmarkCount: 0 } }),
            reply({ authorUsername: "bob", metrics: { impressionCount: 0, likeCount: 5, replyCount: 0, repostCount: 0, quoteCount: 0, bookmarkCount: 0 } }),
          ],
        },
        {
          tweets: [
            reply({ authorUsername: "alice", metrics: { impressionCount: 0, likeCount: 2, replyCount: 0, repostCount: 0, quoteCount: 0, bookmarkCount: 0 } }),
          ],
        },
      ],
      10,
    )

    expect(totalDistinct).toBe(2)
    expect(ranked[0]).toMatchObject({ username: "alice", commentCount: 2, likesOnComments: 3 })
    expect(ranked[1]).toMatchObject({ username: "bob", commentCount: 1, likesOnComments: 5 })
  })

  test("ignores replies with no resolved author and respects the limit", () => {
    const { ranked, totalDistinct } = rankEngagers(
      [
        {
          tweets: [
            reply({ authorUsername: undefined }),
            reply({ authorUsername: "a" }),
            reply({ authorUsername: "b" }),
            reply({ authorUsername: "c" }),
          ],
        },
      ],
      2,
    )

    expect(totalDistinct).toBe(3)
    expect(ranked).toHaveLength(2)
  })
})
