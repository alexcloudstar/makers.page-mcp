import { access, lstat, open } from "node:fs/promises"
import path from "node:path"
import type { CreateDraftInput, Draft, DraftPoll, UpdateDraftInput } from "../../drafts/types.js"

export type ValidationResult = { ok: true } | { ok: false; error: string }

// X shortens any URL to a fixed-width t.co link regardless of its real
// length. This is a best-effort match of X's URL matcher (scheme required,
// no spaces): good enough for local validation, not a full re-implementation
// of X's link parser. Known limitation: a URL with no surrounding whitespace
// (e.g. "seehttps://x.com") will be absorbed into the preceding word.
const URL_RE = /https?:\/\/\S+/gi
const TCO_WEIGHT = 23

// `\S+` in URL_RE is greedy and swallows trailing punctuation that's really
// part of the surrounding sentence, not the link itself (e.g. the "." in
// "see https://x.com." or the ")" in "(https://x.com)"). Strip it back off
// so it's still counted as ordinary text instead of silently disappearing.
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/

const splitTrailingPunctuation = (url: string): { url: string; trailing: string } => {
  const match = url.match(TRAILING_PUNCTUATION_RE)
  if (!match) return { url, trailing: "" }
  return { url: url.slice(0, url.length - match[0].length), trailing: match[0] }
}

/**
 * Approximates X's "weighted length" for a post: count by Unicode code point
 * (not UTF-16 code unit, so surrogate-pair characters like most emoji count
 * once instead of twice) and normalize any URL down to the fixed t.co
 * weight. This won't exactly match X's own algorithm (which also weights
 * some CJK/wide characters as 2), but it's much closer than raw
 * `string.length`, which both undercounts URLs and overcounts emoji.
 */
export const weightedLength = (text: string): number => {
  let urlCount = 0
  const withoutUrls = text.replace(URL_RE, (match) => {
    urlCount += 1
    // Put any trailing punctuation back so it's counted as plain text.
    return splitTrailingPunctuation(match).trailing
  })
  return [...withoutUrls].length + urlCount * TCO_WEIGHT
}

export const validateXPostText = (text: string, maxLength: number): ValidationResult => {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return { ok: false, error: "Post text cannot be empty." }
  }

  const length = weightedLength(trimmed)
  if (length > maxLength) {
    return {
      ok: false,
      error:
        `Post text is approximately ${length} characters (X's weighted count, treating each URL as ${TCO_WEIGHT}), ` +
        `which exceeds the ${maxLength} character limit.`,
    }
  }

  return { ok: true }
}

export type MediaCategory = "tweet_image" | "tweet_gif" | "tweet_video"

const MEDIA_LIMITS: Record<
  MediaCategory,
  { maxBytes: number; mimeTypes: readonly string[]; extensions: readonly string[] }
> = {
  tweet_image: {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: ["image/jpeg", "image/png", "image/webp"],
    extensions: [".jpg", ".jpeg", ".png", ".webp"],
  },
  tweet_gif: {
    maxBytes: 15 * 1024 * 1024,
    mimeTypes: ["image/gif"],
    extensions: [".gif"],
  },
  tweet_video: {
    maxBytes: 512 * 1024 * 1024,
    mimeTypes: ["video/mp4"],
    extensions: [".mp4"],
  },
}

const EXT_TO_CATEGORY: Record<string, MediaCategory> = {
  ".jpg": "tweet_image",
  ".jpeg": "tweet_image",
  ".png": "tweet_image",
  ".webp": "tweet_image",
  ".gif": "tweet_gif",
  ".mp4": "tweet_video",
}

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
}

const matchesMagicBytes = (ext: string, header: Buffer): boolean => {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    case ".png":
      return (
        header.length >= 8 &&
        header[0] === 0x89 &&
        header[1] === 0x50 &&
        header[2] === 0x4e &&
        header[3] === 0x47 &&
        header[4] === 0x0d &&
        header[5] === 0x0a &&
        header[6] === 0x1a &&
        header[7] === 0x0a
      )
    case ".gif":
      return (
        header.length >= 6 &&
        (header.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
          header.subarray(0, 6).equals(Buffer.from("GIF89a")))
      )
    case ".webp":
      return (
        header.length >= 12 &&
        header.subarray(0, 4).equals(Buffer.from("RIFF")) &&
        header.subarray(8, 12).equals(Buffer.from("WEBP"))
      )
    case ".mp4":
      return header.length >= 8 && header.subarray(4, 8).equals(Buffer.from("ftyp"))
    default:
      return false
  }
}

const verifyMediaMagicBytes = async (filePath: string, ext: string): Promise<ValidationResult> => {
  const handle = await open(filePath, "r")
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead === 0 || !matchesMagicBytes(ext, header.subarray(0, bytesRead))) {
      return {
        ok: false,
        error:
          `Media file "${filePath}" does not match the expected ${ext} format ` +
          "(content sniffing failed).",
      }
    }
    return { ok: true }
  } finally {
    await handle.close()
  }
}

