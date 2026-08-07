import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XClient, NotAuthenticatedError, XApiError } from "../channels/x/client.js"
import { runSupporterSpotlight } from "../spotlight/pipeline.js"
import { XSupporterSource } from "../spotlight/xSupporterSource.js"
import { NoPostsYesterdayError } from "../spotlight/types.js"
import type { SupporterSource } from "../spotlight/types.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const jsonResult = (value: unknown): CallToolResult => textResult(JSON.stringify(value, null, 2))

const handleSpotlightError = (error: unknown): CallToolResult => {
  if (error instanceof NoPostsYesterdayError) return errorResult(error.message)
  if (error instanceof NotAuthenticatedError) return errorResult(error.message)
  if (error instanceof XApiError) {
    const tierNote =
      error.status === 429 || error.status === 403
        ? " Note: X's liking-users and Recent Search endpoints require at least a Basic paid X API access tier. A Free-tier app will see errors like this."
        : ""
    return errorResult(`X API error (${error.status}): ${error.message}${tierNote}`)
  }
  throw error
}

type SupporterSpotlightToolDeps = {
  xClient?: XClient
  supporterSource?: SupporterSource
}

export const registerSupporterSpotlightTools = (
  server: McpServer,
  config: Config,
  deps: SupporterSpotlightToolDeps = {},
): void => {
  const xClient = deps.xClient ?? new XClient(config)
  const supporterSource = deps.supporterSource ?? new XSupporterSource(xClient)

  server.registerTool(
    "supporter_spotlight",
    {
      title: "Supporter Spotlight",
      description:
        "Turn yesterday's engagement into today's relationships. Fetches every person who liked or replied to your X " +
        "posts from the previous calendar day (no cap — every post, every liker, every reply), dedupes them, and " +
        "excludes your own account. Only likes and replies count (reposts and quote tweets are ignored). Each " +
        "supporter gets an engagement score (like = 1pt, reply = 2pts — a reply carries more weight than a like on " +
        "X — doing both = 3pts) and the list is ranked highest-first. Always fetches live from X (nothing is cached " +
        "or stored). generatedPost is a ready-to-post draft built from a fixed template (not AI-written) mentioning " +
        "every supporter by @username, in ranked order — edit it freely, or leave it as-is. Nothing is ever " +
        "auto-published; hand the finished text to create_draft if you want it to go out as a real post.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .meta({ description: "Target day as YYYY-MM-DD. Defaults to yesterday (UTC)." }),
      },
    },
    async ({ date }) => {
      try {
        const result = await runSupporterSpotlight(
          { date },
          {
            supporterSource,
            getMe: () => xClient.getMe(),
          },
        )
        return jsonResult(result)
      } catch (error) {
        return handleSpotlightError(error)
      }
    },
  )
}
