import type { XClient, XSearchTweet } from "../channels/x/client.js"
import type { RecentPost, SupporterSource, SupporterUser } from "./types.js"

// A safety ceiling against a runaway pagination loop, not a business cap.
const MAX_REPLY_TWEETS_PER_POST = 5_000

// `conversation_id:{postId}` matches every tweet in the whole thread, including people
// replying to OTHER replies (not to this post). Only count direct replies to the post.
const isDirectReplyTo = (tweet: XSearchTweet, postId: string): boolean =>
  tweet.referencedTweets?.some((ref) => ref.type === "replied_to" && ref.id === postId) ?? false

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
    const users = await this.xClient.getLikingUsers(postId)
    return users.map((user) => ({ id: user.id, username: user.username, name: user.name }))
  }

  /**
   * One entry per matching reply tweet (not deduped) — if the same person replies
   * more than once, each reply should count toward their engagement score.
   */
  async fetchReplyAuthors(postId: string, excludeAuthorId: string): Promise<SupporterUser[]> {
    const authors: SupporterUser[] = []
    let nextToken: string | undefined

    do {
      const { tweets, nextToken: token } = await this.xClient.searchRecentTweets(`conversation_id:${postId}`, {
        maxResults: 100,
        nextToken,
      })
      for (const tweet of tweets) {
        if (tweet.id === postId) continue
        if (!isDirectReplyTo(tweet, postId)) continue
        if (!tweet.authorId || tweet.authorId === excludeAuthorId) continue
        authors.push({ id: tweet.authorId, username: tweet.authorUsername ?? tweet.authorId })
      }
      nextToken = token
    } while (nextToken && authors.length < MAX_REPLY_TWEETS_PER_POST)

    return authors
  }
}
