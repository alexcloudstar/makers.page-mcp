import { describe, expect, test } from "bun:test"
import { runSupporterSpotlight } from "./pipeline.js"
import { NoPostsYesterdayError } from "./types.js"
import type { RecentPost, SupporterSource, SupporterUser } from "./types.js"

const fakeSource = (overrides: {
  posts?: RecentPost[]
  likers?: Record<string, SupporterUser[]>
  repliers?: Record<string, SupporterUser[]>
}): SupporterSource => ({
  fetchRecentPosts: async () => overrides.posts ?? [],
  fetchLikers: async (postId) => overrides.likers?.[postId] ?? [],
  fetchReplyAuthors: async (postId) => overrides.repliers?.[postId] ?? [],
})

const ME = { id: "me-1" }

describe("runSupporterSpotlight", () => {
  test("dedupes a supporter who both liked and replied", async () => {
    const source = fakeSource({
      posts: [{ id: "p1" }],
      likers: { p1: [{ id: "1", username: "alice" }] },
      repliers: { p1: [{ id: "1", username: "alice" }] },
    })

    const result = await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, getMe: async () => ME })

    expect(result.supporters).toHaveLength(1)
    expect(result.supporters[0]?.interactions.sort()).toEqual(["like", "reply"])
  })

  test("excludes the authenticated user's own account", async () => {
    const source = fakeSource({
      posts: [{ id: "p1" }],
      likers: { p1: [{ id: "me-1", username: "founder" }, { id: "2", username: "bob" }] },
    })

    const result = await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, getMe: async () => ME })

    expect(result.supporters.map((s) => s.id)).toEqual(["2"])
  })

  test("throws NoPostsYesterdayError when there are no posts for the day", async () => {
    const source = fakeSource({ posts: [] })

    await expect(
      runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, getMe: async () => ME }),
    ).rejects.toBeInstanceOf(NoPostsYesterdayError)
  })

  test("fetches from the source on every call (no caching)", async () => {
    let fetchCalls = 0
    const source: SupporterSource = {
      fetchRecentPosts: async () => {
        fetchCalls += 1
        return [{ id: "p1" }]
      },
      fetchLikers: async () => [{ id: "1", username: "alice" }],
      fetchReplyAuthors: async () => [],
    }

    await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, getMe: async () => ME })
    await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, getMe: async () => ME })

    expect(fetchCalls).toBe(2)
  })

  test("never records reposts or quotes as interactions", async () => {
    const source = fakeSource({
      posts: [{ id: "p1" }],
      likers: { p1: [{ id: "1", username: "alice" }] },
      repliers: { p1: [{ id: "2", username: "bob" }] },
    })

    const result = await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, getMe: async () => ME })

    for (const supporter of result.supporters) {
      for (const interaction of supporter.interactions) {
        expect(["like", "reply"]).toContain(interaction)
      }
    }
  })
})
