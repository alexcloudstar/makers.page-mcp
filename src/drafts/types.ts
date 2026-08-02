export type Channel = "x"

export type DraftStatus = "draft" | "approved" | "rejected" | "publishing" | "published" | "deleted"

export type DraftPoll = {
  options: string[]
  durationMinutes: number
}

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
  poll?: DraftPoll
  mediaPaths?: string[]
  parts?: string[]
  quoteTweetId?: string
  communityId?: string
  shareWithFollowers?: boolean
  paidPartnership?: boolean
  externalIds?: string[]
  urls?: string[]
}

export type CreateDraftInput = {
  channel: Channel
  text: string
  poll?: DraftPoll
  mediaPaths?: string[]
  parts?: string[]
  quoteTweetId?: string
  communityId?: string
  shareWithFollowers?: boolean
  paidPartnership?: boolean
}

export type UpdateDraftInput = {
  text?: string
  poll?: DraftPoll | null
  mediaPaths?: string[] | null
  parts?: string[] | null
  quoteTweetId?: string | null
  communityId?: string | null
  shareWithFollowers?: boolean | null
  paidPartnership?: boolean | null
}
