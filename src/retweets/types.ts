export type RetweetAction = "retweet" | "undo"

export type RetweetDraftStatus =
  | "draft"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "deleted"

export type RetweetDraft = {
  id: string
  tweetId: string
  action: RetweetAction
  status: RetweetDraftStatus
  createdAt: string
  updatedAt: string
  executedAt?: string
  tweetUrl?: string
}

export type CreateRetweetDraftInput = {
  tweetId: string
  action: RetweetAction
}
