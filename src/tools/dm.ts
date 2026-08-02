import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import type { DmDraft } from "../dm/types.js"
import {
  DmDraftStore,
  DmDraftNotFoundError,
  InvalidDmDraftTransitionError,
  withDmDraftLock,
} from "../dm/store.js"
import { DmRateLimiter, DmRateLimitError } from "../dm/rate-limit.js"
import {
  mergeDmDraftFields,
  validateCreateDmDraftInput,
  validateDmDraft,
  isGroupDraftTarget,
} from "../channels/x/dm-validate.js"
import {
  XApiError,
  XClient,
  NotAuthenticatedError,
} from "../channels/x/client.js"
import { validateMediaPaths } from "../channels/x/validate.js"
import { NetworkError } from "../util/fetch-with-timeout.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const formatDmDraft = (draft: DmDraft): string => JSON.stringify(draft, null, 2)

const formatSendError = (error: unknown): string => {
  if (error instanceof NotAuthenticatedError) return error.message
  if (error instanceof DmRateLimitError) return error.message
  if (error instanceof XApiError) {
    if (error.status === 429) {
      return "X API rate limit (429): " + error.message + ". Wait before retrying send_dm_draft."
    }
    return "X API error (" + error.status + "): " + error.message
  }
  if (error instanceof NetworkError) return error.message
  return error instanceof Error ? error.message : String(error)
}

const dmUserNotFoundError = (username: string): string => "X user @" + username + " was not found."

const dmRecipientBlockedError = (username: string): string =>
  "@" + username + " cannot receive DMs from your account (receives_your_dm=false)."

type DmParticipantLookup = { id: string } | { error: string }

const lookupDmParticipantId = async (
  xClient: Pick<XClient, "getUserByUsername">,
  username: string,
): Promise<DmParticipantLookup> => {
  try {
    const user = await xClient.getUserByUsername(username)
    if (user.receivesYourDm === false) {
      return { error: dmRecipientBlockedError(user.username) }
    }
    return { id: user.id }
  } catch (error) {
    if (error instanceof XApiError && error.status === 404) {
      return { error: dmUserNotFoundError(username) }
    }
    throw error
  }
}

const resolveUsernameIds = async (
  xClient: Pick<XClient, "getUserByUsername">,
  usernames: string[],
): Promise<{ ids: string[] } | { error: string }> => {
  const ids: string[] = []
  for (const username of usernames) {
    const lookup = await lookupDmParticipantId(xClient, username)
    if ("error" in lookup) return { error: lookup.error }
    ids.push(lookup.id)
  }
  return { ids }
}

const resolveRecipientId = async (
  xClient: Pick<XClient, "getUserByUsername">,
  draft: DmDraft,
): Promise<{ recipientId?: string; error?: string }> => {
  if (draft.recipientId) return { recipientId: draft.recipientId }
  if (!draft.recipientUsername) {
    return { error: "DM draft is missing recipientId and recipientUsername." }
  }

  const lookup = await lookupDmParticipantId(xClient, draft.recipientUsername)
  if ("error" in lookup) return { error: lookup.error }
  return { recipientId: lookup.id }
}

const resolveParticipantIds = async (
  xClient: Pick<XClient, "getUserByUsername">,
  draft: DmDraft,
): Promise<{ participantIds?: string[]; error?: string }> => {
  const ids = [...(draft.participantIds ?? [])]
  const usernames = draft.participantUsernames ?? []

  if (usernames.length > 0) {
    const resolved = await resolveUsernameIds(xClient, usernames)
    if ("error" in resolved) return { error: resolved.error }
    ids.push(...resolved.ids)
  }

  const unique = [...new Set(ids)]
  if (unique.length < 2) {
    return { error: "Group DMs need at least 2 unique participant ids after resolving usernames." }
  }
  return { participantIds: unique }
}

type SentDm = { dmEventId: string; dmConversationId: string }

type DmDeliveryResult =
  | { ok: true; sent: SentDm; recipientId?: string }
  | { ok: false; error: string }

const dmDraftSendBlockedReason = (
  id: string,
  draft: DmDraft,
  requireApproval: boolean,
): string | undefined => {
  if (draft.status === "sent") {
    return (
      'DM draft "' +
      id +
      '" was already sent (event ' +
      draft.dmEventId +
      ", conversation " +
      draft.dmConversationId +
      ")."
    )
  }
  if (draft.status === "deleted") {
    return 'DM draft "' + id + '" was deleted and cannot be sent.'
  }
  if (draft.status === "sending") {
    return (
      'DM draft "' +
      id +
      '" is already being sent (or a previous attempt was interrupted). Check X manually before retrying.'
    )
  }
  if (draft.status !== "approved" && requireApproval) {
    return (
      'DM draft "' +
      id +
      '" has status "' +
      draft.status +
      '". Approve it with approve_dm_draft before sending.'
    )
  }
  return undefined
}

