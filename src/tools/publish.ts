import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import type { Draft } from "../drafts/types.js"
import {
  DraftStore,
  DraftNotFoundError,
  InvalidDraftTransitionError,
  recordedLiveIds,
  withDraftLock,
} from "../drafts/store.js"
import {
  XApiError,
  XClient,
  NotAuthenticatedError,
  type CreateTweetInput,
  type CreatedTweet,
} from "../channels/x/client.js"
import { validateEditEligibility, validateMediaPaths, validateXPostText } from "../channels/x/validate.js"
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
  store?: Pick<
    DraftStore,
    | "get"
    | "beginPublishing"
    | "revertPublishing"
    | "markPublished"
    | "recordPartialPublish"
    | "markDeleted"
    | "setRemainingLiveIds"
    | "applyEdit"
  >
  xClient?: Pick<XClient, "createTweet" | "uploadMedia" | "deleteTweet">
}

const isDefinitiveFailure = (error: unknown): error is NotAuthenticatedError | XApiError =>
  error instanceof NotAuthenticatedError || error instanceof XApiError

const formatPublishError = (error: unknown): string => {
  if (error instanceof NotAuthenticatedError) return error.message
  if (error instanceof XApiError) return `X API error (${error.status}): ${error.message}`
  if (error instanceof NetworkError) return error.message
  return error instanceof Error ? error.message : String(error)
}

const publishedIds = (draft: Draft): string[] => recordedLiveIds(draft)

