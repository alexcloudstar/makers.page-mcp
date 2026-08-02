import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import {
  analyzePostingTimes,
  buildAccountSummaryFromAnalytics,
  getDayBoundsUtc,
  getPeriodBoundsUtc,
} from "../channels/x/analytics.js"
import { XClient, NotAuthenticatedError, XApiError } from "../channels/x/client.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const jsonResult = (value: unknown): CallToolResult => textResult(JSON.stringify(value, null, 2))

const handleXError = (error: unknown): CallToolResult => {
  if (error instanceof NotAuthenticatedError) return errorResult(error.message)
  if (error instanceof XApiError) {
    return errorResult(`X API error (${error.status}): ${error.message}`)
  }
  throw error
}

const ANALYTICS_LOOKBACK_DAYS = 30

type AnalyticsToolDeps = {
  xClient?: XClient
}

export const registerAnalyticsTools = (
  server: McpServer,
  config: Config,
  deps: AnalyticsToolDeps = {},
): void => {
  const xClient = deps.xClient ?? new XClient(config)

  server.registerTool(
    "get_x_post_metrics",
    {
      title: "Get X post metrics",
      description:
        "Fetch lifetime public metrics (impressions, likes, reposts, replies, quotes, bookmarks) for up to 100 post ids. Read-only.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(100).meta({ description: "Post ids to look up (max 100)." }),
      },
    },
    async ({ ids }) => {
      try {
        const posts = await xClient.getTweetsByIds(ids)
        if (posts.length === 0) return textResult("No posts found for the given ids.")
        return jsonResult({ posts })
      } catch (error) {
        return handleXError(error)
      }
    },
  )

  server.registerTool(
    "get_x_account_summary",
    {
      title: "Get X account summary",
      description:
        "Summarize your account using GET /2/tweets/analytics: calendar-day impressions and engagements (aligned with x.com account analytics), period totals, and top posts for the window. Read-only; no local DB.",
      inputSchema: {
        days: z.number().int().min(1).max(30).optional().meta({ description: "Calendar days to include (default 7, max 30)." }),
        maxPosts: z
          .number()
          .int()
          .min(5)
          .max(500)
          .optional()
          .meta({ description: "Max recent posts to pull ids from (default 500, last 30 days)." }),
        timezone: z.string().optional().meta({ description: "IANA timezone for calendar windows (default UTC)." }),
        topPosts: z.number().int().min(1).max(20).optional().meta({ description: "Top posts to include (default 5)." }),
      },
    },
    async ({ days, maxPosts, timezone, topPosts }) => {
      try {
        const me = await xClient.getMe()
        const tz = timezone ?? "UTC"
        const lookbackDays = days ?? 7
        const cap = maxPosts ?? 500
        const periodBounds = getPeriodBoundsUtc(lookbackDays, tz)
        const analyticsWindowStart = new Date(Date.now() - ANALYTICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

        const posts = await xClient.listUserTweetsInRange(
          me.id,
          analyticsWindowStart.toISOString(),
          periodBounds.end.toISOString(),
          cap,
        )

        const ids = posts.map((post) => post.id)
        const analytics = await xClient.getPostsAnalytics(
          ids,
          periodBounds.start.toISOString(),
          periodBounds.end.toISOString(),
          "total",
        )

        let todayAnalytics: typeof analytics | undefined
        if (lookbackDays > 1) {
          const todayBounds = getDayBoundsUtc(new Date(), tz)
          todayAnalytics = await xClient.getPostsAnalytics(
            ids,
            todayBounds.start.toISOString(),
            todayBounds.end.toISOString(),
            "total",
          )
        }

        const summary = buildAccountSummaryFromAnalytics({
          account: { id: me.id, username: me.username },
          posts,
          analytics,
          todayAnalytics,
          days: lookbackDays,
          timezone: tz,
          topLimit: topPosts ?? 5,
        })

        return jsonResult(summary)
      } catch (error) {
        return handleXError(error)
      }
    },
  )

  server.registerTool(
    "analyze_x_posting_times",
    {
      title: "Analyze X posting times",
      description:
        "Analyze when you post vs average lifetime impressions by hour of day. Derived from your recent timeline; read-only, no DB.",
      inputSchema: {
        days: z.number().int().min(1).max(30).optional().meta({ description: "Look back this many days (default 30)." }),
        maxPosts: z.number().int().min(5).max(500).optional().meta({ description: "Max posts to analyze (default 500)." }),
        timezone: z.string().optional().meta({ description: "IANA timezone for hour buckets (default UTC)." }),
        minPostsPerHour: z.number().int().min(1).max(10).optional().meta({
          description: "Min posts per hour before a bucket qualifies for best-hours (default 2).",
        }),
      },
    },
    async ({ days, maxPosts, timezone, minPostsPerHour }) => {
      try {
        const me = await xClient.getMe()
        const lookbackDays = days ?? 30
        const cap = maxPosts ?? 500
        const end = new Date()
        const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
        const posts = await xClient.listUserTweetsInRange(me.id, start.toISOString(), end.toISOString(), cap)
        const analysis = analyzePostingTimes(
          posts,
          lookbackDays,
          timezone ?? "UTC",
          minPostsPerHour ?? 2,
        )
        return jsonResult({ account: { id: me.id, username: me.username }, ...analysis })
      } catch (error) {
        return handleXError(error)
      }
    },
  )
}
