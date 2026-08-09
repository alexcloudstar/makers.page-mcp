import type { XClient, XSearchTweet } from "../channels/x/client.js"
import { getDayBoundsUtc } from "../channels/x/analytics.js"
import { rankEngagers } from "./ranker.js"
import { NoTopLevelPostsError } from "./types.js"
import type { TopEngagersResult, TopLevelPostSummary } from "./types.js"

// X's Recent Search endpoint only ever returns posts from the last 7 days, no matter
// how old the post being replied to is.
const RECENT_SEARCH_WINDOW_DAYS = 7
// Safety cap on pagination per post; nobody realistically gets 500+ comments on one post.
const MAX_REPLY_PAGES_PER_POST = 5

export type TopEngagersInput = {
  date?: string
  timezone?: string
  limit?: number
  maxPosts?: number
}

const resolveDateKey = (date: string | undefined, timezone: string): string => {
  if (date) return date
  const todayKey = getDayBoundsUtc(new Date(), timezone).dateKey
  const yesterdayNoonUtc = new Date(`${todayKey}T12:00:00Z`).getTime() - 24 * 60 * 60 * 1000
  return getDayBoundsUtc(new Date(yesterdayNoonUtc), timezone).dateKey
}

const fetchAllReplies = async (
  xClient: XClient,
  conversationId: string,
  excludeUsername: string,
): Promise<XSearchTweet[]> => {
  const tweets: XSearchTweet[] = []
  let nextToken: string | undefined
  let pages = 0

  do {
    const page = await xClient.searchRecentTweets(
      `conversation_id:${conversationId} is:reply -from:${excludeUsername}`,
      { maxResults: 100, nextToken },
    )
    tweets.push(...page.tweets)
    nextToken = page.nextToken
    pages += 1
  } while (nextToken && pages < MAX_REPLY_PAGES_PER_POST)

  return tweets
}

export const getTopEngagers = async (
  input: TopEngagersInput,
  deps: { xClient: XClient },
): Promise<TopEngagersResult> => {
  const { xClient } = deps
  const timezone = input.timezone ?? "UTC"
  const dateKey = resolveDateKey(input.date, timezone)
  const dayBounds = getDayBoundsUtc(new Date(`${dateKey}T12:00:00Z`), timezone)

  const me = await xClient.getMe()
  const topLevelPosts = await xClient.listTopLevelUserPostsInRange(
    me.id,
    dayBounds.start.toISOString(),
    dayBounds.end.toISOString(),
    input.maxPosts ?? 50,
  )

  if (topLevelPosts.length === 0) {
    throw new NoTopLevelPostsError(dateKey)
  }

  const repliesByPost = await Promise.all(
    topLevelPosts.map((post) => fetchAllReplies(xClient, post.id, me.username)),
  )

  const postsChecked: TopLevelPostSummary[] = topLevelPosts.map((post, index) => ({
    id: post.id,
    text: post.text,
    url: post.url,
    createdAt: post.createdAt,
    commentCount: repliesByPost[index]!.length,
  }))

  const { ranked, totalDistinct } = rankEngagers(
    repliesByPost.map((tweets) => ({ tweets })),
    input.limit ?? 10,
  )

  const notes: string[] = []
  const daysSinceWindowEnd = (Date.now() - dayBounds.end.getTime()) / (24 * 60 * 60 * 1000)
  if (daysSinceWindowEnd > RECENT_SEARCH_WINDOW_DAYS) {
    notes.push(
      `${dateKey} is more than ${RECENT_SEARCH_WINDOW_DAYS} days ago. X's Recent Search endpoint only covers the last ` +
        `${RECENT_SEARCH_WINDOW_DAYS} days, so comment counts here are likely incomplete or zero, not a true reflection of engagement.`,
    )
  }

  return {
    date: dateKey,
    timezone,
    postsChecked,
    topEngagers: ranked,
    totalDistinctCommenters: totalDistinct,
    notes,
  }
}
