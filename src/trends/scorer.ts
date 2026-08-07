import type { Growth, RawSignal, SampleTweet, TrendingTopic } from "./types.js"

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of", "in", "on", "for", "with", "at", "by",
  "from", "up", "about", "into", "over", "after", "is", "are", "was", "were", "be", "been", "being", "this",
  "that", "these", "those", "it", "its", "i", "you", "he", "she", "we", "they", "my", "your", "our", "their",
  "not", "no", "just", "have", "has", "had", "will", "would", "can", "could", "should", "do", "does", "did",
  "as", "out", "all", "also", "more", "most", "some", "any", "what", "when", "where", "how", "why", "who",
  "which", "get", "got", "like", "one", "new", "need", "using", "via", "vs",
])

const HASHTAG_REGEX = /#[a-zA-Z][\w-]{1,39}/g
const CASHTAG_REGEX = /\$[A-Za-z]{1,6}\b/g
const CAPITALIZED_PHRASE_REGEX = /\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){1,2}\b/g

type CandidateTopic = { key: string; label: string }

const cleanWordsForNgrams = (text: string): string[] =>
  text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#$][\w-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()) && !/^\d+$/.test(word))

const extractNgramCandidates = (text: string): CandidateTopic[] => {
  const words = cleanWordsForNgrams(text)
  const candidates: CandidateTopic[] = []
  for (const word of words) {
    candidates.push({ key: word.toLowerCase(), label: word.toLowerCase() })
  }
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`
    candidates.push({ key: bigram.toLowerCase(), label: bigram.toLowerCase() })
  }
  return candidates
}

/** Extracts recurring-phrase/hashtag/cashtag/n-gram candidates from a single signal's text. */
export const extractCandidateTopics = (text: string): CandidateTopic[] => {
  const candidates: CandidateTopic[] = []

  for (const match of text.match(HASHTAG_REGEX) ?? []) {
    candidates.push({ key: match.toLowerCase(), label: match })
  }
  for (const match of text.match(CASHTAG_REGEX) ?? []) {
    candidates.push({ key: match.toLowerCase(), label: match.toUpperCase() })
  }
  for (const match of text.match(CAPITALIZED_PHRASE_REGEX) ?? []) {
    candidates.push({ key: match.toLowerCase(), label: match })
  }
  candidates.push(...extractNgramCandidates(text))

  return candidates
}

const HOURS_MS = 60 * 60 * 1000
const VELOCITY_HALF_LIFE_HOURS = 6
const MIN_TOPIC_FREQUENCY = 2
const MAX_TOPICS = 10
const MAX_SAMPLE_TWEETS = 3

const WEIGHTS = {
  frequency: 0.25,
  engagement: 0.35,
  velocity: 0.3,
  uniqueness: 0.1,
}

const engagementScore = (signal: RawSignal): number =>
  signal.metrics.likes + signal.metrics.reposts * 2 + signal.metrics.replies * 1.5 + signal.metrics.quotes * 1.5

const recencyWeight = (signal: RawSignal, now: Date): number => {
  const createdAt = new Date(signal.createdAt).getTime()
  const hoursAgo = Math.max(0, (now.getTime() - createdAt) / HOURS_MS)
  return Math.exp(-hoursAgo / VELOCITY_HALF_LIFE_HOURS)
}

const normalize = (value: number, min: number, max: number): number =>
  max === min ? (max === 0 ? 0 : 1) : (value - min) / (max - min)

const toSampleTweets = (signals: RawSignal[]): SampleTweet[] =>
  [...signals]
    .sort((a, b) => engagementScore(b) - engagementScore(a))
    .slice(0, MAX_SAMPLE_TWEETS)
    .map((signal) => ({ text: signal.text, url: signal.url, author: signal.author, metrics: signal.metrics }))

const classifyGrowth = (velocityNorm: number): Growth => {
  if (velocityNorm >= 0.75) return "exploding"
  if (velocityNorm >= 0.5) return "rising"
  if (velocityNorm >= 0.25) return "stable"
  return "fading"
}

const computeConfidence = (tweetCount: number): number => Math.round(100 * (1 - 1 / (1 + tweetCount)))

type TopicAggregate = { key: string; label: string; signals: RawSignal[] }

/**
 * Ranks recurring topics by frequency + engagement + recency-weighted velocity + uniqueness.
 * `alsoTrendingGlobally` is always false here; annotateWithGlobalTrends fills it in separately.
 */
export const scoreTrends = (signals: RawSignal[], now: Date): TrendingTopic[] => {
  const aggregates = new Map<string, TopicAggregate>()

  for (const signal of signals) {
    const seenKeys = new Set<string>()
    for (const candidate of extractCandidateTopics(signal.text)) {
      if (seenKeys.has(candidate.key)) continue
      seenKeys.add(candidate.key)

      const existing = aggregates.get(candidate.key)
      if (existing) {
        existing.signals.push(signal)
      } else {
        aggregates.set(candidate.key, { key: candidate.key, label: candidate.label, signals: [signal] })
      }
    }
  }

  const qualifying = [...aggregates.values()].filter((topic) => topic.signals.length >= MIN_TOPIC_FREQUENCY)
  if (qualifying.length === 0) return []

  const totalSignals = signals.length
  const metrics = qualifying.map((topic) => {
    const frequency = topic.signals.length
    const engagement = topic.signals.reduce((sum, signal) => sum + engagementScore(signal), 0)
    const velocity = topic.signals.reduce((sum, signal) => sum + engagementScore(signal) * recencyWeight(signal, now), 0)
    const uniqueness = 1 - frequency / totalSignals
    return { topic, frequency, engagement, velocity, uniqueness }
  })

  const ranges = {
    frequency: [Math.min(...metrics.map((m) => m.frequency)), Math.max(...metrics.map((m) => m.frequency))] as const,
    engagement: [Math.min(...metrics.map((m) => m.engagement)), Math.max(...metrics.map((m) => m.engagement))] as const,
    velocity: [Math.min(...metrics.map((m) => m.velocity)), Math.max(...metrics.map((m) => m.velocity))] as const,
    uniqueness: [Math.min(...metrics.map((m) => m.uniqueness)), Math.max(...metrics.map((m) => m.uniqueness))] as const,
  }

  const scored: TrendingTopic[] = metrics.map((m) => {
    const frequencyNorm = normalize(m.frequency, ...ranges.frequency)
    const engagementNorm = normalize(m.engagement, ...ranges.engagement)
    const velocityNorm = normalize(m.velocity, ...ranges.velocity)
    const uniquenessNorm = normalize(m.uniqueness, ...ranges.uniqueness)

    const score = Math.round(
      100 *
        (frequencyNorm * WEIGHTS.frequency +
          engagementNorm * WEIGHTS.engagement +
          velocityNorm * WEIGHTS.velocity +
          uniquenessNorm * WEIGHTS.uniqueness),
    )

    return {
      topic: m.topic.label,
      score,
      growth: classifyGrowth(velocityNorm),
      confidence: computeConfidence(m.frequency),
      tweetCount: m.frequency,
      alsoTrendingGlobally: false,
      sampleTweets: toSampleTweets(m.topic.signals),
    }
  })

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_TOPICS)
}
