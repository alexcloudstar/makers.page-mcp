export type DmDraftStatus = "draft" | "approved" | "rejected" | "sending" | "sent" | "deleted"

export type DmConversationType = "direct" | "group"

export type DmDraft = {
  id: string
  text: string
  status: DmDraftStatus
  createdAt: string
  updatedAt: string
  conversationType?: DmConversationType
  recipientId?: string
  recipientUsername?: string
  participantIds?: string[]
  participantUsernames?: string[]
  conversationId?: string
  mediaPaths?: string[]
  dmEventId?: string
  dmConversationId?: string
  sentAt?: string
}

export type CreateDmDraftInput = {
  text: string
  conversationType?: DmConversationType
  recipientId?: string
  recipientUsername?: string
  participantIds?: string[]
  participantUsernames?: string[]
  conversationId?: string
  mediaPaths?: string[]
}

export type UpdateDmDraftInput = {
  text?: string
  conversationType?: DmConversationType | null
  recipientId?: string | null
  recipientUsername?: string | null
  participantIds?: string[] | null
  participantUsernames?: string[] | null
  conversationId?: string | null
  mediaPaths?: string[] | null
}
