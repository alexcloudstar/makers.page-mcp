import { resolveTargetDay } from "./dateRange.js"
import { buildDefaultSpotlightPost } from "./template.js"
import type { InteractionType, Supporter, SupporterSource, SupporterSpotlightResult, SupporterUser } from "./types.js"
import { NoPostsYesterdayError } from "./types.js"

// A safety ceiling against a runaway pagination loop, not a business cap — every post
// from the target day is scanned, however many there are.
const MAX_POSTS_TO_SCAN = 500

const POINTS_PER_LIKE = 1
const POINTS_PER_REPLY = 3
// Rewards supporters who engaged in more than one way (liked AND replied), not just
// volume in a single interaction type.
const BONUS_FOR_BOTH_INTERACTION_TYPES = 2

export type SupporterSpotlightInput = {
  date?: string
}

export type SupporterSpotlightDeps = {
  supporterSource: SupporterSource
  getMe: () => Promise<{ id: string }>
}

const addInteraction = (supporters: Map<string, Supporter>, user: SupporterUser, type: InteractionType): void => {
  const existing = supporters.get(user.id)
  if (existing) {
    if (!existing.interactions.includes(type)) existing.interactions.push(type)
    if (type === "like") existing.likeCount += 1
    else existing.replyCount += 1
    return
  }
  supporters.set(user.id, {
    id: user.id,
    username: user.username,
    name: user.name,
    interactions: [type],
    likeCount: type === "like" ? 1 : 0,
    replyCount: type === "reply" ? 1 : 0,
    score: 0,
  })
}

const scoreAndRank = (supporters: Supporter[]): Supporter[] => {
  for (const supporter of supporters) {
    supporter.score =
      supporter.likeCount * POINTS_PER_LIKE +
      supporter.replyCount * POINTS_PER_REPLY +
      (supporter.likeCount > 0 && supporter.replyCount > 0 ? BONUS_FOR_BOTH_INTERACTION_TYPES : 0)
  }
  return supporters.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
}

export const runSupporterSpotlight = async (
  input: SupporterSpotlightInput,
  deps: SupporterSpotlightDeps,
): Promise<SupporterSpotlightResult> => {
  const { dateKey, startIso, endIso } = resolveTargetDay(input.date)

  const me = await deps.getMe()
  const posts = await deps.supporterSource.fetchRecentPosts(me.id, { startIso, endIso }, MAX_POSTS_TO_SCAN)
  if (posts.length === 0) throw new NoPostsYesterdayError()

  const fetches = posts.flatMap((post) => [
    deps.supporterSource.fetchLikers(post.id).then((users) => ({ users, type: "like" as const })),
    deps.supporterSource.fetchReplyAuthors(post.id, me.id).then((users) => ({ users, type: "reply" as const })),
  ])
  const results = await Promise.allSettled(fetches)

  const allFailed = results.every((result) => result.status === "rejected")
  if (allFailed) {
    const firstRejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    throw firstRejected?.reason
  }

  const supporters = new Map<string, Supporter>()
  for (const result of results) {
    if (result.status !== "fulfilled") continue
    for (const user of result.value.users) {
      if (user.id === me.id) continue
      addInteraction(supporters, user, result.value.type)
    }
  }

  const supporterList = scoreAndRank([...supporters.values()])
  const generatedPost = supporterList.length > 0 ? buildDefaultSpotlightPost(dateKey, supporterList) : ""

  return { date: dateKey, supporters: supporterList, generatedPost }
}
