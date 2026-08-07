import type { RawSignal } from "./types.js"

const SPAM_PATTERNS = [
  /\brt\s+to\s+win\b/i,
  /\bgiveaway\b/i,
  /\bfollow\s+(me|us)\s+(and|to)?\s*(rt|retweet)\b/i,
  /\bfollow\s+for\s+follow\b/i,
  /\btag\s+\d+\s+friends?\b/i,
]

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu
const MAX_HASHTAGS = 5
const MAX_EMOJI = 6
const SIMILARITY_THRESHOLD = 0.85

const countHashtags = (text: string): number => (text.match(/#\w+/g) ?? []).length
const countEmoji = (text: string): number => (text.match(EMOJI_REGEX) ?? []).length

const isShouting = (text: string): boolean => {
  const letters = text.replace(/[^a-zA-Z]/g, "")
  if (letters.length < 15) return false
  const upper = letters.replace(/[^A-Z]/g, "")
  return upper.length / letters.length > 0.7
}

export const isLikelySpam = (text: string): boolean => {
  if (SPAM_PATTERNS.some((pattern) => pattern.test(text))) return true
  if (countHashtags(text) > MAX_HASHTAGS) return true
  if (countEmoji(text) > MAX_EMOJI) return true
  if (isShouting(text)) return true
  return false
}

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@\w+/g, "")
    .replace(/#\w+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()

const shingles = (text: string, size = 3): Set<string> => {
  const words = text.split(" ").filter(Boolean)
  const result = new Set<string>()
  for (let i = 0; i <= words.length - size; i++) {
    result.add(words.slice(i, i + size).join(" "))
  }
  if (result.size === 0 && words.length > 0) result.add(words.join(" "))
  return result
}

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const value of a) {
    if (b.has(value)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

const engagementScore = (signal: RawSignal): number =>
  signal.metrics.likes + signal.metrics.reposts * 2 + signal.metrics.replies * 1.5 + signal.metrics.quotes * 1.5

type DedupeEntry = { signal: RawSignal; shingles: Set<string>; normalized: string }

export const dedupeNearDuplicates = (signals: RawSignal[]): RawSignal[] => {
  const kept: DedupeEntry[] = []

  for (const signal of signals) {
    const normalized = normalizeText(signal.text)
    const signalShingles = shingles(normalized)
    const duplicate = kept.find(
      (entry) =>
        entry.normalized === normalized || jaccardSimilarity(entry.shingles, signalShingles) > SIMILARITY_THRESHOLD,
    )

    if (!duplicate) {
      kept.push({ signal, shingles: signalShingles, normalized })
      continue
    }

    if (engagementScore(signal) > engagementScore(duplicate.signal)) {
      duplicate.signal = signal
      duplicate.shingles = signalShingles
      duplicate.normalized = normalized
    }
  }

  return kept.map((entry) => entry.signal)
}

export const filterSpamAndDuplicates = (signals: RawSignal[]): RawSignal[] => {
  const notSpam = signals.filter((signal) => !isLikelySpam(signal.text))
  return dedupeNearDuplicates(notSpam)
}
