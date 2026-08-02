import type {
  CreateDmDraftInput,
  DmConversationType,
  DmDraft,
  UpdateDmDraftInput,
} from "../../dm/types.js"
import { validateMediaPaths } from "./validate.js"

export type ValidationResult = { ok: true } | { ok: false; error: string }

const normalizeUsername = (username: string): string => username.replace(/^@/, "").trim()

export const isGroupDraftTarget = (input: {
  conversationType?: DmConversationType
  participantIds?: string[]
  participantUsernames?: string[]
}): boolean =>
  input.conversationType === "group" ||
  (input.participantIds !== undefined && input.participantIds.length >= 2) ||
  (input.participantUsernames !== undefined && input.participantUsernames.length >= 2)

export const validateDmText = (text: string, maxLength: number): ValidationResult => {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: "DM text cannot be empty." }
  }
  if ([...trimmed].length > maxLength) {
    return {
      ok: false,
      error: "DM text is " + [...trimmed].length + " characters, which exceeds the " + maxLength + " character limit.",
    }
  }
  return { ok: true }
}

export const validateRecipient = (input: {
  conversationType?: DmConversationType
  recipientId?: string
  recipientUsername?: string
  participantIds?: string[]
  participantUsernames?: string[]
  conversationId?: string
}): ValidationResult => {
  if (input.conversationId) {
    return { ok: true }
  }

  if (isGroupDraftTarget(input)) {
    const idCount = input.participantIds?.length ?? 0
    const nameCount = input.participantUsernames?.length ?? 0
    if (idCount + nameCount < 2) {
      return {
        ok: false,
        error: "Group DMs need at least 2 participantIds or participantUsernames.",
      }
    }
    if (input.recipientId || input.recipientUsername) {
      return {
        ok: false,
        error: "Group drafts use participantIds/participantUsernames, not recipientId/recipientUsername.",
      }
    }
    return { ok: true }
  }

  const hasRecipient = Boolean(input.recipientId || input.recipientUsername)
  if (!hasRecipient) {
    return {
      ok: false,
      error:
        "Provide recipientId or recipientUsername (1:1), participantIds/participantUsernames (group), or conversationId (reply).",
    }
  }
  if (input.recipientUsername && normalizeUsername(input.recipientUsername).length === 0) {
    return { ok: false, error: "recipientUsername cannot be empty." }
  }
  return { ok: true }
}

export const validateCreateDmDraftInput = async (
  input: CreateDmDraftInput,
  maxLength: number,
): Promise<ValidationResult> => {
  const textValidation = validateDmText(input.text, maxLength)
  if (!textValidation.ok) return textValidation

  const recipientValidation = validateRecipient(input)
  if (!recipientValidation.ok) return recipientValidation

  if (input.mediaPaths && input.mediaPaths.length > 0) {
    const mediaValidation = await validateMediaPaths(input.mediaPaths)
    if (!mediaValidation.ok) return mediaValidation
    if (input.mediaPaths.length > 1) {
      return { ok: false, error: "DM drafts support at most one media attachment." }
    }
  }

  return { ok: true }
}

export const mergeDmDraftFields = (current: DmDraft, update: UpdateDmDraftInput): DmDraft => ({
  ...current,
  text: update.text ?? current.text,
  conversationType:
    update.conversationType === null ? undefined : update.conversationType ?? current.conversationType,
  recipientId:
    update.recipientId === null ? undefined : update.recipientId ?? current.recipientId,
  recipientUsername:
    update.recipientUsername === null
      ? undefined
      : update.recipientUsername
        ? normalizeUsername(update.recipientUsername)
        : current.recipientUsername,
  participantIds:
    update.participantIds === null ? undefined : update.participantIds ?? current.participantIds,
  participantUsernames:
    update.participantUsernames === null
      ? undefined
      : update.participantUsernames
        ? update.participantUsernames.map(normalizeUsername)
        : current.participantUsernames,
  conversationId:
    update.conversationId === null ? undefined : update.conversationId ?? current.conversationId,
  mediaPaths:
    update.mediaPaths === null
      ? undefined
      : update.mediaPaths !== undefined
        ? update.mediaPaths
        : current.mediaPaths,
})

export const validateDmDraft = async (draft: DmDraft, maxLength: number): Promise<ValidationResult> => {
  const textValidation = validateDmText(draft.text, maxLength)
  if (!textValidation.ok) return textValidation

  const recipientValidation = validateRecipient(draft)
  if (!recipientValidation.ok) return recipientValidation

  if (draft.mediaPaths && draft.mediaPaths.length > 0) {
    const mediaValidation = await validateMediaPaths(draft.mediaPaths)
    if (!mediaValidation.ok) return mediaValidation
    if (draft.mediaPaths.length > 1) {
      return { ok: false, error: "DM drafts support at most one media attachment." }
    }
  }

  return { ok: true }
}