/** Re-check symlink and magic bytes immediately before reading a file for upload. */
export const assertSafeMediaFileForUpload = async (filePath: string): Promise<void> => {
  const validation = await validateMediaPaths([filePath])
  if (!validation.ok) throw new Error(validation.error)
}

export const resolveMediaCategory = (
  filePath: string,
): { ok: true; category: MediaCategory; mimeType: string } | { ok: false; error: string } => {
  const ext = path.extname(filePath).toLowerCase()
  const category = EXT_TO_CATEGORY[ext]
  const mimeType = EXT_TO_MIME[ext]
  if (!category || !mimeType) {
    return {
      ok: false,
      error:
        `Unsupported media type for "${filePath}". Allowed extensions: ` +
        `${Object.keys(EXT_TO_CATEGORY).join(", ")}.`,
    }
  }
  return { ok: true, category, mimeType }
}

const validatePoll = (poll: DraftPoll): ValidationResult => {
  if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 4) {
    return { ok: false, error: "Poll must have between 2 and 4 options." }
  }
  for (const option of poll.options) {
    if (typeof option !== "string" || option.trim().length === 0) {
      return { ok: false, error: "Poll options cannot be empty." }
    }
    if ([...option].length > 25) {
      return { ok: false, error: "Each poll option must be at most 25 characters." }
    }
  }
  if (
    typeof poll.durationMinutes !== "number" ||
    !Number.isInteger(poll.durationMinutes) ||
    poll.durationMinutes < 5 ||
    poll.durationMinutes > 10080
  ) {
    return { ok: false, error: "Poll durationMinutes must be an integer between 5 and 10080." }
  }
  return { ok: true }
}

export const validateMediaPaths = async (mediaPaths: string[]): Promise<ValidationResult> => {
  if (mediaPaths.length === 0) {
    return { ok: false, error: "mediaPaths cannot be an empty array; omit it instead." }
  }
  if (mediaPaths.length > 4) {
    return { ok: false, error: "At most 4 media files are allowed per post." }
  }

  const categories: MediaCategory[] = []

  for (const filePath of mediaPaths) {
    if (!path.isAbsolute(filePath)) {
      return { ok: false, error: `Media path must be absolute: "${filePath}".` }
    }

    const resolved = resolveMediaCategory(filePath)
    if (!resolved.ok) return resolved
    categories.push(resolved.category)

    try {
      await access(filePath)
    } catch {
      return { ok: false, error: `Media file does not exist: "${filePath}".` }
    }

    let fileInfo
    try {
      fileInfo = await lstat(filePath)
    } catch {
      return { ok: false, error: `Media file does not exist: "${filePath}".` }
    }
    if (fileInfo.isSymbolicLink()) {
      return { ok: false, error: `Media path must not be a symbolic link: "${filePath}".` }
    }
    if (!fileInfo.isFile()) {
      return { ok: false, error: `Media path is not a file: "${filePath}".` }
    }
    if (fileInfo.size === 0) {
      return { ok: false, error: `Media file is empty: "${filePath}".` }
    }

    const limit = MEDIA_LIMITS[resolved.category]
    if (fileInfo.size > limit.maxBytes) {
      return {
        ok: false,
        error:
          `Media file "${filePath}" is ${fileInfo.size} bytes, which exceeds the ` +
          `${limit.maxBytes} byte limit for ${resolved.category}.`,
      }
    }

    const magicValidation = await verifyMediaMagicBytes(filePath, path.extname(filePath).toLowerCase())
    if (!magicValidation.ok) return magicValidation
  }

  const gifCount = categories.filter((c) => c === "tweet_gif").length
  const videoCount = categories.filter((c) => c === "tweet_video").length
  const imageCount = categories.filter((c) => c === "tweet_image").length

  if (gifCount > 1) {
    return { ok: false, error: "At most one GIF is allowed per post." }
  }
  if (videoCount > 1) {
    return { ok: false, error: "At most one video is allowed per post." }
  }
  if (gifCount > 0 && (imageCount > 0 || videoCount > 0)) {
    return { ok: false, error: "A GIF cannot be combined with images or video." }
  }
  if (videoCount > 0 && (imageCount > 0 || gifCount > 0)) {
    return { ok: false, error: "A video cannot be combined with images or GIFs." }
  }

  return { ok: true }
}

export type XDraftFields = {
  text: string
  poll?: DraftPoll
  mediaPaths?: string[]
  parts?: string[]
  quoteTweetId?: string
  communityId?: string
  shareWithFollowers?: boolean
  paidPartnership?: boolean
}

