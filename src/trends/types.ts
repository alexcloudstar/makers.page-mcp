export type SignalMetrics = {
  likes: number
  reposts: number
  replies: number
  quotes: number
  impressions?: number
}

export type RawSignal = {
  id: string
  text: string
  url: string
  createdAt: string
  author: string
  metrics: SignalMetrics
  source: string
}

export type TrendSourceInput = {
  niche: string
  keywords: string[]
  productDescription: string
  targetAudience: string
  language?: string
}

export interface TrendSource {
  name: string
  fetchSignals(input: TrendSourceInput): Promise<RawSignal[]>
}

export type Growth = "exploding" | "rising" | "stable" | "fading"

export type SampleTweet = {
  text: string
  url: string
  author: string
  metrics: SignalMetrics
}

export type TrendingTopic = {
  topic: string
  score: number
  growth: Growth
  confidence: number
  tweetCount: number
  alsoTrendingGlobally: boolean
  sampleTweets: SampleTweet[]
}

export type PainPointSignal = {
  text: string
  url: string
  author: string
  metrics: Omit<SignalMetrics, "impressions">
}

export type Urgency = "post_now" | "today" | "later"

export type Recommendation = {
  urgency: Urgency
  reason: string
}

export type TrendAnalysisResult = {
  query: {
    niche: string
    keywords: string[]
    searchQueriesUsed: string[]
  }
  trendingTopics: TrendingTopic[]
  painPointSignals: PainPointSignal[]
  recommendation: Recommendation
}

export class NoSignalsError extends Error {
  constructor(message = "No usable X posts were found for this niche/keywords after filtering spam and duplicates.") {
    super(message)
    this.name = "NoSignalsError"
  }
}