const dmDraftUpdateBlockedReason = (id: string, draft: DmDraft): string | undefined => {
  if (draft.status === "sent") {
    return 'DM draft "' + id + '" was already sent and cannot be updated.'
  }
  if (draft.status === "deleted") {
    return 'DM draft "' + id + '" was deleted and cannot be updated.'
  }
  if (draft.status === "sending") {
    return 'DM draft "' + id + '" is currently being sent. Wait or reconcile manually.'
  }
  return undefined
}

const deliverDmMessage = async (
  xClient: Pick<
    XClient,
    | "getUserByUsername"
    | "sendDmByParticipantId"
    | "sendDmByConversationId"
    | "createGroupDmConversation"
  >,
  draft: DmDraft,
  messageInput: { text: string; mediaIds?: string[] },
): Promise<DmDeliveryResult> => {
  if (draft.conversationId) {
    const sent = await xClient.sendDmByConversationId(draft.conversationId, messageInput)
    return { ok: true, sent, recipientId: draft.recipientId }
  }

  if (isGroupDraftTarget(draft)) {
    const resolved = await resolveParticipantIds(xClient, draft)
    if (resolved.error) return { ok: false, error: resolved.error }
    const sent = await xClient.createGroupDmConversation(resolved.participantIds!, messageInput)
    return { ok: true, sent, recipientId: draft.recipientId }
  }

  const resolved = await resolveRecipientId(xClient, draft)
  if (resolved.error) return { ok: false, error: resolved.error }
  const sent = await xClient.sendDmByParticipantId(resolved.recipientId!, messageInput)
  return { ok: true, sent, recipientId: resolved.recipientId }
}

type DmToolDeps = {
  store?: DmDraftStore
  rateLimiter?: DmRateLimiter
  xClient?: Pick<
    XClient,
    | "getUserByUsername"
    | "sendDmByParticipantId"
    | "sendDmByConversationId"
    | "createGroupDmConversation"
    | "listDmEventsByParticipant"
    | "listDmEventsByConversationId"
    | "listDmInbox"
    | "uploadMedia"
  >
}