const validateDraftText = (
  input: Pick<XDraftFields, "text" | "parts">,
  maxLength: number,
  hasPoll: boolean,
): ValidationResult => {
  if (input.parts === undefined) {
    return validateXPostText(input.text, maxLength)
  }

  if (input.parts.length < 2) {
    return { ok: false, error: "parts must contain at least 2 items when set (otherwise use text alone)." }
  }

  if (input.parts[0] !== input.text) {
    return { ok: false, error: "text must equal parts[0] when parts is set." }
  }

  if (hasPoll) {
    return { ok: false, error: "Polls cannot be used on multi-part threads." }
  }

  for (const [index, part] of input.parts.entries()) {
    const partValidation = validateXPostText(part, maxLength)
    if (!partValidation.ok) {
      return { ok: false, error: `parts[${index}]: ${partValidation.error}` }
    }
  }

  return { ok: true }
}

export const validateXDraft = async (
  input: XDraftFields,
  maxLength: number,
): Promise<ValidationResult> => {
  const hasPoll = input.poll !== undefined
  const hasMedia = input.mediaPaths !== undefined && input.mediaPaths.length > 0
  const hasQuote = input.quoteTweetId !== undefined && input.quoteTweetId.length > 0

  const exclusiveCount = [hasPoll, hasMedia, hasQuote].filter(Boolean).length
  if (exclusiveCount > 1) {
    return {
      ok: false,
      error: "poll, mediaPaths, and quoteTweetId are mutually exclusive; use at most one.",
    }
  }

  if (input.shareWithFollowers && !input.communityId) {
    return { ok: false, error: "shareWithFollowers requires communityId." }
  }

  const textValidation = validateDraftText(input, maxLength, hasPoll)
  if (!textValidation.ok) return textValidation

  if (hasPoll) {
    const pollValidation = validatePoll(input.poll!)
    if (!pollValidation.ok) return pollValidation
  }

  if (hasMedia) {
    const mediaValidation = await validateMediaPaths(input.mediaPaths!)
    if (!mediaValidation.ok) return mediaValidation
  }

  if (hasQuote && input.quoteTweetId!.trim().length === 0) {
    return { ok: false, error: "quoteTweetId cannot be empty." }
  }

  if (input.communityId !== undefined && input.communityId.trim().length === 0) {
    return { ok: false, error: "communityId cannot be empty." }
  }

  return { ok: true }
}

/** Merge an update onto an existing draft for validation (null clears a field). */
export const mergeDraftFields = (
  current: Pick<
    Draft,
    | "text"
    | "poll"
    | "mediaPaths"
    | "parts"
    | "quoteTweetId"
    | "communityId"
    | "shareWithFollowers"
    | "paidPartnership"
  >,
  update: UpdateDraftInput,
): XDraftFields => {
  const applyOptional = <T>(currentValue: T | undefined, next: T | null | undefined): T | undefined => {
    if (next === undefined) return currentValue
    if (next === null) return undefined
    return next
  }

  let text = update.text !== undefined ? update.text : current.text
  let parts = applyOptional(current.parts, update.parts)
  // Keep text and parts[0] in sync the same way DraftStore.update does, so
  // a text-only update on a thread draft validates and persists cleanly.
  if (parts !== undefined && update.text !== undefined) {
    parts = [update.text, ...parts.slice(1)]
  } else if (parts !== undefined && update.text === undefined) {
    text = parts[0]!
  }

  return {
    text,
    poll: applyOptional(current.poll, update.poll),
    mediaPaths: applyOptional(current.mediaPaths, update.mediaPaths),
    parts,
    quoteTweetId: applyOptional(current.quoteTweetId, update.quoteTweetId),
    communityId: applyOptional(current.communityId, update.communityId),
    shareWithFollowers: applyOptional(current.shareWithFollowers, update.shareWithFollowers),
    paidPartnership: applyOptional(current.paidPartnership, update.paidPartnership),
  }
}

export const validateCreateDraftInput = async (
  input: CreateDraftInput,
  maxLength: number,
): Promise<ValidationResult> =>
  validateXDraft(
    {
      text: input.text,
      poll: input.poll,
      mediaPaths: input.mediaPaths,
      parts: input.parts,
      quoteTweetId: input.quoteTweetId,
      communityId: input.communityId,
      shareWithFollowers: input.shareWithFollowers,
      paidPartnership: input.paidPartnership,
    },
    maxLength,
  )

/**
 * Tool-level edit eligibility: only published drafts without poll/community
 * can be edited via the X edit API. Thread non-root parts are replies — we
 * only ever edit the root externalId.
 */
export const validateEditEligibility = (draft: Draft): ValidationResult => {
  if (draft.status !== "published") {
    return { ok: false, error: `Draft "${draft.id}" has status "${draft.status}"; only published drafts can be edited.` }
  }
  if (!draft.externalId) {
    return { ok: false, error: `Draft "${draft.id}" has no externalId to edit.` }
  }
  if (draft.poll) {
    return { ok: false, error: "Posts with polls cannot be edited." }
  }
  if (draft.communityId) {
    return { ok: false, error: "Community posts cannot be edited." }
  }
  return { ok: true }
}
