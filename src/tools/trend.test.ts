import { describe, expect, test } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XApiError, XClient } from "../channels/x/client.js"
import type { RawSignal, TrendSource } from "../trends/types.js"
import { registerTrendTools } from "./trend.js"

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

const baseArgs = {
  productName: "Makers.page",
  productDescription: "Startup directory with a hosted marketing MCP.",
  niche: "indie hackers",
  targetAudience: "founders building AI products",
}

const signal = (overrides: Partial<RawSignal>): RawSignal => ({
  id: Math.random().toString(36),
  text: "",
  url: "https://x.com/i/web/status/1",
  author: "@founder",
  metrics: { likes: 0, reposts: 0, replies: 0, quotes: 0 },
  source: "x",
  createdAt: new Date().toISOString(),
  ...overrides,
})

describe("be_trendy tool", () => {
  test("returns the assembled trend analysis as JSON", async () => {
    const server = new StubServer()
    const fakeSource: TrendSource = {
      name: "fake",
      fetchSignals: async () =>
        ["Shipping #BuildInPublic updates today", "Loving the #BuildInPublic momentum lately"].map((text) =>
          signal({ text }),
        ),
    }
    registerTrendTools(server as unknown as never, config, {
      xClient: new XClient(config),
      trendSources: [fakeSource],
    })

    const result = await server.call("be_trendy", baseArgs)
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result)) as { trendingTopics: Array<{ topic: string }> }
    expect(parsed.trendingTopics[0]!.topic).toBe("#BuildInPublic")
  })

  test("returns a clean error when no signals are found", async () => {
    const server = new StubServer()
    const emptySource: TrendSource = { name: "fake", fetchSignals: async () => [] }
    registerTrendTools(server as unknown as never, config, {
      xClient: new XClient(config),
      trendSources: [emptySource],
    })

    const result = await server.call("be_trendy", baseArgs)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("No usable X posts")
  })

  test("surfaces an X API rate-limit error with a tier note", async () => {
    const server = new StubServer()
    const failingSource: TrendSource = {
      name: "fake",
      fetchSignals: async () => {
        throw new XApiError("Too Many Requests", 429, {})
      },
    }
    registerTrendTools(server as unknown as never, config, {
      xClient: new XClient(config),
      trendSources: [failingSource],
    })

    const result = await server.call("be_trendy", baseArgs)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Basic paid X API access tier")
  })
})
