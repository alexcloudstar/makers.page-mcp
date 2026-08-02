const TWEET_ID_RE = /^\d{1,25}$/

export const normalizeTweetId = (raw: string): string => raw.trim()

export const validateTweetId = (tweetId: string): { ok: true; tweetId: string } | { ok: false; error: string } => {
  const normalized = normalizeTweetId(tweetId)
  if (!TWEET_ID_RE.test(normalized)) {
    return {
      ok: false,
      error:
        `Invalid tweet id "${tweetId}". Expected a numeric post id from an X URL ` +
        `(e.g. https://x.com/user/status/1234567890 → 1234567890).`,
    }
  }
  return { ok: true, tweetId: normalized }
}
