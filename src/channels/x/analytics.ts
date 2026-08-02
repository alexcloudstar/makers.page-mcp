export type XPublicMetrics = {
  impressionCount: number
  likeCount: number
  replyCount: number
  repostCount: number
  quoteCount: number
  bookmarkCount: number
}

export type XTweetWithMetrics = {
  id: string
  text: string
  createdAt: string
  url: string
  metrics: XPublicMetrics
}

export type XWindowMetrics = {
  impressions: number
  engagements: number
  likes: number
  reposts: number
  replies: number
  quotes: number
}

export type XTweetWindowMetrics = XWindowMetrics & {
  id: string
}

export type XTweetAnalytics = {
  id: string
  timestampedMetrics: Array<{ timestamp: string; metrics: XWindowMetrics }>
}

export type RankedPost = XTweetWithMetrics & {
  engagementRate: number
  engagements: number
  windowMetrics: XWindowMetrics
}

export type XAccountSummary = {
  account: { id: string; username: string }
  period: { start: string; end: string; days: number; timezone: string }
  metricSource: "tweet_analytics_api"
  today: {
    date: string
    postCount: number
    postsWithImpressions: number
  } & XWindowMetrics
  periodTotals: {
    postCount: number
    postsWithImpressions: number
  } & XWindowMetrics
  topPosts: RankedPost[]
  notes?: string[]
}

export type PostingHourBucket = {
  hour: number
  label: string
  postCount: number
  avgImpressions: number
  avgEngagements: number
  avgEngagementRate: number
}

export type PostingTimeAnalysis = {
  timezone: string
  days: number
  postCount: number
  byHour: PostingHourBucket[]
  bestHoursByImpressions: PostingHourBucket[]
  bestHoursByEngagementRate: PostingHourBucket[]
}

export const tweetUrl = (id: string): string => `https://x.com/i/web/status/${id}`

export const emptyWindowMetrics = (): XWindowMetrics => ({
  impressions: 0,
  engagements: 0,
  likes: 0,
  reposts: 0,
  replies: 0,
  quotes: 0,
})

export const addWindowMetrics = (a: XWindowMetrics, b: XWindowMetrics): XWindowMetrics => ({
  impressions: a.impressions + b.impressions,
  engagements: a.engagements + b.engagements,
  likes: a.likes + b.likes,
  reposts: a.reposts + b.reposts,
  replies: a.replies + b.replies,
  quotes: a.quotes + b.quotes,
})

export const engagementsFromMetrics = (metrics: XPublicMetrics): number =>
  metrics.likeCount + metrics.repostCount + metrics.replyCount + metrics.quoteCount

export const engagementsFromWindow = (metrics: XWindowMetrics): number =>
  metrics.engagements > 0
    ? metrics.engagements
    : metrics.likes + metrics.reposts + metrics.replies + metrics.quotes

export const engagementRateFromWindow = (metrics: XWindowMetrics): number => {
  if (metrics.impressions <= 0) return 0
  return metrics.engagements / metrics.impressions
}

const dateKeyInTimezone = (iso: string, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))

const timePartsInTimezone = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0")
  return { hour: read("hour") % 24, minute: read("minute") }
}

const DAY_BOUND_MAX_STEPS = 96
const DAY_BOUND_STEP_MS = 15 * 60_000

export const getDayBoundsUtc = (
  reference: Date,
  timezone: string,
): { start: Date; end: Date; dateKey: string } => {
  const dateKey = dateKeyInTimezone(reference.toISOString(), timezone)

  let start = new Date(reference)
  for (let i = 0; i < DAY_BOUND_MAX_STEPS; i++) {
    start = new Date(start.getTime() - DAY_BOUND_STEP_MS)
    const key = dateKeyInTimezone(start.toISOString(), timezone)
    const { hour, minute } = timePartsInTimezone(start, timezone)
    if (key === dateKey && hour === 0 && minute === 0) break
    if (key !== dateKey) {
      start = new Date(start.getTime() + DAY_BOUND_STEP_MS)
      break
    }
  }

  let end = new Date(reference)
  for (let i = 0; i < DAY_BOUND_MAX_STEPS; i++) {
    end = new Date(end.getTime() + DAY_BOUND_STEP_MS)
    const key = dateKeyInTimezone(end.toISOString(), timezone)
    if (key !== dateKey) {
      end = new Date(end.getTime() - 1)
      break
    }
  }

  return { start, end, dateKey }
}

