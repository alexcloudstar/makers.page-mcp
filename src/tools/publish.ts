import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DraftStore, DraftNotFoundError, withDraftLock } from "../drafts/store.js"
import { XApiError, XClient, NotAuthenticatedError } from "../channels/x/client.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

export const registerPublishTools = (server: McpServer, config: Config): void => {
  const store = new DraftStore(config)
  const xClient = new XClient(config)

  server.registerTool(
    "publish_draft",
    {
      title: "Publish draft post",
      description:
        "Publish an approved draft to X via the X API v2. Fails if the draft has not been approved yet (unless approval is disabled in config). Returns the live post URL.",
      inputSchema: { id: z.string().meta({ description: "Draft id." }) },
    },
    async ({ id }) =>
      // Serialized per draft id so two overlapping publish_draft calls (or a
      // retry racing the original call) can't both slip past the status
      // check before either one posts, which would double-publish to X.
      withDraftLock(id, async () => {
        let draft
        try {
          draft = await store.get(id)
        } catch (error) {
          if (error instanceof DraftNotFoundError) return errorResult(error.message)
          throw error
        }

        if (draft.status === "published") {
          return errorResult(`Draft "${id}" was already published: ${draft.url}`)
        }

        if (draft.status === "publishing") {
          return errorResult(
            `Draft "${id}" is already being published (or a previous attempt was interrupted). ` +
              "Check your X account before retrying — if the post went out, use get_draft/update_draft to reconcile the local record manually.",
          )
        }

        if (draft.status !== "approved" && config.requireApproval) {
          return errorResult(
            `Draft "${id}" has status "${draft.status}". Approve it with approve_draft before publishing.`,
          )
        }

        if (draft.channel !== "x") {
          return errorResult(`Unsupported channel "${draft.channel}". Only "x" is supported today.`)
        }

        const statusBeforePublish = draft.status
        await store.beginPublishing(id)

        let tweet
        try {
          tweet = await xClient.createTweet(draft.text)
        } catch (error) {
          // Nothing was posted, safe to revert so the draft can be retried.
          await store.revertPublishing(id, statusBeforePublish)
          if (error instanceof NotAuthenticatedError) return errorResult(error.message)
          if (error instanceof XApiError) {
            return errorResult(`X API error (${error.status}): ${error.message}`)
          }
          throw error
        }

        try {
          const published = await store.markPublished(id, { externalId: tweet.id, url: tweet.url })
          return textResult(`Published to X: ${tweet.url}\n\n${JSON.stringify(published, null, 2)}`)
        } catch (error) {
          // The tweet is already live; failing to persist that locally must
          // not be reported as a failure (an agent could retry and double-post).
          console.error(`Tweet ${tweet.id} was published but the local draft record could not be updated:`, error)
          return textResult(
            `Published to X: ${tweet.url}\n\n` +
              `WARNING: the post is live, but updating the local draft record for "${id}" failed. ` +
              `Verify manually and do not retry publish_draft for this draft. Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
          )
        }
      }),
  )
}
