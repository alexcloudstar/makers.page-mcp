export type ValidationResult = { ok: true } | { ok: false; error: string }

export const validateXPostText = (text: string, maxLength: number): ValidationResult => {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return { ok: false, error: "Post text cannot be empty." }
  }

  if (trimmed.length > maxLength) {
    return {
      ok: false,
      error: `Post text is ${trimmed.length} characters, which exceeds the ${maxLength} character limit.`,
    }
  }

  return { ok: true }
}
