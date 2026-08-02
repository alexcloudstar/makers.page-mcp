import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import type { Draft } from "../drafts/types.js"
import { DraftStore, DraftNotFoundError, DraftHasLivePostsError, withDraftLock } from "../drafts/store.js"
import { mergeDraftFields, validateCreateDraftInput, validateXDraft } from "../channels/x/validate.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const formatDraft = (draft: Draft): string => JSON.stringify(draft, null, 2)

const pollSchema = z
  .object({
    options: z
      .array(z.string())
      .min(2)
      .max(4)
      .meta({ description: "Poll choices (2–4 strings)." }),
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(10080)
      .meta({ description: "Poll duration in minutes (5–10080)." }),
  })
  .meta({ description: "Attach a poll (mutually exclusive with mediaPaths and quoteTweetId)." })

const draftContentFields = {
  text: z.string().meta({ description: "The post copy (must equal parts[0] when parts is set)." }),
  poll: pollSchema.optional(),
  mediaPaths: z
    .array(z.string())
    .min(1)
    .max(4)
    .optional()
    .meta({
      description:
        "Absolute local file paths for media (1–4). Extension selects MIME (jpg/png/webp/gif/mp4); contents are not sniffed. Mutually exclusive with poll and quoteTweetId.",
    }),
  parts: z
    .array(z.string())
    .min(2)
    .optional()
    .meta({
      description:
        "Thread parts (length >= 2). text must equal parts[0]. Polls are not allowed on threads.",
    }),
  quoteTweetId: z
    .string()
    .optional()
    .meta({
      description:
        "ID of the post to quote. Enterprise-only on self-serve X API. Mutually exclusive with poll and mediaPaths.",
    }),
  communityId: z.string().optional().meta({ description: "Post into this Community id." }),
  shareWithFollowers: z
    .boolean()
    .optional()
    .meta({ description: "When posting to a community, also share with followers. Requires communityId." }),
  paidPartnership: z
    .boolean()
    .optional()
    .meta({ description: "Mark the post as a paid partnership." }),
}

const nullablePoll = pollSchema.nullable().optional()
const nullableString = z.string().nullable().optional()
const nullableBoolean = z.boolean().nullable().optional()

export const registerDraftTools = (server: McpServer, config: Config): void => {
  const store = new DraftStore(config)

  server.registerTool(
    "create_draft",
    {
      title: "Create draft post",
      description:
        "Create a draft social post for a channel (currently only \"x\"). Supports text, threads (parts), " +
        "polls, media paths, quote, community, and paid partnership. The draft is saved locally and is NOT " +
        "published until it is approved and then explicitly published.",
      inputSchema: {
        channel: z.literal("x").meta({ description: "Target channel. Only \"x\" is supported today." }),
        ...draftContentFields,
      },
    },
    async (args) => {
      const { channel, text, poll, mediaPaths, parts, quoteTweetId, communityId, shareWithFollowers, paidPartnership } =
        args
      const input = {
        channel,
        text,
        poll,
        mediaPaths,
        parts,
        quoteTweetId,
        communityId,
        shareWithFollowers,
        paidPartnership,
      }
      const validation = await validateCreateDraftInput(input, config.maxPostLength)
      if (!validation.ok) return errorResult(validation.error)

      const draft = await store.create(input)
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
          .enum(["draft", "approved", "rejected", "publishing", "published", "deleted"])
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
        "Edit a draft's content (text, parts, poll, media, quote, community, paid partnership). " +
        "Pass null to clear an optional field. If the draft was already approved, this resets it back to " +
        '"draft" status so it must be re-approved before publishing. To change a live post, use edit_published_draft.',
      inputSchema: {
        id: z.string().meta({ description: "Draft id." }),
        text: z
          .string()
          .optional()
          .meta({
            description:
              "New post copy. When parts is also set (or the draft is already a thread), text wins and becomes parts[0].",
          }),
        poll: nullablePoll.meta({ description: "New poll, or null to clear." }),
        mediaPaths: z
          .array(z.string())
          .min(1)
          .max(4)
          .nullable()
          .optional()
          .meta({ description: "New media paths (1–4), or null to clear." }),
        parts: z
          .array(z.string())
          .min(2)
          .nullable()
          .optional()
          .meta({ description: "New thread parts, or null to clear." }),
        quoteTweetId: nullableString.meta({ description: "Quote tweet id, or null to clear." }),
        communityId: nullableString.meta({ description: "Community id, or null to clear." }),
        shareWithFollowers: nullableBoolean.meta({
          description: "Share with followers (requires communityId), or null to clear.",
        }),
        paidPartnership: nullableBoolean.meta({ description: "Paid partnership flag, or null to clear." }),
      },
    },
    async ({ id, text, poll, mediaPaths, parts, quoteTweetId, communityId, shareWithFollowers, paidPartnership }) => {
      return withDraftLock(id, async () => {
        let current: Draft
        try {
          current = await store.get(id)
        } catch (error) {
          if (error instanceof DraftNotFoundError) return errorResult(error.message)
          throw error
        }

        if (current.status === "deleted") {
          return errorResult(`Draft "${id}" was deleted and cannot be updated.`)
        }
        if (current.status === "published") {
          return errorResult(
            `Draft "${id}" is published. Use edit_published_draft to change the live post, ` +
              "or delete_published_draft first if you meant to replace it.",
          )
        }
        if (current.status === "publishing" && (current.externalIds?.length || current.externalId)) {
          return errorResult(
            `Draft "${id}" is stuck in "publishing" with live post id(s) already recorded. ` +
              "Call delete_published_draft to remove them from X before editing this draft.",
          )
        }

        const update = {
          text,
          poll,
          mediaPaths,
          parts,
          quoteTweetId,
          communityId,
          shareWithFollowers,
          paidPartnership,
        }
        const hasContentUpdate = Object.values(update).some((value) => value !== undefined)
        if (!hasContentUpdate) {
          return errorResult(
            `update_draft requires at least one content field to change (text, parts, poll, mediaPaths, quoteTweetId, communityId, shareWithFollowers, or paidPartnership).`,
          )
        }
        const merged = mergeDraftFields(current, update)
        const validation = await validateXDraft(merged, config.maxPostLength)
        if (!validation.ok) return errorResult(validation.error)

        try {
          const draft = await store.update(id, update)
          return textResult(formatDraft(draft))
        } catch (error) {
          if (error instanceof DraftNotFoundError || error instanceof DraftHasLivePostsError) {
            return errorResult(error.message)
          }
          throw error
        }
      })
    },
  )
}
