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
  generatedPost: string
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

export type StoredSpotlight = {
  date: string
  supporters: Supporter[]
  generatedPost: string
}

export interface SpotlightStorage {
  get(dateKey: string): Promise<StoredSpotlight | undefined>
  save(dateKey: string, supporters: Supporter[]): Promise<StoredSpotlight>
  setGeneratedPost(dateKey: string, generatedPost: string): Promise<StoredSpotlight | undefined>
}

export class NoPostsYesterdayError extends Error {
  constructor(message = "No posts were found for the target day, so there's nothing to spotlight yet.") {
    super(message)
    this.name = "NoPostsYesterdayError"
  }
}

export class SpotlightNotFoundError extends Error {
  constructor(dateKey: string) {
    super(
      `No spotlight has been fetched for ${dateKey} yet. Call supporter_spotlight with just { date } first, ` +
        "then call it again with your drafted generatedPost.",
    )
    this.name = "SpotlightNotFoundError"
  }
}
