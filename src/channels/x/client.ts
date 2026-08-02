import { open } from "node:fs/promises"
import path from "node:path"
import { ensureFreshAccessToken } from "../../auth/oauth2.js"
import { CredentialStore } from "../../auth/store.js"
import { NotAuthenticatedError } from "../../auth/errors.js"
import type { Config } from "../../config.js"
import { fetchWithTimeout } from "../../util/fetch-with-timeout.js"
import { resolveMediaCategory, type MediaCategory } from "./validate.js"

export { NotAuthenticatedError }

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = "XApiError"
  }
}

export type XUser = {
  id: string
  username: string
  name: string
}

export type CreatedTweet = {
  id: string
  text: string
  url: string
}

export type CreateTweetInput = {
  text: string
  replyToId?: string
  mediaIds?: string[]
  poll?: { options: string[]; durationMinutes: number }
  quoteTweetId?: string
  communityId?: string
  shareWithFollowers?: boolean
  paidPartnership?: boolean
  editPreviousPostId?: string
}

const MEDIA_CHUNK_SIZE = 1024 * 1024
const MEDIA_UPLOAD_TIMEOUT_MS = 60_000
// Large videos can sit in processing for several minutes; bound by wall clock.
const STATUS_MAX_WAIT_MS = 10 * 60_000

const tweetUrl = (id: string) => `https://x.com/i/web/status/${id}`

type MediaProcessingInfo = {
  state: string
  check_after_secs?: number
  error?: { message?: string }
}

type MediaUploadData = { data: { id: string; processing_info?: MediaProcessingInfo } }

export type SentDm = {
  dmEventId: string
  dmConversationId: string
}

export type CreateDmMessageInput = {
  text: string
  mediaIds?: string[]
}

export type DmEventSummary = {
  id: string
  text?: string
  createdAt?: string
  senderId?: string
}

const buildDmMessageBody = (input: CreateDmMessageInput): Record<string, unknown> => {
  const body: Record<string, unknown> = { text: input.text }
  if (input.mediaIds && input.mediaIds.length > 0) {
    body.attachments = input.mediaIds.map((mediaId) => ({ media_id: mediaId }))
  }
  return body
}

export class XClient {
  private readonly credentialStore: CredentialStore

  constructor(private readonly config: Config) {
    this.credentialStore = new CredentialStore(config)
  }

  async isConnected(): Promise<boolean> {
    const credentials = await this.credentialStore.read()
    return credentials !== undefined
  }