export const registerDmTools = (server: McpServer, config: Config, deps: DmToolDeps = {}): void => {
  const store = deps.store ?? new DmDraftStore(config)
  const rateLimiter = deps.rateLimiter ?? new DmRateLimiter(config)
  const xClient = deps.xClient ?? new XClient(config)

  server.registerTool(
    "lookup_x_user",
    {
      title: "Look up X user",
      description:
        "Resolve an X @handle to a user id (and whether they can receive DMs from you). Useful before create_dm_draft.",
      inputSchema: {
        username: z.string().meta({ description: "X username, with or without leading @." }),
      },
    },
    async ({ username }) => {
      try {
        const user = await xClient.getUserByUsername(username)
        const dmNote =
          user.receivesYourDm === false
            ? "Cannot receive DMs from your account."
            : user.receivesYourDm === true
              ? "Can receive DMs from your account."
              : "DM eligibility unknown (receives_your_dm not returned)."
        return textResult("@" + user.username + " (" + user.name + ")\nid: " + user.id + "\n" + dmNote)
      } catch (error) {
        if (error instanceof NotAuthenticatedError) return errorResult(error.message)
        if (error instanceof XApiError && error.status === 404) {
          return errorResult("X user @" + username.replace(/^@/, "") + " was not found.")
        }
        if (error instanceof XApiError) {
          return errorResult("X API error (" + error.status + "): " + error.message)
        }
        throw error
      }
    },
  )

  server.registerTool(
    "get_dm_rate_limit",
    {
      title: "Get DM rate limit status",
      description:
        "Show local DM send rate limits and current usage (hourly, daily, min interval between sends).",
      inputSchema: {},
    },
    async () => {
      const snapshot = await rateLimiter.snapshot()
      return textResult(
        "DM rate limits (local):\n" +
          "- " +
          snapshot.sentLastHour +
          "/" +
          snapshot.maxPerHour +
          " sent in the last hour\n" +
          "- " +
          snapshot.sentLastDay +
          "/" +
          snapshot.maxPerDay +
          " sent in the last 24 hours\n" +
          "- min interval: " +
          snapshot.minIntervalMs +
          "ms between sends",
      )
    },
  )

  server.registerTool(
    "create_dm_draft",
    {
      title: "Create DM draft",
      description:
        "Create a draft direct message. Requires recipientId or recipientUsername (or conversationId for an existing thread). " +
        "NOT sent until approved and send_dm_draft is called. Supports one optional media attachment.",
      inputSchema: {
        text: z.string().meta({ description: "DM message text." }),
        conversationType: z
          .enum(["direct", "group"])
          .optional()
          .meta({ description: "direct (default) for 1:1, group for new group conversations." }),
        recipientId: z.string().optional().meta({ description: "1:1 recipient X user id." }),
        recipientUsername: z
          .string()
          .optional()
          .meta({ description: "1:1 recipient @handle (resolved at send time if id omitted)." }),
        participantIds: z
          .array(z.string())
          .min(2)
          .optional()
          .meta({ description: "Group: 2+ participant user ids (new group only)." }),
        participantUsernames: z
          .array(z.string())
          .min(2)
          .optional()
          .meta({ description: "Group: 2+ @handles resolved at send time (new group only)." }),
        conversationId: z
          .string()
          .optional()
          .meta({ description: "Existing conversation id (reply in 1:1 or group thread)." }),
        mediaPaths: z
          .array(z.string())
          .min(1)
          .max(1)
          .optional()
          .meta({ description: "Absolute local path for one media attachment." }),
      },
    },
    async ({
      text,
      conversationType,
      recipientId,
      recipientUsername,
      participantIds,
      participantUsernames,
      conversationId,
      mediaPaths,
    }) => {
      const input = {
        text,
        conversationType,
        recipientId,
        recipientUsername,
        participantIds,
        participantUsernames,
        conversationId,
        mediaPaths,
      }
      const validation = await validateCreateDmDraftInput(input, config.maxDmLength)
      if (!validation.ok) return errorResult(validation.error)

      const draft = await store.create(input)
      return textResult(
        "DM draft created (status: draft). Show this to the user for approval before sending.\n\n" +
          formatDmDraft(draft),
      )
    },
  )

  server.registerTool(
    "list_dm_drafts",
    {
      title: "List DM drafts",
      description: "List locally stored DM drafts, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["draft", "approved", "rejected", "sending", "sent", "deleted"])
          .optional()
          .meta({ description: "Only return drafts with this status." }),
      },
    },
    async ({ status }) => {
      const drafts = await store.list(status)
      if (drafts.length === 0) return textResult("No DM drafts found.")
      return textResult(drafts.map(formatDmDraft).join("\n\n"))
    },
  )

  server.registerTool(
    "get_dm_draft",
    {
      title: "Get DM draft",
      description: "Fetch a single DM draft by id.",
      inputSchema: { id: z.string().meta({ description: "DM draft id." }) },
    },
    async ({ id }) => {
      try {
        const draft = await store.get(id)
        return textResult(formatDmDraft(draft))
      } catch (error) {
        if (error instanceof DmDraftNotFoundError) return errorResult(error.message)
        throw error
      }
    },
  )

  server.registerTool(
    "update_dm_draft",
    {
      title: "Update DM draft",
      description:
        "Edit a DM draft. Pass null to clear optional fields. Resets approved drafts back to draft status.",
      inputSchema: {
        id: z.string().meta({ description: "DM draft id." }),
        text: z.string().optional().meta({ description: "New message text." }),
        conversationType: z
          .enum(["direct", "group"])
          .nullable()
          .optional()
          .meta({ description: "Conversation type, or null to clear." }),
        recipientId: z.string().nullable().optional().meta({ description: "Recipient user id, or null to clear." }),
        recipientUsername: z
          .string()
          .nullable()
          .optional()
          .meta({ description: "Recipient @handle, or null to clear." }),
        participantIds: z
          .array(z.string())
          .min(2)
          .nullable()
          .optional()
          .meta({ description: "Group participant ids, or null to clear." }),
        participantUsernames: z
          .array(z.string())
          .min(2)
          .nullable()
          .optional()
          .meta({ description: "Group @handles, or null to clear." }),
        conversationId: z
          .string()
          .nullable()
          .optional()
          .meta({ description: "Conversation id, or null to clear." }),
        mediaPaths: z
          .array(z.string())
          .min(1)
          .max(1)
          .nullable()
          .optional()
          .meta({ description: "One media path, or null to clear." }),
      },
    },
    async ({
      id,
      text,
      conversationType,
      recipientId,
      recipientUsername,
      participantIds,
      participantUsernames,
      conversationId,
      mediaPaths,
    }) =>
      withDmDraftLock(id, async () => {
        let current: DmDraft
        try {
          current = await store.get(id)
        } catch (error) {
          if (error instanceof DmDraftNotFoundError) return errorResult(error.message)
          throw error
        }

        const updateBlockedReason = dmDraftUpdateBlockedReason(id, current)
        if (updateBlockedReason) return errorResult(updateBlockedReason)

        const update = {
          text,
          conversationType,
          recipientId,
          recipientUsername,
          participantIds,
          participantUsernames,
          conversationId,
          mediaPaths,
        }
        const hasUpdate = Object.values(update).some((value) => value !== undefined)
        if (!hasUpdate) {
          return errorResult("update_dm_draft requires at least one field to change.")
        }

        const merged = mergeDmDraftFields(current, update)
        const validation = await validateDmDraft(merged, config.maxDmLength)
        if (!validation.ok) return errorResult(validation.error)

        try {
          const draft = await store.update(id, update)
          return textResult(formatDmDraft(draft))
        } catch (error) {
          if (error instanceof InvalidDmDraftTransitionError) return errorResult(error.message)
          throw error
        }
      }),
  )

  server.registerTool(
    "approve_dm_draft",
    {
      title: "Approve DM draft",
      description:
        "Mark a DM draft approved. Only approved drafts can be sent. Call only after the user explicitly reviewed the message.",
      inputSchema: { id: z.string().meta({ description: "DM draft id." }) },
    },
    async ({ id }) =>
      withDmDraftLock(id, async () => {
        try {
          const draft = await store.approve(id)
          return textResult("DM draft approved. It can now be sent.\n\n" + formatDmDraft(draft))
        } catch (error) {
          if (error instanceof DmDraftNotFoundError || error instanceof InvalidDmDraftTransitionError) {
            return errorResult(error.message)
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "reject_dm_draft",
    {
      title: "Reject DM draft",
      description: "Mark a DM draft rejected. Also usable to reconcile a draft stuck in sending after a failed attempt.",
      inputSchema: { id: z.string().meta({ description: "DM draft id." }) },
    },
    async ({ id }) =>
      withDmDraftLock(id, async () => {
        try {
          const draft = await store.reject(id)
          return textResult("DM draft rejected.\n\n" + formatDmDraft(draft))
        } catch (error) {
          if (error instanceof DmDraftNotFoundError || error instanceof InvalidDmDraftTransitionError) {
            return errorResult(error.message)
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "send_dm_draft",
    {
      title: "Send DM draft",
      description:
        "Send an approved DM draft via the X API. Enforces local rate limits (hourly, daily, min interval). " +
        "Requires dm.read and dm.write scopes (re-auth after upgrade).",
      inputSchema: { id: z.string().meta({ description: "DM draft id." }) },
    },
    async ({ id }) =>
      withDmDraftLock(id, async () => {
        let draft: DmDraft
        try {
          draft = await store.get(id)
        } catch (error) {
          if (error instanceof DmDraftNotFoundError) return errorResult(error.message)
          throw error
        }

        const sendBlockedReason = dmDraftSendBlockedReason(id, draft, config.requireApproval)
        if (sendBlockedReason) return errorResult(sendBlockedReason)

        if (draft.mediaPaths && draft.mediaPaths.length > 0) {
          const mediaValidation = await validateMediaPaths(draft.mediaPaths)
          if (!mediaValidation.ok) return errorResult(mediaValidation.error)
        }

        const statusBeforeSend = draft.status
        await store.beginSending(id)

        try {
          let mediaIds: string[] | undefined
          if (draft.mediaPaths && draft.mediaPaths.length > 0) {
            mediaIds = [await xClient.uploadMedia(draft.mediaPaths[0]!)]
          }

          try {
            await rateLimiter.reserveSendSlot()
          } catch (error) {
            if (error instanceof DmRateLimitError) {
              await store.revertSending(id, statusBeforeSend)
              return errorResult(error.message)
            }
            throw error
          }

          const messageInput = { text: draft.text, mediaIds }
          const delivery = await deliverDmMessage(xClient, draft, messageInput)
          if (!delivery.ok) {
            await store.revertSending(id, statusBeforeSend)
            return errorResult(delivery.error)
          }

          const { sent, recipientId: resolvedRecipientId } = delivery

          try {
            const updated = await store.markSent(id, {
              dmEventId: sent.dmEventId,
              dmConversationId: sent.dmConversationId,
              recipientId: resolvedRecipientId,
            })

            return textResult(
              "DM sent.\n" +
                "event id: " +
                sent.dmEventId +
                "\n" +
                "conversation id: " +
                sent.dmConversationId +
                "\n\n" +
                formatDmDraft(updated),
            )
          } catch (error) {
            console.error(
              'DM event "' +
                sent.dmEventId +
                '" was sent but the local draft record for "' +
                id +
                '" could not be updated:',
              error,
            )
            return textResult(
              "DM sent.\n" +
                "event id: " +
                sent.dmEventId +
                "\n" +
                "conversation id: " +
                sent.dmConversationId +
                "\n\n" +
                "WARNING: the DM is live, but updating the local draft record failed. " +
                "Verify manually and do not retry send_dm_draft for this draft. Error: " +
                (error instanceof Error ? error.message : String(error)),
            )
          }
        } catch (error) {
          if (error instanceof NotAuthenticatedError || error instanceof XApiError) {
            await store.revertSending(id, statusBeforeSend)
            return errorResult(formatSendError(error))
          }
          if (error instanceof NetworkError) {
            console.error('send_dm_draft "' + id + '": network error, leaving draft in "sending":', error)
            return errorResult(
              'Sending DM draft "' +
                id +
                '" failed with a network error; outcome unknown: ' +
                error.message +
                '\nDraft left in "sending". Check X manually before retrying.',
            )
          }
          await store.revertSending(id, statusBeforeSend)
          return errorResult(formatSendError(error))
        }
      }),
  )

  server.registerTool(
    "list_dm_events",
    {
      title: "List DM events",
      description:
        "Read recent DM events in a 1:1 conversation with a participant (newest first, up to 100). Requires dm.read scope.",
      inputSchema: {
        participantId: z.string().optional().meta({ description: "Participant X user id." }),
        username: z.string().optional().meta({ description: "Participant @handle (used if participantId omitted)." }),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .meta({ description: "Max events to return (default 20, max 100)." }),
      },
    },
    async ({ participantId, username, maxResults }) => {
      if (!participantId && !username) {
        return errorResult("Provide participantId or username.")
      }

      try {
        let resolvedId = participantId
        if (!resolvedId && username) {
          const user = await xClient.getUserByUsername(username)
          resolvedId = user.id
        }

        const events = await xClient.listDmEventsByParticipant(resolvedId!, maxResults ?? 20)
        if (events.length === 0) return textResult("No DM events found for this conversation.")
        return textResult(JSON.stringify(events, null, 2))
      } catch (error) {
        if (error instanceof NotAuthenticatedError) return errorResult(error.message)
        if (error instanceof XApiError && error.status === 404) {
          return errorResult("Conversation or user not found.")
        }
        if (error instanceof XApiError) {
          return errorResult("X API error (" + error.status + "): " + error.message)
        }
        throw error
      }
    },
  )

  server.registerTool(
    "list_dm_inbox",
    {
      title: "List DM inbox",
      description:
        "Read recent DM events across all conversations (inbox view). Requires dm.read scope.",
      inputSchema: {
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .meta({ description: "Max events to return (default 20, max 100)." }),
      },
    },
    async ({ maxResults }) => {
      try {
        const events = await xClient.listDmInbox(maxResults ?? 20)
        if (events.length === 0) return textResult("No DM events in inbox.")
        return textResult(JSON.stringify(events, null, 2))
      } catch (error) {
        if (error instanceof NotAuthenticatedError) return errorResult(error.message)
        if (error instanceof XApiError) {
          return errorResult("X API error (" + error.status + "): " + error.message)
        }
        throw error
      }
    },
  )

  server.registerTool(
    "list_dm_conversation_events",
    {
      title: "List DM conversation events",
      description:
        "Read recent DM events in a conversation by conversationId (works for group and 1:1 threads).",
      inputSchema: {
        conversationId: z.string().meta({ description: "DM conversation id." }),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .meta({ description: "Max events to return (default 20, max 100)." }),
      },
    },
    async ({ conversationId, maxResults }) => {
      try {
        const events = await xClient.listDmEventsByConversationId(conversationId, maxResults ?? 20)
        if (events.length === 0) return textResult("No DM events found for this conversation.")
        return textResult(JSON.stringify(events, null, 2))
      } catch (error) {
        if (error instanceof NotAuthenticatedError) return errorResult(error.message)
        if (error instanceof XApiError && error.status === 404) {
          return errorResult("Conversation not found.")
        }
        if (error instanceof XApiError) {
          return errorResult("X API error (" + error.status + "): " + error.message)
        }
        throw error
      }
    },
  )

}
