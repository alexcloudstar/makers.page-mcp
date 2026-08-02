import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import type { RetweetAction, RetweetDraft } from "../retweets/types.js"
import {
  RetweetDraftStore,
  RetweetDraftNotFoundError,
  InvalidRetweetDraftTransitionError,
  withRetweetDraftLock,
} from "../retweets/store.js"
import { validateTweetId } from "../channels/x/retweet-validate.js"
import { XApiError, XClient, NotAuthenticatedError } from "../channels/x/client.js"
import { NetworkError } from "../util/fetch-with-timeout.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const formatRetweetDraft = (draft: RetweetDraft): string => JSON.stringify(draft, null, 2)

const formatExecuteError = (error: unknown): string => {
  if (error instanceof NotAuthenticatedError) return error.message
  if (error instanceof XApiError) return `X API error (${error.status}): ${error.message}`
  if (error instanceof NetworkError) return error.message
  return error instanceof Error ? error.message : String(error)
}

type RetweetToolDeps = {
  store?: RetweetDraftStore
  xClient?: Pick<XClient, "retweet" | "undoRetweet">
}

const executeRetweetDraft = async (
  config: Config,
  store: RetweetDraftStore,
  xClient: Pick<XClient, "retweet" | "undoRetweet">,
  id: string,
  expectedAction: RetweetAction,
  toolName: string,
): Promise<CallToolResult> =>
  withRetweetDraftLock(id, async () => {
    let draft: RetweetDraft
    try {
      draft = await store.get(id)
    } catch (error) {
      if (error instanceof RetweetDraftNotFoundError) return errorResult(error.message)
      throw error
    }

    if (draft.action !== expectedAction) {
      return errorResult(
        `Retweet draft "${id}" is action "${draft.action}", not "${expectedAction}". ` +
          (expectedAction === "retweet"
            ? "Use undo_retweet for undo drafts."
            : "Use retweet_post for retweet drafts."),
      )
    }

    if (draft.status === "completed") {
      return errorResult(
        `Retweet draft "${id}" was already completed at ${draft.executedAt ?? "unknown time"}.`,
      )
    }
    if (draft.status === "deleted") {
      return errorResult(`Retweet draft "${id}" was deleted and cannot be executed.`)
    }
    if (draft.status === "executing") {
      return errorResult(
        `Retweet draft "${id}" is already executing (or a previous attempt was interrupted). ` +
          "Check X manually before retrying.",
      )
    }
    if (draft.status !== "approved" && config.requireApproval) {
      return errorResult(
        `Retweet draft "${id}" has status "${draft.status}". Approve it with approve_retweet_draft first.`,
      )
    }

    const statusBeforeExecute = draft.status
    await store.beginExecuting(id)

    try {
      if (expectedAction === "retweet") {
        await xClient.retweet(draft.tweetId)
      } else {
        await xClient.undoRetweet(draft.tweetId)
      }

      const verb = expectedAction === "retweet" ? "Retweeted" : "Undo retweet completed for"
      const target = draft.tweetUrl ?? draft.tweetId
      try {
        const updated = await store.markCompleted(id)
        return textResult(`${verb} ${target}.\n\n${formatRetweetDraft(updated)}`)
      } catch (error) {
        console.error(
          `${toolName} "${id}": action succeeded on X but local draft record could not be updated:`,
          error,
        )
        return textResult(
          `${verb} ${target}.\n\n` +
            "WARNING: the action succeeded on X, but updating the local draft record failed. " +
            "Verify manually and do not retry for this draft. Error: " +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    } catch (error) {
      if (error instanceof NotAuthenticatedError || error instanceof XApiError) {
        await store.revertExecuting(id, statusBeforeExecute)
        return errorResult(formatExecuteError(error))
      }
      if (error instanceof NetworkError) {
        console.error(`${toolName} "${id}": network error, leaving draft in "executing":`, error)
        return errorResult(
          `${toolName} for draft "${id}" failed with a network error; outcome unknown: ${error.message}\n` +
            'Draft left in "executing". Check X manually before retrying.',
        )
      }
      await store.revertExecuting(id, statusBeforeExecute)
      return errorResult(formatExecuteError(error))
    }
  })

export const registerRetweetTools = (
  server: McpServer,
  config: Config,
  deps: RetweetToolDeps = {},
): void => {
  const store = deps.store ?? new RetweetDraftStore(config)
  const xClient = deps.xClient ?? new XClient(config)

  server.registerTool(
    "create_retweet_draft",
    {
      title: "Create retweet draft",
      description:
        "Create a draft retweet or undo-retweet action. NOT executed until approved and retweet_post or undo_retweet is called. " +
        "Pass the numeric post id from an X URL (e.g. .../status/1234567890).",
      inputSchema: {
        tweetId: z.string().meta({ description: "Numeric X post id to retweet or undo retweet for." }),
        action: z
          .enum(["retweet", "undo"])
          .meta({ description: '"retweet" to repost; "undo" to remove your repost of this post.' }),
      },
    },
    async ({ tweetId, action }) => {
      const validation = validateTweetId(tweetId)
      if (!validation.ok) return errorResult(validation.error)

      const draft = await store.create({ tweetId: validation.tweetId, action })
      const verb = action === "retweet" ? "Retweet" : "Undo retweet"
      return textResult(
        `${verb} draft created (not executed yet).\n\n${formatRetweetDraft(draft)}`,
      )
    },
  )

  server.registerTool(
    "list_retweet_drafts",
    {
      title: "List retweet drafts",
      description: "List retweet/undo drafts, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["draft", "approved", "rejected", "executing", "completed", "deleted"])
          .optional()
          .meta({ description: "Filter by status." }),
      },
    },
    async ({ status }) => {
      const drafts = await store.list(status)
      if (drafts.length === 0) return textResult("No retweet drafts found.")
      return textResult(drafts.map(formatRetweetDraft).join("\n\n"))
    },
  )

  server.registerTool(
    "get_retweet_draft",
    {
      title: "Get retweet draft",
      description: "Fetch a single retweet/undo draft by id.",
      inputSchema: { id: z.string().meta({ description: "Retweet draft id." }) },
    },
    async ({ id }) => {
      try {
        const draft = await store.get(id)
        return textResult(formatRetweetDraft(draft))
      } catch (error) {
        if (error instanceof RetweetDraftNotFoundError) return errorResult(error.message)
        throw error
      }
    },
  )

  server.registerTool(
    "approve_retweet_draft",
    {
      title: "Approve retweet draft",
      description:
        "Mark a retweet/undo draft approved. Only approved drafts can be executed. Call only after the user explicitly reviewed the action.",
      inputSchema: { id: z.string().meta({ description: "Retweet draft id." }) },
    },
    async ({ id }) =>
      withRetweetDraftLock(id, async () => {
        try {
          const draft = await store.approve(id)
          return textResult(`Retweet draft approved. It can now be executed.\n\n${formatRetweetDraft(draft)}`)
        } catch (error) {
          if (error instanceof RetweetDraftNotFoundError || error instanceof InvalidRetweetDraftTransitionError) {
            return errorResult(error.message)
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "reject_retweet_draft",
    {
      title: "Reject retweet draft",
      description:
        "Mark a retweet/undo draft rejected. Also usable to reconcile a draft stuck in executing after a failed attempt.",
      inputSchema: { id: z.string().meta({ description: "Retweet draft id." }) },
    },
    async ({ id }) =>
      withRetweetDraftLock(id, async () => {
        try {
          const draft = await store.reject(id)
          return textResult(`Retweet draft rejected.\n\n${formatRetweetDraft(draft)}`)
        } catch (error) {
          if (error instanceof RetweetDraftNotFoundError || error instanceof InvalidRetweetDraftTransitionError) {
            return errorResult(error.message)
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "retweet_post",
    {
      title: "Retweet post",
      description:
        "Retweet an approved draft to X immediately via POST /2/users/:id/retweets. Requires tweet.write scope.",
      inputSchema: { id: z.string().meta({ description: "Retweet draft id (action must be retweet)." }) },
    },
    async ({ id }) => executeRetweetDraft(config, store, xClient, id, "retweet", "retweet_post"),
  )

  server.registerTool(
    "undo_retweet",
    {
      title: "Undo retweet",
      description:
        "Undo an approved retweet draft on X immediately via DELETE /2/users/:id/retweets/:tweet_id. Requires tweet.write scope.",
      inputSchema: { id: z.string().meta({ description: "Retweet draft id (action must be undo)." }) },
    },
    async ({ id }) => executeRetweetDraft(config, store, xClient, id, "undo", "undo_retweet"),
  )
}
