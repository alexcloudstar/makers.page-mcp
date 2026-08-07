import { describe, expect, test } from "bun:test"
import { runSupporterSpotlight } from "./pipeline.js"
import { NoPostsYesterdayError, SpotlightNotFoundError } from "./types.js"
import type { RecentPost, Supporter, SupporterSource, SupporterUser } from "./types.js"

type StoredSpotlight = { date: string; supporters: Supporter[]; generatedPost: string }

class FakeStore {
  private readonly rows = new Map<string, StoredSpotlight>()

  async get(dateKey: string): Promise<StoredSpotlight | undefined> {
    return this.rows.get(dateKey)
  }

  async save(dateKey: string, supporters: Supporter[]): Promise<StoredSpotlight> {
    const existing = this.rows.get(dateKey)
    const row: StoredSpotlight = { date: dateKey, supporters, generatedPost: existing?.generatedPost ?? "" }
    this.rows.set(dateKey, row)
    return row
  }

  async setGeneratedPost(dateKey: string, generatedPost: string): Promise<StoredSpotlight | undefined> {
    const existing = this.rows.get(dateKey)
    if (!existing) return undefined
    const row = { ...existing, generatedPost }
    this.rows.set(dateKey, row)
    return row
  }
}

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

    const result = await runSupporterSpotlight(
      { date: "2026-08-06" },
      { supporterSource: source, store: new FakeStore(), getMe: async () => ME },
    )

    expect(result.supporters).toHaveLength(1)
    expect(result.supporters[0]?.interactions.sort()).toEqual(["like", "reply"])
    expect(result.generatedPost).toBe("")
  })

  test("excludes the authenticated user's own account", async () => {
    const source = fakeSource({
      posts: [{ id: "p1" }],
      likers: { p1: [{ id: "me-1", username: "founder" }, { id: "2", username: "bob" }] },
    })

    const result = await runSupporterSpotlight(
      { date: "2026-08-06" },
      { supporterSource: source, store: new FakeStore(), getMe: async () => ME },
    )

    expect(result.supporters.map((s) => s.id)).toEqual(["2"])
  })

  test("throws NoPostsYesterdayError when there are no posts for the day", async () => {
    const source = fakeSource({ posts: [] })

    await expect(
      runSupporterSpotlight(
        { date: "2026-08-06" },
        { supporterSource: source, store: new FakeStore(), getMe: async () => ME },
      ),
    ).rejects.toBeInstanceOf(NoPostsYesterdayError)
  })

  test("caches supporters and skips the source entirely on a second fetch", async () => {
    let fetchCalls = 0
    const source: SupporterSource = {
      fetchRecentPosts: async () => {
        fetchCalls += 1
        return [{ id: "p1" }]
      },
      fetchLikers: async () => [{ id: "1", username: "alice" }],
      fetchReplyAuthors: async () => [],
    }
    const store = new FakeStore()

    const first = await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, store, getMe: async () => ME })
    const second = await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, store, getMe: async () => ME })

    expect(fetchCalls).toBe(1)
    expect(second.supporters).toEqual(first.supporters)
  })

  test("second call with generatedPost persists it without touching the source", async () => {
    const source: SupporterSource = {
      fetchRecentPosts: async () => [{ id: "p1" }],
      fetchLikers: async () => [{ id: "1", username: "alice" }],
      fetchReplyAuthors: async () => [],
    }
    const store = new FakeStore()

    await runSupporterSpotlight({ date: "2026-08-06" }, { supporterSource: source, store, getMe: async () => ME })
    const result = await runSupporterSpotlight(
      { date: "2026-08-06", generatedPost: "Thanks @alice!" },
      { supporterSource: source, store, getMe: async () => ME },
    )

    expect(result.generatedPost).toBe("Thanks @alice!")
    expect(result.supporters[0]?.username).toBe("alice")
  })

  test("throws SpotlightNotFoundError when generatedPost is set before any fetch", async () => {
    const source = fakeSource({})

    await expect(
      runSupporterSpotlight(
        { date: "2026-08-06", generatedPost: "Thanks!" },
        { supporterSource: source, store: new FakeStore(), getMe: async () => ME },
      ),
    ).rejects.toBeInstanceOf(SpotlightNotFoundError)
  })

  test("never records reposts or quotes as interactions", async () => {
    const source = fakeSource({
      posts: [{ id: "p1" }],
      likers: { p1: [{ id: "1", username: "alice" }] },
      repliers: { p1: [{ id: "2", username: "bob" }] },
    })

    const result = await runSupporterSpotlight(
      { date: "2026-08-06" },
      { supporterSource: source, store: new FakeStore(), getMe: async () => ME },
    )

    for (const supporter of result.supporters) {
      for (const interaction of supporter.interactions) {
        expect(["like", "reply"]).toContain(interaction)
      }
    }
  })
})
