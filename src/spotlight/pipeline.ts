import { resolveTargetDay } from "./dateRange.js"
import type { InteractionType, Supporter, SupporterSource, SupporterSpotlightResult, SupporterUser } from "./types.js"
import { NoPostsYesterdayError } from "./types.js"

const MAX_POSTS_PER_DAY = 5

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
    return
  }
  supporters.set(user.id, { id: user.id, username: user.username, name: user.name, interactions: [type] })
}

export const runSupporterSpotlight = async (
  input: SupporterSpotlightInput,
  deps: SupporterSpotlightDeps,
): Promise<SupporterSpotlightResult> => {
  const { dateKey, startIso, endIso } = resolveTargetDay(input.date)

  const me = await deps.getMe()
  const posts = await deps.supporterSource.fetchRecentPosts(me.id, { startIso, endIso }, MAX_POSTS_PER_DAY)
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

  return { date: dateKey, supporters: [...supporters.values()] }
}
