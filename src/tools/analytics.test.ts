import { describe, expect, test } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XClient } from "../channels/x/client.js"
import { registerAnalyticsTools } from "./analytics.js"

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

const stubXClient = (overrides: Record<string, unknown> = {}) => {
  const client = new XClient(config)
  Object.defineProperty(client, "getAccessToken", { value: async () => "test-token" })
  return { ...client, ...overrides } as XClient
}

describe("analytics tools", () => {
  test("get_x_account_summary uses tweet analytics API totals", async () => {
    const server = new StubServer()
    registerAnalyticsTools(server as unknown as never, config, {
      xClient: stubXClient({
        getMe: async () => ({ id: "1", username: "me", name: "Me" }),
        listUserTweetsInRange: async () => [
          {
            id: "100",
            text: "today post",
            createdAt: new Date().toISOString(),
            url: "https://x.com/i/web/status/100",
            metrics: {
              impressionCount: 9999,
              likeCount: 0,
              replyCount: 0,
              repostCount: 0,
              quoteCount: 0,
              bookmarkCount: 0,
            },
          },
        ],
        getPostsAnalytics: async () => [
          {
            id: "100",
            timestampedMetrics: [
              {
                timestamp: new Date().toISOString(),
                metrics: {
                  impressions: 1100,
                  engagements: 40,
                  likes: 20,
                  reposts: 5,
                  replies: 10,
                  quotes: 0,
                },
              },
            ],
          },
        ],
      }),
    })

    const result = await server.call("get_x_account_summary", { days: 1, timezone: "UTC" })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result)) as {
      metricSource: string
      today: { impressions: number }
    }
    expect(parsed.metricSource).toBe("tweet_analytics_api")
    expect(parsed.today.impressions).toBe(1100)
  })

  test("get_x_account_summary rejects invalid timezone", async () => {
    const server = new StubServer()
    registerAnalyticsTools(server as unknown as never, config, {
      xClient: stubXClient(),
    })

    const result = await server.call("get_x_account_summary", { timezone: "Not/A/Timezone" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Invalid timezone")
  })
})
