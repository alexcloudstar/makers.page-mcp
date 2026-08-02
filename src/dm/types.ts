export type DmDraftStatus = "draft" | "approved" | "rejected" | "sending" | "sent" | "deleted"

export type DmDraft = {
  id: string
  text: string
  status: DmDraftStatus
  createdAt: string
  updatedAt: string
  recipientId?: string
  recipientUsername?: string
  conversationId?: string
  mediaPaths?: string[]
  dmEventId?: string
  dmConversationId?: string
  sentAt?: string
}

export type CreateDmDraftInput = {
  text: string
  recipientId?: string
  recipientUsername?: string
  conversationId?: string
  mediaPaths?: string[]
}

export type UpdateDmDraftInput = {
  text?: string
  recipientId?: string | null
  recipientUsername?: string | null
  conversationId?: string | null
  mediaPaths?: string[] | null
}
