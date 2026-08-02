import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
  credentialsPath: "/tmp/makers-page-mcp-test-config/credentials.json",
  requireApproval: true,
  maxPostLength: 280,
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
      new Response(JSON.stringify({ data: { deleted: false } }), { status: 200 })) as typeof fetch

    const client = withMockedAuth(new XClient(config))
    await expect(client.deleteTweet("42")).rejects.toMatchObject({
      name: "XApiError",
      message: expect.stringContaining("did not confirm deletion"),
    })
  })
})

describe("XClient.uploadMedia", () => {
  test("runs INIT, APPEND, FINALIZE without STATUS when processing_info is absent", async () => {
    const commands: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes("command=STATUS")) {
        throw new Error("STATUS should not be called")
      }
      const form = init?.body as FormData
      const command = String(form.get("command"))
      commands.push(command)
      if (command === "INIT") {
        return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 })
      }
      if (command === "APPEND") {
        return new Response(null, { status: 204 })
      }
      if (command === "FINALIZE") {
        return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 })
      }
      throw new Error(`unexpected command ${command}`)
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-"))
    try {
      const filePath = path.join(dir, "pic.png")
      await writeFile(filePath, Buffer.alloc(10, 1))
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
      const form = init?.body as FormData
      const command = String(form.get("command"))
      if (command === "INIT") {
        return new Response(JSON.stringify({ data: { id: "media-2" } }), { status: 200 })
      }
      if (command === "APPEND") {
        return new Response(null, { status: 204 })
      }
      if (command === "FINALIZE") {
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
      throw new Error(`unexpected ${url} ${command}`)
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-status-"))
    try {
      const filePath = path.join(dir, "clip.mp4")
      await writeFile(filePath, Buffer.alloc(10, 1))
      const client = withMockedAuth(new XClient(config))
      const mediaId = await client.uploadMedia(filePath)
      expect(mediaId).toBe("media-2")
      expect(statusCalls).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("throws when STATUS reports failed processing", async () => {
    globalThis.fetch = (async (_input, init) => {
      const form = init?.body as FormData | undefined
      const command = form ? String(form.get("command")) : ""
      if (command === "INIT") {
        return new Response(JSON.stringify({ data: { id: "media-3" } }), { status: 200 })
      }
      if (command === "APPEND") {
        return new Response(null, { status: 204 })
      }
      if (command === "FINALIZE") {
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
      throw new Error(`unexpected command ${command}`)
    }) as typeof fetch

    const dir = await mkdtemp(path.join(os.tmpdir(), "x-media-fail-"))
    try {
      const filePath = path.join(dir, "bad.mp4")
      await writeFile(filePath, Buffer.alloc(10, 1))
      const client = withMockedAuth(new XClient(config))
      await expect(client.uploadMedia(filePath)).rejects.toMatchObject({
        name: "XApiError",
        message: "invalid media",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
