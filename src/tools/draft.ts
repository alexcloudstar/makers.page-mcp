import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DraftStore, DraftNotFoundError, withDraftLock } from "../drafts/store.js"
import { validateXPostText } from "../channels/x/validate.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const formatDraft = (draft: {
  id: string
  channel: string
  text: string
  status: string
  createdAt: string
  updatedAt: string
  publishedAt?: string
  url?: string
}): string => JSON.stringify(draft, null, 2)

export const registerDraftTools = (server: McpServer, config: Config): void => {
  const store = new DraftStore(config)

  server.registerTool(
    "create_draft",
    {
      title: "Create draft post",
      description:
        "Create a draft social post for a channel (currently only \"x\"). The draft is saved locally and is NOT published until it is approved and then explicitly published.",
      inputSchema: {
        channel: z.literal("x").meta({ description: "Target channel. Only \"x\" is supported today." }),
        text: z.string().meta({ description: "The post copy, written for the target channel." }),
      },
    },
    async ({ channel, text }) => {
      const validation = validateXPostText(text, config.maxPostLength)
      if (!validation.ok) return errorResult(validation.error)

      const draft = await store.create({ channel, text })
      return textResult(
        `Draft created (status: draft). Show this to the user for approval before publishing.\n\n${formatDraft(draft)}`,
      )
    },
  )

  server.registerTool(
    "list_drafts",
    {
      title: "List draft posts",
      description: "List locally stored drafts, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["draft", "approved", "rejected", "publishing", "published"])
          .optional()
          .meta({ description: "Only return drafts with this status." }),
      },
    },
    async ({ status }) => {
      const drafts = await store.list(status)
      if (drafts.length === 0) return textResult("No drafts found.")
      return textResult(drafts.map(formatDraft).join("\n\n"))
    },
  )

  server.registerTool(
    "get_draft",
    {
      title: "Get draft post",
      description: "Fetch a single draft by id.",
      inputSchema: { id: z.string().meta({ description: "Draft id." }) },
    },
    async ({ id }) => {
      try {
        const draft = await store.get(id)
        return textResult(formatDraft(draft))
      } catch (error) {
        if (error instanceof DraftNotFoundError) return errorResult(error.message)
        throw error
      }
    },
  )

  server.registerTool(
    "update_draft",
    {
      title: "Update draft post",
      description:
        "Edit a draft's text. If the draft was already approved, this resets it back to \"draft\" status so it must be re-approved before publishing.",
      inputSchema: {
        id: z.string().meta({ description: "Draft id." }),
        text: z.string().meta({ description: "New post copy." }),
      },
    },
    async ({ id, text }) => {
      const validation = validateXPostText(text, config.maxPostLength)
      if (!validation.ok) return errorResult(validation.error)

      return withDraftLock(id, async () => {
        try {
          const draft = await store.updateText(id, text)
          return textResult(formatDraft(draft))
        } catch (error) {
          if (error instanceof DraftNotFoundError) return errorResult(error.message)
          throw error
        }
      })
    },
  )
}
