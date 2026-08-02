import type { CreateDmDraftInput, DmDraft, UpdateDmDraftInput } from "../../dm/types.js"
import { validateMediaPaths } from "./validate.js"

export type ValidationResult = { ok: true } | { ok: false; error: string }

export const DEFAULT_MAX_DM_LENGTH = 10_000

const normalizeUsername = (username: string): string => username.replace(/^@/, "").trim()

export const validateDmText = (text: string, maxLength: number): ValidationResult => {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: "DM text cannot be empty." }
  }
  if ([...trimmed].length > maxLength) {
    return {
      ok: false,
      error: `DM text is ${[...trimmed].length} characters, which exceeds the ${maxLength} character limit.`,
    }
  }
  return { ok: true }
}

export const validateRecipient = (input: {
  recipientId?: string
  recipientUsername?: string
  conversationId?: string
}): ValidationResult => {
  const hasRecipient = Boolean(input.recipientId || input.recipientUsername)
  if (!hasRecipient && !input.conversationId) {
    return {
      ok: false,
      error: "Provide recipientId or recipientUsername (or conversationId to reply in an existing thread).",
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
  recipientId:
    update.recipientId === null ? undefined : update.recipientId ?? current.recipientId,
  recipientUsername:
    update.recipientUsername === null
      ? undefined
      : update.recipientUsername
        ? normalizeUsername(update.recipientUsername)
        : current.recipientUsername,
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