  private async getAccessToken(): Promise<string> {
    return ensureFreshAccessToken(this.config, this.credentialStore)
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const accessToken = await this.getAccessToken()
    const response = await fetchWithTimeout(`https://api.x.com${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    })

    const body = await response.json().catch(() => undefined)

    if (!response.ok) {
      const message =
        (body as { title?: string; detail?: string } | undefined)?.detail ??
        (body as { title?: string } | undefined)?.title ??
        `X API request failed with status ${response.status}`
      throw new XApiError(message, response.status, body)
    }

    return body as T
  }

  private parseMediaError(response: Response, body: unknown): XApiError {
    const message =
      (body as { title?: string; detail?: string } | undefined)?.detail ??
      (body as { title?: string } | undefined)?.title ??
      `X media upload failed with status ${response.status}`
    return new XApiError(message, response.status, body)
  }

  private async uploadImageSimple(
    filePath: string,
    mimeType: string,
    category: MediaCategory,
  ): Promise<string> {
    const accessToken = await this.getAccessToken()
    const file = await open(filePath, "r")
    try {
      const totalBytes = (await file.stat()).size
      const buffer = Buffer.alloc(totalBytes)
      await file.read(buffer, 0, totalBytes, 0)

      const form = new FormData()
      form.append("media", new Blob([buffer], { type: mimeType }), path.basename(filePath))
      form.append("media_category", category)

      const response = await fetchWithTimeout(
        "https://api.x.com/2/media/upload",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        },
        MEDIA_UPLOAD_TIMEOUT_MS,
      )

      const body = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw this.parseMediaError(response, body)
      }

      const id = (body as { data?: { id?: string } } | undefined)?.data?.id
      if (!id) {
        throw new Error("X API simple media upload response was missing data.id")
      }

      return id
    } finally {
      await file.close()
    }
  }

  private async waitForMediaProcessing(
    mediaId: string,
    initial: MediaUploadData,
  ): Promise<string> {
    let finalizeResult = initial
    let processing = finalizeResult.data.processing_info
    const statusDeadline = Date.now() + STATUS_MAX_WAIT_MS

    while (processing && processing.state !== "succeeded") {
      if (processing.state === "failed") {
        throw new XApiError(
          processing.error?.message ?? "Media processing failed",
          422,
          finalizeResult,
        )
      }

      if (Date.now() >= statusDeadline) {
        throw new XApiError(
          `Media processing did not complete in time (last state: ${processing.state})`,
          408,
          finalizeResult,
        )
      }

      const waitSecs = processing.check_after_secs ?? 1
      const waitMs = Math.min(waitSecs * 1000, Math.max(0, statusDeadline - Date.now()))
      await new Promise((resolve) => setTimeout(resolve, waitMs))

      const accessToken = await this.getAccessToken()
      const statusUrl = `https://api.x.com/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`
      const response = await fetchWithTimeout(
        statusUrl,
        { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
        MEDIA_UPLOAD_TIMEOUT_MS,
      )

      const body = (await response.json().catch(() => undefined)) as MediaUploadData | undefined
      if (!response.ok) {
        throw this.parseMediaError(response, body)
      }

      finalizeResult = body as MediaUploadData
      processing = finalizeResult.data?.processing_info
      if (!processing || processing.state === "succeeded") break
    }

    return mediaId
  }

  private async uploadMediaChunked(
    filePath: string,
    mimeType: string,
    category: MediaCategory,
  ): Promise<string> {
    const file = await open(filePath, "r")
    try {
      const totalBytes = (await file.stat()).size

      const initResult = await this.request<{ data: { id: string } }>(
        "/2/media/upload/initialize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            total_bytes: totalBytes,
            media_type: mimeType,
            media_category: category,
          }),
        },
      )
      const mediaId = initResult.data.id

      const buffer = Buffer.alloc(MEDIA_CHUNK_SIZE)
      let segmentIndex = 0
      let offset = 0
      while (offset < totalBytes) {
        const toRead = Math.min(MEDIA_CHUNK_SIZE, totalBytes - offset)
        const { bytesRead } = await file.read(buffer, 0, toRead, offset)
        if (bytesRead === 0) break

        const chunk = buffer.subarray(0, bytesRead)
        const appendForm = new FormData()
        appendForm.append("media", new Blob([chunk], { type: mimeType }), "chunk")
        appendForm.append("segment_index", String(segmentIndex))

        const accessToken = await this.getAccessToken()
        const appendResponse = await fetchWithTimeout(
          `https://api.x.com/2/media/upload/${encodeURIComponent(mediaId)}/append`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
            body: appendForm,
          },
          MEDIA_UPLOAD_TIMEOUT_MS,
        )

        const appendBody = await appendResponse.json().catch(() => undefined)
        if (!appendResponse.ok) {
          throw this.parseMediaError(appendResponse, appendBody)
        }

