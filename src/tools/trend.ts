import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XClient, NotAuthenticatedError, XApiError } from "../channels/x/client.js"
import { runTrendPipeline } from "../trends/pipeline.js"
import { XTrendSource } from "../trends/xSource.js"
import { NoSignalsError } from "../trends/types.js"
import type { TrendSource } from "../trends/types.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const jsonResult = (value: unknown): CallToolResult => textResult(JSON.stringify(value, null, 2))

const handleTrendError = (error: unknown): CallToolResult => {
  if (error instanceof NoSignalsError) return errorResult(error.message)
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

type TrendToolDeps = {
  xClient?: XClient
  trendSources?: TrendSource[]
}

export const registerTrendTools = (server: McpServer, config: Config, deps: TrendToolDeps = {}): void => {
  const xClient = deps.xClient ?? new XClient(config)
  const trendSources = deps.trendSources ?? [new XTrendSource(xClient)]

  server.registerTool(
    "be_trendy",
    {
      title: "Be Trendy",
      description:
        "Discover what's trending right now on X within a specific product niche, so you can ride the conversation for engagement. " +
        "Searches recent X posts scoped to the niche/keywords, not X's generic global trending list (which rarely surfaces niche topics), " +
        "filters out spam and near-duplicates, and returns algorithmically scored trending topics with real sample tweets and engagement " +
        "numbers, real demand-signal posts (people asking for recommendations/alternatives), and a post-timing recommendation. " +
        "This tool does not generate content itself: after calling it, use the returned trendingTopics and painPointSignals, plus the " +
        "product's name/description/audience from this conversation, to write natural, platform-appropriate content (tweet, thread, " +
        "LinkedIn post, Bluesky post, Reddit title, Hacker News title) that connects the product to the trend. Avoid AI-sounding phrasing, " +
        "do not fabricate engagement numbers, and ground any claims in the sample tweets returned.",
      inputSchema: {
        productName: z.string().min(1).max(200).meta({ description: "Name of the product to find trending angles for." }),
        productDescription: z.string().min(1).max(2000).meta({ description: "What the product does, in a sentence or two." }),
        niche: z
          .string()
          .min(1)
          .max(200)
          .meta({ description: 'The market/niche/category to search trends in, e.g. "indie SaaS analytics".' }),
        targetAudience: z
          .string()
          .min(1)
          .max(500)
          .meta({ description: 'Who the product is for, e.g. "solo founders shipping side projects".' }),
        keywords: z
          .array(z.string().min(1).max(60))
          .max(15)
          .optional()
          .meta({ description: "Optional extra keywords/hashtags/tools to search for alongside the niche." }),
        language: z
          .string()
          .length(2)
          .optional()
          .meta({ description: 'Optional ISO-639-1 language code to restrict X search (e.g. "en").' }),
      },
    },
    async ({ productDescription, niche, targetAudience, keywords, language }) => {
      try {
        const result = await runTrendPipeline(
          {
            niche,
            keywords: keywords ?? [],
            productDescription,
            targetAudience,
            language,
          },
          { trendSources, xClient },
        )
        return jsonResult(result)
      } catch (error) {
        return handleTrendError(error)
      }
    },
  )
}
