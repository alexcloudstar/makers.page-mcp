export type TopLevelPostSummary = {
  id: string
  text: string
  url: string
  createdAt: string
  commentCount: number
}

export type EngagerRanking = {
  username: string
  name?: string
  commentCount: number
  likesOnComments: number
}

export type TopEngagersResult = {
  date: string
  timezone: string
  postsChecked: TopLevelPostSummary[]
  topEngagers: EngagerRanking[]
  totalDistinctCommenters: number
  notes: string[]
}

export class NoTopLevelPostsError extends Error {
  constructor(date: string) {
    super(`No top-level posts found for ${date}. Check the date/timezone, or that the account posted that day.`)
    this.name = "NoTopLevelPostsError"
  }
}
