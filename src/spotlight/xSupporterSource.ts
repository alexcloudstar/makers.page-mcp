import type { XClient } from "../channels/x/client.js"
import type { RecentPost, SupporterSource, SupporterUser } from "./types.js"

const MAX_LIKERS_PER_POST = 100
const MAX_REPLY_AUTHORS_PER_POST = 100

export class XSupporterSource implements SupporterSource {
  constructor(private readonly xClient: XClient) {}

  async fetchRecentPosts(
    userId: string,
    range: { startIso: string; endIso: string },
    maxPosts: number,
  ): Promise<RecentPost[]> {
    const posts = await this.xClient.listUserTweetsInRange(userId, range.startIso, range.endIso, maxPosts)
    return posts.map((post) => ({ id: post.id }))
  }

  async fetchLikers(postId: string): Promise<SupporterUser[]> {
    const users = await this.xClient.getLikingUsers(postId, MAX_LIKERS_PER_POST)
    return users.map((user) => ({ id: user.id, username: user.username, name: user.name }))
  }

  async fetchReplyAuthors(postId: string, excludeAuthorId: string): Promise<SupporterUser[]> {
    const { tweets } = await this.xClient.searchRecentTweets(`conversation_id:${postId}`, {
      maxResults: MAX_REPLY_AUTHORS_PER_POST,
    })

    const seen = new Set<string>()
    const authors: SupporterUser[] = []
    for (const tweet of tweets) {
      if (tweet.id === postId) continue
      if (!tweet.authorId || tweet.authorId === excludeAuthorId) continue
      if (seen.has(tweet.authorId)) continue
      seen.add(tweet.authorId)
      authors.push({ id: tweet.authorId, username: tweet.authorUsername ?? tweet.authorId })
    }
    return authors
  }
}
