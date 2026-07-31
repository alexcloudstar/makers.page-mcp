export type ValidationResult = { ok: true } | { ok: false; error: string }

// X shortens any URL to a fixed-width t.co link regardless of its real
// length. This is a best-effort match of X's URL matcher (scheme required,
// no spaces) — good enough for local validation, not a full re-implementation
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
