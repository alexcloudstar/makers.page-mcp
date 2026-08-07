import type { PainPointSignal, RawSignal } from "./types.js"

const DEMAND_PATTERNS = [
  /\blooking for\b/i,
  /\brecommend\b/i,
  /\balternative to\b/i,
  /\bhow do i\b/i,
  /\banyone know\b/i,
  /\bany(one)? (good |know )?(tool|app|way|library)\b/i,
  /\bstruggling with\b/i,
  /\bwish there was\b/i,
]

const MAX_PAIN_POINTS = 10

const engagementScore = (signal: RawSignal): number =>
  signal.metrics.likes + signal.metrics.reposts * 2 + signal.metrics.replies * 1.5 + signal.metrics.quotes * 1.5

/** Surfaces raw "demand signal" posts (people asking for recommendations/alternatives), ranked by engagement. */
export const extractPainPointSignals = (signals: RawSignal[]): PainPointSignal[] =>
  signals
    .filter((signal) => DEMAND_PATTERNS.some((pattern) => pattern.test(signal.text)))
    .sort((a, b) => engagementScore(b) - engagementScore(a))
    .slice(0, MAX_PAIN_POINTS)
    .map((signal) => ({
      text: signal.text,
      url: signal.url,
      author: signal.author,
      metrics: {
        likes: signal.metrics.likes,
        reposts: signal.metrics.reposts,
        replies: signal.metrics.replies,
        quotes: signal.metrics.quotes,
      },
    }))