        offset += bytesRead
        segmentIndex += 1
      }

      const finalizeResult = await this.request<MediaUploadData>(
        `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
        { method: "POST" },
      )

      const processing = finalizeResult.data.processing_info
      if (processing?.state === "failed") {
        throw new XApiError(
          processing.error?.message ?? "Media processing failed",
          422,
          finalizeResult,
        )
      }

      if (processing) {
        return this.waitForMediaProcessing(mediaId, finalizeResult)
      }

      return mediaId
    } finally {
      await file.close()
    }
  }

  async getMe(): Promise<XUser> {
    const result = await this.request<{ data: XUser }>("/2/users/me", { method: "GET" })
    return result.data
  }

  async createTweet(input: CreateTweetInput): Promise<CreatedTweet> {
    const body: Record<string, unknown> = { text: input.text }

    if (input.replyToId) {
      body.reply = { in_reply_to_tweet_id: input.replyToId }
    }
    if (input.mediaIds && input.mediaIds.length > 0) {
      body.media = { media_ids: input.mediaIds }
    }
    if (input.poll) {
      body.poll = {
        options: input.poll.options,
        duration_minutes: input.poll.durationMinutes,
      }
    }
    if (input.quoteTweetId) {
      body.quote_tweet_id = input.quoteTweetId
    }
    if (input.communityId) {
      body.community_id = input.communityId
    }
    if (input.shareWithFollowers !== undefined) {
      body.share_with_followers = input.shareWithFollowers
    }
    if (input.paidPartnership !== undefined) {
      body.paid_partnership = input.paidPartnership
    }
    if (input.editPreviousPostId) {
      body.edit_options = { previous_post_id: input.editPreviousPostId }
    }

    const result = await this.request<{ data?: { id?: string; text?: string } }>("/2/tweets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    const id = result?.data?.id
    const text = result?.data?.text
    // Plain Error (not XApiError): HTTP may have succeeded, so publish/edit
    // treat this as ambiguous rather than a safe definitive failure.
    if (!id || text === undefined) {
      throw new Error("X API create tweet response was missing data.id/text")
    }

    return {
      id,
      text,
      url: tweetUrl(id),
    }
  }

  async deleteTweet(id: string): Promise<void> {
    const result = await this.request<{ data?: { deleted?: boolean } }>(`/2/tweets/${id}`, {
      method: "DELETE",
    })
    if (result?.data?.deleted !== true) {
      throw new XApiError(
        `X API delete tweet did not confirm deletion for id ${id}`,
        422,
        result,
      )
    }
  }

  async getUserByUsername(
    username: string,
  ): Promise<XUser & { receivesYourDm?: boolean }> {
    const handle = username.replace(/^@/, "")
    const result = await this.request<{
      data: { id: string; username: string; name: string; receives_your_dm?: boolean }
    }>(`/2/users/by/username/${encodeURIComponent(handle)}?user.fields=receives_your_dm`, {
      method: "GET",
    })
    return {
      id: result.data.id,
      username: result.data.username,
      name: result.data.name,
      receivesYourDm: result.data.receives_your_dm,
    }
  }

  async uploadMedia(filePath: string): Promise<string> {
    const resolved = resolveMediaCategory(filePath)
    if (!resolved.ok) {
      throw new Error(resolved.error)
    }

    if (resolved.category === "tweet_image") {
      return this.uploadImageSimple(filePath, resolved.mimeType, resolved.category)
    }

    return this.uploadMediaChunked(filePath, resolved.mimeType, resolved.category)
  }

  async sendDmByParticipantId(
    participantId: string,
    input: CreateDmMessageInput,
  ): Promise<SentDm> {
    const result = await this.request<{ data: { dm_event_id: string; dm_conversation_id: string } }>(
      `/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDmMessageBody(input)),
      },
    )
    return {
      dmEventId: result.data.dm_event_id,
      dmConversationId: result.data.dm_conversation_id,
    }
  }

  async sendDmByConversationId(
    conversationId: string,
    input: CreateDmMessageInput,
  ): Promise<SentDm> {
    const result = await this.request<{ data: { dm_event_id: string; dm_conversation_id: string } }>(
      `/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDmMessageBody(input)),
      },
    )
    return {
      dmEventId: result.data.dm_event_id,
      dmConversationId: result.data.dm_conversation_id,
    }
  }

  async listDmEventsByParticipant(
    participantId: string,
    maxResults = 20,
  ): Promise<DmEventSummary[]> {
    const capped = Math.min(Math.max(maxResults, 1), 100)
    const result = await this.request<{
      data?: Array<{ id: string; text?: string; created_at?: string; sender_id?: string }>
    }>(
      `/2/dm_conversations/with/${encodeURIComponent(participantId)}/dm_events?max_results=${capped}&dm_event.fields=id,text,created_at,sender_id`,
      { method: "GET" },
    )
    return (result.data ?? []).map((event) => ({
      id: event.id,
      text: event.text,
      createdAt: event.created_at,
      senderId: event.sender_id,
    }))
  }
}