export const getPeriodBoundsUtc = (
  days: number,
  timezone: string,
  reference: Date = new Date(),
): { start: Date; end: Date; days: number } => {
  const today = getDayBoundsUtc(reference, timezone)
  const startAnchor = new Date(today.start.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
  const startDay = getDayBoundsUtc(startAnchor, timezone)
  return { start: startDay.start, end: today.end, days }
}

const bucketInWindow = (timestamp: string, start: Date, end: Date, timezone: string, dateKey?: string) => {
  const when = new Date(timestamp)
  if (when < start || when > end) return false
  if (dateKey && dateKeyInTimezone(timestamp, timezone) !== dateKey) return false
  return true
}

export const aggregateTweetAnalytics = (
  analytics: XTweetAnalytics[],
  start: Date,
  end: Date,
  timezone: string,
  dateKey?: string,
): { totals: XWindowMetrics; byTweet: Map<string, XWindowMetrics> } => {
  const byTweet = new Map<string, XWindowMetrics>()
  let totals = emptyWindowMetrics()

  for (const row of analytics) {
    let tweetTotals = emptyWindowMetrics()
    for (const entry of row.timestampedMetrics) {
      // Total-granularity responses may omit timestamps; the request window already scopes metrics.
      if (entry.timestamp) {
        if (!bucketInWindow(entry.timestamp, start, end, timezone, dateKey)) continue
      } else if (dateKey) {
        continue
      }
      tweetTotals = addWindowMetrics(tweetTotals, entry.metrics)
    }
    if (tweetTotals.impressions > 0 || tweetTotals.engagements > 0) {
      byTweet.set(row.id, tweetTotals)
      totals = addWindowMetrics(totals, tweetTotals)
    }
  }

  return { totals, byTweet }
}

export const buildAccountSummaryFromAnalytics = (input: {
  account: { id: string; username: string }
  posts: XTweetWithMetrics[]
  analytics: XTweetAnalytics[]
  todayAnalytics?: XTweetAnalytics[]
  days: number
  timezone: string
  topLimit?: number
  referenceDate?: Date
}): XAccountSummary => {
  const timezone = input.timezone
  const reference = input.referenceDate ?? new Date()
  const periodBounds = getPeriodBoundsUtc(input.days, timezone, reference)
  const todayBounds = getDayBoundsUtc(reference, timezone)

  const periodAgg = aggregateTweetAnalytics(
    input.analytics,
    periodBounds.start,
    periodBounds.end,
    timezone,
  )
  const todayAgg = aggregateTweetAnalytics(
    input.todayAnalytics ?? input.analytics,
    todayBounds.start,
    todayBounds.end,
    timezone,
    todayBounds.dateKey,
  )

  const postsById = new Map(input.posts.map((post) => [post.id, post]))
  const ranked: RankedPost[] = []

  for (const [id, windowMetrics] of periodAgg.byTweet.entries()) {
    const post = postsById.get(id)
    if (!post) continue
    ranked.push({
      ...post,
      windowMetrics,
      engagements: windowMetrics.engagements,
      engagementRate: engagementRateFromWindow(windowMetrics),
    })
  }

  ranked.sort((a, b) => b.windowMetrics.impressions - a.windowMetrics.impressions)

  const notes: string[] = [
    "Impressions use GET /2/tweets/analytics for the selected calendar window (matches x.com account analytics more closely than lifetime public_metrics).",
  ]
  if (input.posts.length >= (input.topLimit ?? 5)) {
    notes.push("Timeline fetch hit the maxPosts cap; older posts may be missing from analytics totals.")
  }

  return {
    account: input.account,
    period: {
      start: periodBounds.start.toISOString(),
      end: periodBounds.end.toISOString(),
      days: input.days,
      timezone,
    },
    metricSource: "tweet_analytics_api",
    today: {
      date: todayBounds.dateKey,
      postCount: input.posts.filter(
        (post) => dateKeyInTimezone(post.createdAt, timezone) === todayBounds.dateKey,
      ).length,
      postsWithImpressions: todayAgg.byTweet.size,
      ...todayAgg.totals,
    },
    periodTotals: {
      postCount: input.posts.length,
      postsWithImpressions: periodAgg.byTweet.size,
      ...periodAgg.totals,
    },
    topPosts: ranked.slice(0, input.topLimit ?? 5),
    notes,
  }
}

const hourInTimezone = (iso: string, timezone: string): number =>
  Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(new Date(iso)),
  ) % 24

const hourLabel = (hour: number): string => {
  const normalized = hour === 24 ? 0 : hour
  const suffix = normalized < 12 ? "AM" : "PM"
  const display = normalized % 12 === 0 ? 12 : normalized % 12
  return `${display}${suffix}`
}

export const analyzePostingTimes = (
  posts: XTweetWithMetrics[],
  days: number,
  timezone = "UTC",
  minPostsPerHour = 1,
): PostingTimeAnalysis => {
  const buckets = new Map<number, XTweetWithMetrics[]>()

  for (const post of posts) {
    const hour = hourInTimezone(post.createdAt, timezone)
    const existing = buckets.get(hour) ?? []
    existing.push(post)
    buckets.set(hour, existing)
  }

  const byHour: PostingHourBucket[] = Array.from({ length: 24 }, (_, hour) => {
    const hourPosts = buckets.get(hour) ?? []
    const postCount = hourPosts.length
    const avgImpressions =
      postCount === 0
        ? 0
        : hourPosts.reduce((sum, post) => sum + post.metrics.impressionCount, 0) / postCount
    const avgEngagements =
      postCount === 0
        ? 0
        : hourPosts.reduce((sum, post) => sum + engagementsFromMetrics(post.metrics), 0) / postCount
    const avgEngagementRate =
      postCount === 0
        ? 0
        : hourPosts.reduce((sum, post) => sum + (post.metrics.impressionCount > 0
            ? engagementsFromMetrics(post.metrics) / post.metrics.impressionCount
            : 0), 0) / postCount

    return {
      hour,
      label: hourLabel(hour),
      postCount,
      avgImpressions: Math.round(avgImpressions),
      avgEngagements: Math.round(avgEngagements * 100) / 100,
      avgEngagementRate: Math.round(avgEngagementRate * 10_000) / 10_000,
    }
  })

  const eligible = byHour.filter((bucket) => bucket.postCount >= minPostsPerHour)

  return {
    timezone,
    days,
    postCount: posts.length,
    byHour,
    bestHoursByImpressions: [...eligible]
      .sort((a, b) => b.avgImpressions - a.avgImpressions)
      .slice(0, 5),
    bestHoursByEngagementRate: [...eligible]
      .sort((a, b) => b.avgEngagementRate - a.avgEngagementRate)
      .slice(0, 5),
  }
}
