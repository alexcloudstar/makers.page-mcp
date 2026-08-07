export type InteractionType = "like" | "reply"

export type Supporter = {
  id: string
  username: string
  name?: string
  interactions: InteractionType[]
}

export type SupporterSpotlightResult = {
  date: string
  supporters: Supporter[]
}

export type RecentPost = {
  id: string
}

export type SupporterUser = {
  id: string
  username: string
  name?: string
}

export interface SupporterSource {
  fetchRecentPosts(
    userId: string,
    range: { startIso: string; endIso: string },
    maxPosts: number,
  ): Promise<RecentPost[]>
  fetchLikers(postId: string): Promise<SupporterUser[]>
  fetchReplyAuthors(postId: string, excludeAuthorId: string): Promise<SupporterUser[]>
}

export class NoPostsYesterdayError extends Error {
  constructor(message = "No posts were found for the target day, so there's nothing to spotlight yet.") {
    super(message)
    this.name = "NoPostsYesterdayError"
  }
}
