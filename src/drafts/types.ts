export type Channel = "x"

export type DraftStatus = "draft" | "approved" | "rejected" | "publishing" | "published"

export type Draft = {
  id: string
  channel: Channel
  text: string
  status: DraftStatus
  createdAt: string
  updatedAt: string
  publishedAt?: string
  externalId?: string
  url?: string
}

export type CreateDraftInput = {
  channel: Channel
  text: string
}
