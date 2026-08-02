import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import {
  DraftStore,
  DraftNotFoundError,
  DraftHasLivePostsError,
  InvalidDraftTransitionError,
  withDraftLock,
} from "../drafts/store.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

export const registerApprovalTools = (server: McpServer, config: Config): void => {
  const store = new DraftStore(config)

  server.registerTool(
    "approve_draft",
    {
      title: "Approve draft post",
      description:
        "Mark a draft as approved by the human user. Only approved drafts can be published. Only call this after the user has explicitly reviewed and approved the draft text.",
      inputSchema: { id: z.string().meta({ description: "Draft id." }) },
    },
    async ({ id }) =>
      withDraftLock(id, async () => {
        try {
          const draft = await store.approve(id)
          return textResult(`Draft approved. It can now be published.\n\n${JSON.stringify(draft, null, 2)}`)
        } catch (error) {
          if (error instanceof DraftNotFoundError || error instanceof InvalidDraftTransitionError) {
            return errorResult(error.message)
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "reject_draft",
    {
      title: "Reject draft post",
      description:
        "Mark a draft as rejected. Rejected drafts cannot be published. Also usable to reconcile a draft " +
        'stuck in "publishing" after a crashed publish_draft call once you have verified the post did NOT ' +
        "go out on X. If live post ids were already recorded (partial thread publish), call " +
        "delete_published_draft instead.",
      inputSchema: { id: z.string().meta({ description: "Draft id." }) },
    },
    async ({ id }) =>
      withDraftLock(id, async () => {
        try {
          const draft = await store.reject(id)
          return textResult(`Draft rejected.\n\n${JSON.stringify(draft, null, 2)}`)
        } catch (error) {
          if (
            error instanceof DraftNotFoundError ||
            error instanceof InvalidDraftTransitionError ||
            error instanceof DraftHasLivePostsError
          ) {
            return errorResult(error.message)
          }
          throw error
        }
      }),
  )
}