export const registerPublishTools = (server: McpServer, config: Config, deps: PublishDeps = {}): void => {
  const store = deps.store ?? new DraftStore(config)
  const xClient = deps.xClient ?? new XClient(config)

  server.registerTool(
    "publish_draft",
    {
      title: "Publish draft post",
      description:
        "Publish an approved draft to X via the X API v2. Supports threads, polls, media, quotes, " +
        "community posts, and paid partnership. Fails if the draft has not been approved yet " +
        "(unless approval is disabled in config). Returns the live post URL(s).",
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

        if (draft.status === "deleted") {
          return errorResult(`Draft "${id}" was deleted and cannot be published.`)
        }

        if (draft.status === "publishing") {
          const liveIds = publishedIds(draft)
          if (liveIds.length > 0) {
            return errorResult(
              `Draft "${id}" is stuck in "publishing" with live post id(s) already recorded (${liveIds.join(", ")}). ` +
                "Do NOT retry publish_draft (that would double-post). " +
                "Call delete_published_draft to remove the live posts, or finish reconciling the remainder on X manually.",
            )
          }
          return errorResult(
            `Draft "${id}" is already being published (or a previous attempt was interrupted). ` +
              "Check your X account before retrying: if the post did NOT go out, use reject_draft or update_draft to reset; " +
              "if it DID go out, leave the draft as-is and note the live URL yourself (do not retry publish_draft).",
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

        // Defense in depth: never publish again while local state still points at live posts.
        const existingLiveIds = publishedIds(draft)
        if (existingLiveIds.length > 0) {
          return errorResult(
            `Draft "${id}" already has live post id(s) recorded (${existingLiveIds.join(", ")}). ` +
              "Call delete_published_draft before creating new posts for this draft.",
          )
        }

        const statusBeforePublish = draft.status

        // Re-check media at publish time: files may have moved or grown since draft creation.
        if (draft.mediaPaths && draft.mediaPaths.length > 0) {
          const mediaValidation = await validateMediaPaths(draft.mediaPaths)
          if (!mediaValidation.ok) return errorResult(mediaValidation.error)
        }

        await store.beginPublishing(id)

        const parts = draft.parts && draft.parts.length >= 2 ? draft.parts : [draft.text]
        const externalIds: string[] = []
        const urls: string[] = []
        // True once we have sent (or attempted) a createTweet call. Media-only
        // failures before this are safe to revert — no post can exist on X yet.
        let tweetRequestStarted = false

        try {
          let mediaIds: string[] | undefined
          if (draft.mediaPaths && draft.mediaPaths.length > 0) {
            mediaIds = []
            for (const filePath of draft.mediaPaths) {
              mediaIds.push(await xClient.uploadMedia(filePath))
            }
          }

          for (let i = 0; i < parts.length; i++) {
            const input: CreateTweetInput = { text: parts[i]! }
            if (i === 0) {
              if (mediaIds) input.mediaIds = mediaIds
              if (draft.poll) {
                input.poll = {
                  options: draft.poll.options,
                  durationMinutes: draft.poll.durationMinutes,
                }
              }
              if (draft.quoteTweetId) input.quoteTweetId = draft.quoteTweetId
              if (draft.communityId) input.communityId = draft.communityId
              if (draft.shareWithFollowers !== undefined) {
                input.shareWithFollowers = draft.shareWithFollowers
              }
              if (draft.paidPartnership !== undefined) {
                input.paidPartnership = draft.paidPartnership
              }
            } else {
              input.replyToId = externalIds[i - 1]
            }

            tweetRequestStarted = true
            const tweet = await xClient.createTweet(input)
            externalIds.push(tweet.id)
            urls.push(tweet.url)
          }
        } catch (error) {
          if (externalIds.length > 0) {
            // At least one part of a thread is live. Persist what we know and
            // do not auto-retry — the remaining parts must be reconciled manually.
            try {
              await store.recordPartialPublish(id, { externalIds, urls })
            } catch (persistError) {
              console.error(
                `publish_draft "${id}": partial publish persisted incompletely:`,
                persistError,
              )
            }
            return errorResult(
              `Publishing draft "${id}" failed after ${externalIds.length} of ${parts.length} parts posted.\n` +
                `Live so far: ${urls.join(", ")}\n` +
                `Error: ${formatPublishError(error)}\n\n` +
                'The draft has been left with status "publishing" and the posted ids recorded. ' +
                "Do NOT retry publish_draft. Call delete_published_draft to remove the live posts, " +
                "or finish the remaining parts on X manually.",
            )
          }

          if (isDefinitiveFailure(error)) {
            await store.revertPublishing(id, statusBeforePublish)
            return errorResult(formatPublishError(error))
          }

          if (error instanceof NetworkError) {
            if (!tweetRequestStarted) {
              // Media upload (or anything before the first createTweet) failed
              // on the network. No post can exist on X yet, so revert and allow retry.
              await store.revertPublishing(id, statusBeforePublish)
              return errorResult(
                `Publishing draft "${id}" failed while preparing media (before any post was created): ${error.message}\n` +
                  "The draft has been reverted and can be published again after you fix the issue.",
              )
            }

            // A failure inside the actual createTweet fetch is genuinely
            // ambiguous: X may have received and processed the request.
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

          // Unexpected local errors (e.g. malformed JSON after HTTP 200) that happen
          // after createTweet was attempted are ambiguous: the post may already be live.
          // Do not revert — same duplicate-post protection as NetworkError.
          if (tweetRequestStarted) {
            console.error(
              `publish_draft "${id}": unexpected error after createTweet was attempted, leaving draft in "publishing":`,
              error,
            )
            const message = error instanceof Error ? error.message : String(error)
            return errorResult(
              `Publishing draft "${id}" failed unexpectedly after a create request was sent, so it may or may not have posted: ${message}\n\n` +
                "Check your X account before doing anything else. The draft has been left with status " +
                '"publishing" and will NOT be retried automatically. Once you know the outcome, reconcile it ' +
                "manually: if it did NOT post, call reject_draft or update_draft to reset it; if it DID post, " +
                "leave it as-is and note the live URL yourself.",
            )
          }

          console.error(`publish_draft "${id}": unexpected error before any createTweet request, reverting:`, error)
          await store.revertPublishing(id, statusBeforePublish)
          const message = error instanceof Error ? error.message : String(error)
          return errorResult(`Publishing draft "${id}" failed unexpectedly before reaching X: ${message}`)
        }

        try {
          const published = await store.markPublished(id, {
            externalId: externalIds[0]!,
            url: urls[0]!,
            externalIds,
            urls,
          })
          const urlSummary = urls.length === 1 ? urls[0]! : urls.join("\n")
          return textResult(`Published to X:\n${urlSummary}\n\n${JSON.stringify(published, null, 2)}`)
        } catch (error) {
          console.error(
            `Tweet(s) ${externalIds.join(", ")} were published but the local draft record could not be updated:`,
            error,
          )
          return textResult(
            `Published to X:\n${urls.join("\n")}\n\n` +
              `WARNING: the post is live, but updating the local draft record for "${id}" failed. ` +
              `Verify manually and do not retry publish_draft for this draft. Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
          )
        }
      }),
  )

  server.registerTool(
    "delete_published_draft",
    {
      title: "Delete published draft from X",
      description:
        "Delete every live post id recorded on a draft (the root and any thread replies), " +
        "then mark the local draft as deleted. Works whenever live ids are recorded — published " +
        'drafts, partial "publishing" failures, or corrupt/legacy records. Own posts only.',
      inputSchema: { id: z.string().meta({ description: "Draft id." }) },
    },
    async ({ id }) =>
      withDraftLock(id, async () => {
        if (config.requireApproval) {
          return errorResult(
            "Deleting live posts requires explicit user approval when MAKERS_PAGE_REQUIRE_APPROVAL is enabled. " +
              "Set MAKERS_PAGE_REQUIRE_APPROVAL=false or confirm with the user before calling delete_published_draft.",
          )
        }

        let draft
        try {
          draft = await store.get(id)
        } catch (error) {
          if (error instanceof DraftNotFoundError) return errorResult(error.message)
          throw error
        }

        if (draft.status === "deleted") {
          return errorResult(`Draft "${id}" is already deleted.`)
        }

        const ids = publishedIds(draft)
        if (ids.length === 0) {
          return errorResult(
            `Draft "${id}" has no external ids to delete.` +
              (draft.status === "publishing"
                ? ' If nothing posted on X, use reject_draft or update_draft to reset.'
                : ""),
          )
        }

        // Normalize urls to one per id (corrupt/partial records may disagree).
        const rawUrls =
          draft.urls ?? (draft.url ? [draft.url] : ids.map((tweetId) => `https://x.com/i/web/status/${tweetId}`))
        const urls = ids.map(
          (tweetId, index) => rawUrls[index] ?? `https://x.com/i/web/status/${tweetId}`,
        )
        const remainingIds = [...ids]
        const remainingUrls = [...urls]

        // Only 404 means the post is gone. 403 is often "not allowed" and must not
        // be treated as success or we can markDeleted while the post is still live.
        const isAlreadyGone = (error: unknown): boolean =>
          error instanceof XApiError && error.status === 404

        try {
          while (remainingIds.length > 0) {
            const tweetId = remainingIds[0]!
            try {
              await xClient.deleteTweet(tweetId)
            } catch (error) {
              // Already deleted on X (or no longer visible) — treat as success for this id.
              if (!isAlreadyGone(error)) throw error
            }
            remainingIds.shift()
            remainingUrls.shift()
          }
        } catch (error) {
          // Persist what is still live so a retry only targets remaining ids.
          if (remainingIds.length < ids.length) {
            try {
              await store.setRemainingLiveIds(id, {
                externalIds: remainingIds,
                urls: remainingUrls.length === remainingIds.length ? remainingUrls : remainingIds.map((tweetId) => `https://x.com/i/web/status/${tweetId}`),
              })
            } catch (persistError) {
              console.error(`delete_published_draft "${id}": failed to persist remaining ids:`, persistError)
            }
          }

          if (isDefinitiveFailure(error)) {
            return errorResult(
              `${formatPublishError(error)}\n` +
                (remainingIds.length > 0
                  ? `Remaining live id(s) recorded locally: ${remainingIds.join(", ")}. Retry delete_published_draft.`
                  : ""),
            )
          }
          if (error instanceof NetworkError) {
            return errorResult(
              `Deleting draft "${id}" failed with a network error; some posts may already be gone: ${error.message}\n` +
                (remainingIds.length > 0
                  ? `Remaining id(s) recorded locally: ${remainingIds.join(", ")}. Check X, then retry delete_published_draft.`
                  : "Check your X account before retrying."),
            )
          }
          const message = error instanceof Error ? error.message : String(error)
          return errorResult(`Deleting draft "${id}" failed: ${message}`)
        }

        try {
          const deleted = await store.markDeleted(id)
          return textResult(`Deleted from X (${ids.length} post(s)).\n\n${JSON.stringify(deleted, null, 2)}`)
        } catch (error) {
          if (error instanceof InvalidDraftTransitionError) return errorResult(error.message)
          console.error(`Posts ${ids.join(", ")} were deleted but local record update failed:`, error)
          return textResult(
            `Deleted from X (${ids.length} post(s)), but updating the local draft record failed. ` +
              `Error: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }),
  )

  server.registerTool(
    "edit_published_draft",
    {
      title: "Edit published draft on X",
      description:
        "Edit the root post of a published draft via POST /2/tweets with edit_options.previous_post_id. " +
        "Requires X Premium; edits are limited (~30 minutes / 5 edits) and each edit creates a new post id " +
        "(stored locally). Re-attaches media (re-uploaded from mediaPaths) and quoteTweetId when present. " +
        "Polls and community posts cannot be edited. Only the thread root is edited.",
      inputSchema: {
        id: z.string().meta({ description: "Draft id." }),
        text: z.string().meta({ description: "New text for the root post." }),
        paidPartnership: z
          .boolean()
          .optional()
          .meta({ description: "Optional paid partnership flag for the edited post." }),
      },
    },
    async ({ id, text, paidPartnership }) =>
      withDraftLock(id, async () => {
        if (config.requireApproval) {
          return errorResult(
            "Editing live posts requires explicit user approval when MAKERS_PAGE_REQUIRE_APPROVAL is enabled. " +
              "Set MAKERS_PAGE_REQUIRE_APPROVAL=false or confirm with the user before calling edit_published_draft.",
          )
        }

        let draft
        try {
          draft = await store.get(id)
        } catch (error) {
          if (error instanceof DraftNotFoundError) return errorResult(error.message)
          throw error
        }

        const eligibility = validateEditEligibility(draft)
        if (!eligibility.ok) return errorResult(eligibility.error)

        const textValidation = validateXPostText(text, config.maxPostLength)
        if (!textValidation.ok) return errorResult(textValidation.error)

        if (draft.mediaPaths && draft.mediaPaths.length > 0) {
          const mediaValidation = await validateMediaPaths(draft.mediaPaths)
          if (!mediaValidation.ok) return errorResult(mediaValidation.error)
        }

        let tweetRequestStarted = false
        let tweet: CreatedTweet
        try {
          let mediaIds: string[] | undefined
          if (draft.mediaPaths && draft.mediaPaths.length > 0) {
            mediaIds = []
            for (const filePath of draft.mediaPaths) {
              mediaIds.push(await xClient.uploadMedia(filePath))
            }
          }

          const input: CreateTweetInput = {
            text,
            editPreviousPostId: draft.externalId,
          }
          if (mediaIds) input.mediaIds = mediaIds
          if (draft.quoteTweetId) input.quoteTweetId = draft.quoteTweetId
          // Preserve existing paidPartnership unless the caller overrides it.
          const nextPaidPartnership =
            paidPartnership !== undefined ? paidPartnership : draft.paidPartnership
          if (nextPaidPartnership !== undefined) input.paidPartnership = nextPaidPartnership

          tweetRequestStarted = true
          tweet = await xClient.createTweet(input)
        } catch (error) {
          if (!tweetRequestStarted) {
            // Media prep failed — edit was never requested; safe to report and retry later.
            return errorResult(
              `Editing draft "${id}" failed while preparing media (before any edit was sent): ${formatPublishError(error)}`,
            )
          }

          // Definitive API/auth failures: edit did not apply; local externalId stays valid.
          if (isDefinitiveFailure(error)) {
            return errorResult(formatPublishError(error))
          }

          // Network or unexpected errors after the request may mean the edit applied
          // (new post id on X) while we still hold the old externalId locally.
          const detail = error instanceof Error ? error.message : String(error)
          console.error(`edit_published_draft "${id}": edit outcome unknown:`, error)
          return errorResult(
            `Editing draft "${id}" failed after an edit request was sent, so it may or may not have applied: ${detail}\n\n` +
              "Check your X account before doing anything else. Do NOT retry edit_published_draft until you know the outcome — " +
              "a successful edit creates a new post id, and retrying with the old local externalId can fail or fork state. " +
              "If the edit did apply, note the new post URL and update the local draft record manually if needed.",
          )
        }

        try {
          const updated = await store.applyEdit(id, {
            text: tweet.text,
            externalId: tweet.id,
            url: tweet.url,
            // Only persist an explicit override; otherwise leave the stored flag alone.
            paidPartnership,
          })
          return textResult(`Edited on X: ${tweet.url}\n\n${JSON.stringify(updated, null, 2)}`)
        } catch (error) {
          console.error(`Edit ${tweet.id} succeeded but local record update failed:`, error)
          return textResult(
            `Edited on X: ${tweet.url}\n\n` +
              `WARNING: the edit is live, but updating the local draft record for "${id}" failed. ` +
              `Error: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }),
  )
}
