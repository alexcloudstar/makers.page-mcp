import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config } from "../../config.js"
import { MINIMAL_MP4, MINIMAL_PNG } from "../../test-helpers/media-fixtures.js"
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
  dmRateLimit: { maxPerHour: 10, maxPerDay: 50, minIntervalMs: 3000 },
  x: {
    clientId: "test",
    clientSecret: undefined,
    redirectUri: "http://127.0.0.1:8879/callback",
  },
} satisfies Config

const withMockedAuth = (client: XClient) => {
  // Bypass OAuth by stubbing the private access-token path via prototype.
  Object.defineProperty(client, "getAccessToken", {
    value: async () => "test-token",
  })
  return client
}

describe("XClient.createTweet payloads", () => {
  test("sends quote, community, paid_partnership, and edit_options fields", async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ data: { id: "1", text: "hi" } }), { status: 200 })
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await client.createTweet({
      text: "hi",
      quoteTweetId: "99",
      communityId: "c1",
      shareWithFollowers: true,
      paidPartnership: true,
      editPreviousPostId: "88",
    })

    expect(capturedBody).toEqual({
      text: "hi",
      quote_tweet_id: "99",
      community_id: "c1",
      share_with_followers: true,
      paid_partnership: true,
      edit_options: { previous_post_id: "88" },
    })
  })

  test("sends poll, media, and reply fields", async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ data: { id: "2", text: "poll" } }), { status: 200 })
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await client.createTweet({
      text: "poll",
      replyToId: "1",
      mediaIds: ["m1", "m2"],
      poll: { options: ["yes", "no"], durationMinutes: 60 },
    })

    expect(capturedBody).toEqual({
      text: "poll",
      reply: { in_reply_to_tweet_id: "1" },
      media: { media_ids: ["m1", "m2"] },
      poll: { options: ["yes", "no"], duration_minutes: 60 },
    })
  })
})

describe("XClient.createTweet response validation", () => {
  test("throws a plain Error when the 200 body is missing data.id", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await expect(client.createTweet({ text: "hi" })).rejects.toThrow(
      "X API create tweet response was missing data.id/text",
    )
  })
})

describe("XClient.deleteTweet", () => {
  test("issues DELETE /2/tweets/:id", async () => {
    let method: string | undefined
    let url: string | undefined
    globalThis.fetch = (async (input, init) => {
      url = String(input)
      method = init?.method
      return new Response(JSON.stringify({ data: { deleted: true } }), { status: 200 })
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await client.deleteTweet("42")
    expect(method).toBe("DELETE")
    expect(url).toBe("https://api.x.com/2/tweets/42")
  })

  test("throws when the API returns deleted: false", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { deleted: false } }), { status: 200 })) as unknown as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await expect(client.deleteTweet("42")).rejects.toMatchObject({
      name: "XApiError",
      message: expect.stringContaining("did not confirm deletion"),
    })
  })
})

