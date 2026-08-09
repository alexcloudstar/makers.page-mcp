import { describe, expect, test } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XApiError, XClient } from "../channels/x/client.js"
import { registerEngagersTools } from "./engagers.js"

class StubServer {
  private handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>()

  registerTool(
    name: string,
    _definition: unknown,
    handler: (args: never) => Promise<CallToolResult>,
  ): void {
    this.handlers.set(name, handler as (args: Record<string, unknown>) => Promise<CallToolResult>)
  }

  call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error('Tool "' + name + '" was not registered.')
    return handler(args)
  }
}

const textOf = (result: CallToolResult): string => (result.content[0] as { text: string }).text

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

const zeroMetrics = { impressionCount: 0, likeCount: 0, replyCount: 0, repostCount: 0, quoteCount: 0, bookmarkCount: 0 }

const stubXClient = (overrides: Record<string, unknown> = {}) => {
  const client = new XClient(config)
  Object.defineProperty(client, "getAccessToken", { value: async () => "test-token" })
  return { ...client, ...overrides } as XClient
}

describe("get_top_engagers tool", () => {
  test("returns a ranked leaderboard as JSON", async () => {
    const server = new StubServer()
    registerEngagersTools(server as unknown as never, config, {
      xClient: stubXClient({
        getMe: async () => ({ id: "1", username: "me", name: "Me" }),
        listTopLevelUserPostsInRange: async () => [
          { id: "p1", text: "hi", url: "https://x.com/i/web/status/p1", createdAt: new Date().toISOString(), metrics: zeroMetrics },
        ],
        searchRecentTweets: async () => ({
          tweets: [
            {
              id: "r1",
              text: "nice",
              url: "https://x.com/i/web/status/r1",
              createdAt: new Date().toISOString(),
              metrics: { ...zeroMetrics, likeCount: 3 },
              authorUsername: "fan",
              authorName: "A Fan",
            },
          ],
        }),
      }),
    })

    const result = await server.call("get_top_engagers", { date: "2026-08-07", timezone: "UTC" })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result)) as { topEngagers: Array<{ username: string; commentCount: number }> }
    expect(parsed.topEngagers[0]).toMatchObject({ username: "fan", commentCount: 1 })
  })

  test("returns a clean error when nothing was posted that day", async () => {
    const server = new StubServer()
    registerEngagersTools(server as unknown as never, config, {
      xClient: stubXClient({
        getMe: async () => ({ id: "1", username: "me", name: "Me" }),
        listTopLevelUserPostsInRange: async () => [],
      }),
    })

    const result = await server.call("get_top_engagers", { date: "2026-08-07", timezone: "UTC" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("No top-level posts")
  })

  test("rejects invalid timezone", async () => {
    const server = new StubServer()
    registerEngagersTools(server as unknown as never, config, { xClient: stubXClient() })

    const result = await server.call("get_top_engagers", { timezone: "Not/A/Timezone" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Invalid timezone")
  })

  test("surfaces an X API rate-limit error with a tier note", async () => {
    const server = new StubServer()
    registerEngagersTools(server as unknown as never, config, {
      xClient: stubXClient({
        getMe: async () => ({ id: "1", username: "me", name: "Me" }),
        listTopLevelUserPostsInRange: async () => {
          throw new XApiError("Too Many Requests", 429, {})
        },
      }),
    })

    const result = await server.call("get_top_engagers", { date: "2026-08-07", timezone: "UTC" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Basic paid X API access tier")
  })
})
