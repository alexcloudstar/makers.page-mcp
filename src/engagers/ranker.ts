import type { XSearchTweet } from "../channels/x/client.js"
import type { EngagerRanking } from "./types.js"

export const rankEngagers = (
  repliesByPost: Array<{ tweets: XSearchTweet[] }>,
  limit: number,
): { ranked: EngagerRanking[]; totalDistinct: number } => {
  const byUsername = new Map<string, EngagerRanking>()

  for (const { tweets } of repliesByPost) {
    for (const tweet of tweets) {
      if (!tweet.authorUsername) continue
      const existing = byUsername.get(tweet.authorUsername) ?? {
        username: tweet.authorUsername,
        name: tweet.authorName,
        commentCount: 0,
        likesOnComments: 0,
      }
      existing.commentCount += 1
      existing.likesOnComments += tweet.metrics.likeCount
      byUsername.set(tweet.authorUsername, existing)
    }
  }

  const ranked = [...byUsername.values()].sort(
    (a, b) => b.commentCount - a.commentCount || b.likesOnComments - a.likesOnComments,
  )

  return { ranked: ranked.slice(0, limit), totalDistinct: ranked.length }
}