describe("XClient.uploadMedia", () => {
  test("simple upload for images posts multipart to /2/media/upload", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      expect(url).toBe("https://api.x.com/2/media/upload")
      const form = init?.body as FormData
      expect(String(form.get("media_category"))).toBe("tweet_image")
      expect(form.get("media")).toBeTruthy()
      return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 })
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-"))
    try {
      const filePath = path.join(dir, "pic.png")
      await writeFile(filePath, MINIMAL_PNG)
      const client = withMockedAuth(new XClient(config))
      const mediaId = await client.uploadMedia(filePath)
      expect(mediaId).toBe("media-1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("chunked upload for videos runs initialize, append, finalize without STATUS when processing_info is absent", async () => {
    const commands: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes("command=STATUS")) {
        throw new Error("STATUS should not be called")
      }
      if (url.endsWith("/2/media/upload/initialize")) {
        commands.push("INIT")
        return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 })
      }
      if (url.includes("/append")) {
        commands.push("APPEND")
        return new Response(JSON.stringify({ data: { expires_at: 1 } }), { status: 200 })
      }
      if (url.includes("/finalize")) {
        commands.push("FINALIZE")
        return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 })
      }
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-"))
    try {
      const filePath = path.join(dir, "clip.mp4")
      await writeFile(filePath, MINIMAL_MP4)
      const client = withMockedAuth(new XClient(config))
      const mediaId = await client.uploadMedia(filePath)
      expect(mediaId).toBe("media-1")
      expect(commands).toEqual(["INIT", "APPEND", "FINALIZE"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("polls STATUS until processing succeeds", async () => {
    let statusCalls = 0
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes("command=STATUS")) {
        statusCalls += 1
        if (statusCalls === 1) {
          return new Response(
            JSON.stringify({
              data: {
                id: "media-2",
                processing_info: { state: "in_progress", check_after_secs: 0 },
              },
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            data: {
              id: "media-2",
              processing_info: { state: "succeeded" },
            },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith("/2/media/upload/initialize")) {
        return new Response(JSON.stringify({ data: { id: "media-2" } }), { status: 200 })
      }
      if (url.includes("/append")) {
        return new Response(JSON.stringify({ data: { expires_at: 1 } }), { status: 200 })
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "media-2",
              processing_info: { state: "pending", check_after_secs: 0 },
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-status-"))
    try {
      const filePath = path.join(dir, "clip.mp4")
      await writeFile(filePath, MINIMAL_MP4)
      const client = withMockedAuth(new XClient(config))
      const mediaId = await client.uploadMedia(filePath)
      expect(mediaId).toBe("media-2")
      expect(statusCalls).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("throws when STATUS reports failed processing", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/2/media/upload/initialize")) {
        return new Response(JSON.stringify({ data: { id: "media-3" } }), { status: 200 })
      }
      if (url.includes("/append")) {
        return new Response(JSON.stringify({ data: { expires_at: 1 } }), { status: 200 })
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "media-3",
              processing_info: {
                state: "failed",
                error: { message: "invalid media" },
              },
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-fail-"))
    try {
      const filePath = path.join(dir, "bad.mp4")
      await writeFile(filePath, MINIMAL_MP4)
      const client = withMockedAuth(new XClient(config))
      await expect(client.uploadMedia(filePath)).rejects.toThrow("invalid media")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("XClient retweets", () => {
  test("retweet posts to /2/users/:id/retweets", async () => {
    let capturedUrl = ""
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input)
      if (capturedUrl.endsWith("/2/users/me")) {
        return new Response(JSON.stringify({ data: { id: "me-1", username: "u" } }), { status: 200 })
      }
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ data: { retweeted: true } }), { status: 200 })
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await client.retweet("555")

    expect(capturedUrl).toContain("/2/users/me-1/retweets")
    expect(capturedBody).toEqual({ tweet_id: "555" })
  })

  test("undoRetweet deletes /2/users/:id/retweets/:tweet_id", async () => {
    let capturedUrl = ""
    globalThis.fetch = (async (input) => {
      capturedUrl = String(input)
      if (capturedUrl.endsWith("/2/users/me")) {
        return new Response(JSON.stringify({ data: { id: "me-1", username: "u" } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { retweeted: false } }), { status: 200 })
    }) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await client.undoRetweet("555")

    expect(capturedUrl).toContain("/2/users/me-1/retweets/555")
  })
})

describe("XClient.listTopLevelUserPostsInRange", () => {
  test("keeps only posts whose conversation_id equals their own id, filtering out replies", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "1", conversation_id: "1", text: "root post", created_at: "2026-08-07T10:00:00Z" },
            { id: "2", conversation_id: "1", text: "self-thread reply", created_at: "2026-08-07T10:01:00Z" },
            { id: "3", conversation_id: "99", text: "reply to someone else", created_at: "2026-08-07T10:02:00Z" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const posts = await client.listTopLevelUserPostsInRange("me-1", "2026-08-07T00:00:00Z", "2026-08-08T00:00:00Z")

    expect(posts.map((post) => post.id)).toEqual(["1"])
  })

  test("paginates until next_token is absent or maxPosts is reached", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            data: [{ id: "1", conversation_id: "1", text: "a", created_at: "2026-08-07T10:00:00Z" }],
            meta: { next_token: "page2" },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "2", conversation_id: "2", text: "b", created_at: "2026-08-07T11:00:00Z" }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const client = withMockedAuth(new XClient(config))
    const posts = await client.listTopLevelUserPostsInRange("me-1", "2026-08-07T00:00:00Z", "2026-08-08T00:00:00Z")

    expect(calls).toBe(2)
    expect(posts.map((post) => post.id)).toEqual(["1", "2"])
  })
})
