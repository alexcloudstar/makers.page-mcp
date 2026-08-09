import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XClient, NotAuthenticatedError, XApiError } from "../channels/x/client.js"
import { getTopEngagers } from "../engagers/pipeline.js"
import { NoTopLevelPostsError } from "../engagers/types.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const jsonResult = (value: unknown): CallToolResult => textResult(JSON.stringify(value, null, 2))

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const validateTimezone = (timezone: string): string | undefined => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
    return undefined
  } catch {
    return `Invalid timezone: ${timezone}`
  }
}

const handleEngagersError = (error: unknown): CallToolResult => {
  if (error instanceof NoTopLevelPostsError) return errorResult(error.message)
  if (error instanceof NotAuthenticatedError) return errorResult(error.message)
  if (error instanceof XApiError) {
    const tierNote =
      error.status === 429 || error.status === 403
        ? " Note: X's Recent Search endpoint requires at least a Basic paid X API access tier. A Free-tier app will see errors like this."
        : ""
    return errorResult(`X API error (${error.status}): ${error.message}${tierNote}`)
  }
  throw error
}

type EngagersToolDeps = {
  xClient?: XClient
}

export const registerEngagersTools = (
  server: McpServer,
  config: Config,
  deps: EngagersToolDeps = {},
): void => {
  const xClient = deps.xClient ?? new XClient(config)

  server.registerTool(
    "get_top_engagers",
    {
      title: "Get top engagers",
      description:
        "Rank who commented the most on your top-level X posts for a given calendar day (default yesterday), so you know who to " +
        "follow up with, thank, or build a relationship with. Finds the top-level posts you started that day (not replies you left " +
        "on others, not thread continuations) via GET /2/users/:id/tweets, then for each one pulls every reply in that post's " +
        "conversation via GET /2/tweets/search/recent (conversation_id + is:reply, excluding yourself) — this automatically sweeps " +
        "in replies to any part of a thread, not just the root. Ranks commenters by comment count, then likes on their comments. " +
        "Read-only; creates no drafts. X's Recent Search only covers the last 7 days, so older dates will undercount or come back empty.",
      inputSchema: {
        date: z
          .string()
          .regex(DATE_PATTERN, "Expected YYYY-MM-DD")
          .optional()
          .meta({ description: "Calendar day to check, YYYY-MM-DD (default: yesterday in the given timezone)." }),
        timezone: z
          .string()
          .optional()
          .meta({ description: "IANA timezone the calendar day is measured in (default UTC)." }),
        limit: z.number().int().min(1).max(50).optional().meta({ description: "Max engagers to return (default 10)." }),
        maxPosts: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .meta({ description: "Max top-level posts to check for that day (default 50)." }),
      },
    },
    async ({ date, timezone, limit, maxPosts }) => {
      const tz = timezone ?? "UTC"
      const timezoneError = validateTimezone(tz)
      if (timezoneError) return errorResult(timezoneError)

      try {
        const result = await getTopEngagers({ date, timezone: tz, limit, maxPosts }, { xClient })
        return jsonResult(result)
      } catch (error) {
        return handleEngagersError(error)
      }
    },
  )
}
