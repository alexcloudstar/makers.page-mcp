import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { DraftStore, DraftNotFoundError, withDraftLock } from "../drafts/store.js"
import { XApiError, XClient, NotAuthenticatedError } from "../channels/x/client.js"
import { NetworkError } from "../util/fetch-with-timeout.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

// Narrowed to just what this module needs, so tests can inject lightweight
// fakes instead of real X/network clients or a real DraftStore.
type PublishDeps = {
  store?: Pick<DraftStore, "get" | "beginPublishing" | "revertPublishing" | "markPublished">
  xClient?: Pick<XClient, "createTweet">
}

export const registerPublishTools = (server: McpServer, config: Config, deps: PublishDeps = {}): void => {
  const store = deps.store ?? new DraftStore(config)
  const xClient = deps.xClient ?? new XClient(config)

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
          // NotAuthenticatedError means we never had a token to send the
          // request with, and XApiError means X sent back a definitive HTTP
          // response (even an error one) — in both cases we know for certain
          // nothing was posted, so it's safe to revert and allow a retry.
          if (error instanceof NotAuthenticatedError) {
            await store.revertPublishing(id, statusBeforePublish)
            return errorResult(error.message)
          }
          if (error instanceof XApiError) {
            await store.revertPublishing(id, statusBeforePublish)
            return errorResult(`X API error (${error.status}): ${error.message}`)
          }

          if (error instanceof NetworkError) {
            // A failure inside the actual fetch (timeout, DNS, connection
            // reset, ...) is genuinely ambiguous: X may have received and
            // processed the request before the connection dropped.
            // Reverting here would let an agent retry and risk a real, paid
            // duplicate post. Leave the draft in "publishing" and require
            // manual reconciliation (reject_draft or update_draft) after the
            // user has checked their X account.
            console.error(
              `publish_draft "${id}": network error talking to X, outcome unknown, leaving draft in "publishing":`,
              error,
            )
            return errorResult(
              `Publishing draft "${id}" failed with a network error, so it may or may not have posted: ${error.message}\n\n` +
                "Check your X account before doing anything else. The draft has been left with status " +
                '"publishing" and will NOT be retried automatically. Once you know the outcome, reconcile it ' +
                "manually: if it did NOT post, call reject_draft or update_draft to reset it; if it DID post, " +
                "leave it as-is and note the live URL yourself.",
            )
          }

          // Anything else is an unexpected local failure (a bug, a bad
          // reference, etc.) that happened outside the actual network call,
          // so it's not ambiguous: the request was never sent. Safe to
          // revert and allow a retry, but log it since it likely indicates a
          // real defect rather than a transient condition.
          console.error(`publish_draft "${id}": unexpected error before any request reached X, reverting:`, error)
          await store.revertPublishing(id, statusBeforePublish)
          const message = error instanceof Error ? error.message : String(error)
          return errorResult(`Publishing draft "${id}" failed unexpectedly before reaching X: ${message}`)
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
