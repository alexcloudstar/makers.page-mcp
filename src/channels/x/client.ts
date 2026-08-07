import { open } from "node:fs/promises"
import path from "node:path"
import { ensureFreshAccessToken } from "../../auth/oauth2.js"
import { CredentialStore } from "../../auth/store.js"
import { NotAuthenticatedError } from "../../auth/errors.js"
import type { Config } from "../../config.js"
import { fetchWithTimeout } from "../../util/fetch-with-timeout.js"
import { assertSafeMediaFileForUpload, resolveMediaCategory, type MediaCategory } from "./validate.js"
import type { XTweetWithMetrics, XTweetAnalytics, XWindowMetrics } from "./analytics.js"

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

export type XSearchTweet = XTweetWithMetrics & {
  authorId?: string
  authorUsername?: string
}

export type XTrend = {
  name: string
  tweetCount?: number
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
  conversationId?: string
  senderUsername?: string
}

type ApiPublicMetrics = {
  impression_count?: number
  like_count?: number
  reply_count?: number
  retweet_count?: number
  quote_count?: number
  bookmark_count?: number
}

type ApiTweetWithMetrics = {
  id: string
  text?: string
  created_at?: string
  public_metrics?: ApiPublicMetrics
}

const parsePublicMetrics = (metrics: ApiPublicMetrics | undefined) => ({
  impressionCount: metrics?.impression_count ?? 0,
  likeCount: metrics?.like_count ?? 0,
  replyCount: metrics?.reply_count ?? 0,
  repostCount: metrics?.retweet_count ?? 0,
  quoteCount: metrics?.quote_count ?? 0,
  bookmarkCount: metrics?.bookmark_count ?? 0,
})

const parseTweetWithMetrics = (tweet: ApiTweetWithMetrics): XTweetWithMetrics | undefined => {
  if (!tweet.created_at || tweet.text === undefined) return undefined
  return {
    id: tweet.id,
    text: tweet.text,
    createdAt: tweet.created_at,
    url: tweetUrl(tweet.id),
    metrics: parsePublicMetrics(tweet.public_metrics),
  }
}

type ApiAnalyticsMetrics = {
  impressions?: number
  likes?: number
  retweets?: number
  replies?: number
  quote_tweets?: number
  engagements?: number
}

const parseApiAnalyticsMetrics = (metrics: ApiAnalyticsMetrics | undefined): XWindowMetrics => ({
  impressions: metrics?.impressions ?? 0,
  likes: metrics?.likes ?? 0,
  reposts: metrics?.retweets ?? 0,
  replies: metrics?.replies ?? 0,
  quotes: metrics?.quote_tweets ?? 0,
  engagements: metrics?.engagements ?? 0,
})

/** X analytics API rejects millisecond precision on start_time/end_time. */
const formatAnalyticsTime = (iso: string): string => iso.replace(/\.\d{3}Z$/, "Z")

const TWEET_METRICS_FIELDS = "tweet.fields=created_at,text,public_metrics"

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

  async retweet(tweetId: string): Promise<void> {
    const me = await this.getMe()
    const result = await this.request<{ data?: { retweeted?: boolean } }>(
      `/2/users/${me.id}/retweets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweet_id: tweetId }),
      },
    )
    if (result?.data?.retweeted !== true) {
      throw new XApiError(
        `X API retweet did not confirm success for tweet id ${tweetId}`,
        422,
        result,
      )
    }
  }

  async undoRetweet(tweetId: string): Promise<void> {
    const me = await this.getMe()
    const result = await this.request<{ data?: { retweeted?: boolean } }>(
      `/2/users/${me.id}/retweets/${tweetId}`,
      { method: "DELETE" },
    )
    if (result?.data?.retweeted !== false) {
      throw new XApiError(
        `X API undo retweet did not confirm success for tweet id ${tweetId}`,
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
    await assertSafeMediaFileForUpload(filePath)

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
      data?: Array<{
        id: string
        text?: string
        created_at?: string
        sender_id?: string
        dm_conversation_id?: string
      }>
    }>(
      "/2/dm_conversations/with/" +
        encodeURIComponent(participantId) +
        "/dm_events?max_results=" +
        capped +
        "&event_types=MessageCreate&dm_event.fields=id,text,created_at,sender_id,dm_conversation_id",
      { method: "GET" },
    )
    return (result.data ?? []).map((event) => ({
      id: event.id,
      text: event.text,
      createdAt: event.created_at,
      senderId: event.sender_id,
      conversationId: event.dm_conversation_id,
    }))
  }

  async listDmEventsByConversationId(
    conversationId: string,
    maxResults = 20,
  ): Promise<DmEventSummary[]> {
    const capped = Math.min(Math.max(maxResults, 1), 100)
    const result = await this.request<{
      data?: Array<{
        id: string
        text?: string
        created_at?: string
        sender_id?: string
        dm_conversation_id?: string
      }>
    }>(
      "/2/dm_conversations/" +
        encodeURIComponent(conversationId) +
        "/dm_events?max_results=" +
        capped +
        "&event_types=MessageCreate&dm_event.fields=id,text,created_at,sender_id,dm_conversation_id",
      { method: "GET" },
    )
    return (result.data ?? []).map((event) => ({
      id: event.id,
      text: event.text,
      createdAt: event.created_at,
      senderId: event.sender_id,
      conversationId: event.dm_conversation_id ?? conversationId,
    }))
  }

  async listDmInbox(maxResults = 20): Promise<DmEventSummary[]> {
    const capped = Math.min(Math.max(maxResults, 1), 100)
    const result = await this.request<{
      data?: Array<{
        id: string
        text?: string
        created_at?: string
        sender_id?: string
        dm_conversation_id?: string
      }>
      includes?: { users?: Array<{ id: string; username: string; name: string }> }
    }>(
      "/2/dm_events?max_results=" +
        capped +
        "&event_types=MessageCreate&dm_event.fields=id,text,created_at,sender_id,dm_conversation_id&expansions=sender_id&user.fields=id,username,name",
      { method: "GET" },
    )
    const usersById = new Map((result.includes?.users ?? []).map((user) => [user.id, user]))
    return (result.data ?? []).map((event) => ({
      id: event.id,
      text: event.text,
      createdAt: event.created_at,
      senderId: event.sender_id,
      conversationId: event.dm_conversation_id,
      senderUsername: event.sender_id ? usersById.get(event.sender_id)?.username : undefined,
    }))
  }

  async createGroupDmConversation(
    participantIds: string[],
    input: CreateDmMessageInput,
  ): Promise<SentDm> {
    const result = await this.request<{ data: { dm_event_id: string; dm_conversation_id: string } }>(
      "/2/dm_conversations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_type: "Group",
          participant_ids: participantIds,
          message: buildDmMessageBody(input),
        }),
      },
    )
    return {
      dmEventId: result.data.dm_event_id,
      dmConversationId: result.data.dm_conversation_id,
    }
  }

  async getTweetsByIds(ids: string[]): Promise<XTweetWithMetrics[]> {
    if (ids.length === 0) return []
    const unique = [...new Set(ids)].slice(0, 100)
    const result = await this.request<{ data?: ApiTweetWithMetrics[] }>(
      `/2/tweets?ids=${unique.map(encodeURIComponent).join(",")}&${TWEET_METRICS_FIELDS}`,
      { method: "GET" },
    )
    return (result.data ?? [])
      .map(parseTweetWithMetrics)
      .filter((tweet): tweet is XTweetWithMetrics => tweet !== undefined)
  }

  async listUserTweets(
    userId: string,
    options: {
      maxResults?: number
      startTime?: string
      endTime?: string
      paginationToken?: string
    } = {},
  ): Promise<{ tweets: XTweetWithMetrics[]; nextToken?: string }> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 20, 5), 100)
    const query = new URLSearchParams()
    query.set("max_results", String(maxResults))
    query.set("tweet.fields", "created_at,text,public_metrics")
    if (options.startTime) query.set("start_time", options.startTime)
    if (options.endTime) query.set("end_time", options.endTime)
    if (options.paginationToken) query.set("pagination_token", options.paginationToken)

    const result = await this.request<{
      data?: ApiTweetWithMetrics[]
      meta?: { next_token?: string }
    }>(`/2/users/${encodeURIComponent(userId)}/tweets?${query.toString()}`, { method: "GET" })

    const tweets = (result.data ?? [])
      .map(parseTweetWithMetrics)
      .filter((tweet): tweet is XTweetWithMetrics => tweet !== undefined)

    return { tweets, nextToken: result.meta?.next_token }
  }

  async listUserTweetsInRange(
    userId: string,
    startTime: string,
    endTime: string,
    maxPosts = 100,
  ): Promise<XTweetWithMetrics[]> {
    const collected: XTweetWithMetrics[] = []
    let paginationToken: string | undefined

    while (collected.length < maxPosts) {
      const pageSize = Math.min(100, maxPosts - collected.length)
      const page = await this.listUserTweets(userId, {
        maxResults: pageSize,
        startTime,
        endTime,
        paginationToken,
      })
      collected.push(...page.tweets)
      if (!page.nextToken || page.tweets.length === 0) break
      paginationToken = page.nextToken
    }

    return collected.slice(0, maxPosts)
  }

  async getPostsAnalytics(
    ids: string[],
    startTime: string,
    endTime: string,
    granularity: "hourly" | "daily" | "weekly" | "total" = "total",
  ): Promise<XTweetAnalytics[]> {
    if (ids.length === 0) return []

    const unique = [...new Set(ids)]
    const results: XTweetAnalytics[] = []

    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100)
      const query = new URLSearchParams()
      query.set("ids", batch.join(","))
      query.set("start_time", formatAnalyticsTime(startTime))
      query.set("end_time", formatAnalyticsTime(endTime))
      query.set("granularity", granularity)

      const result = await this.request<{
        data?: Array<{
          id: string
          timestamped_metrics?: Array<{ timestamp?: string; metrics?: ApiAnalyticsMetrics }>
        }>
      }>(`/2/tweets/analytics?${query.toString()}`, { method: "GET" })

      for (const row of result.data ?? []) {
        results.push({
          id: row.id,
          timestampedMetrics: (row.timestamped_metrics ?? []).map((entry) => ({
            timestamp: entry.timestamp ?? "",
            metrics: parseApiAnalyticsMetrics(entry.metrics),
          })),
        })
      }
    }

    return results
  }

  async searchRecentTweets(
    query: string,
    options: { maxResults?: number; nextToken?: string } = {},
  ): Promise<{ tweets: XSearchTweet[]; nextToken?: string }> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 100, 10), 100)
    const params = new URLSearchParams()
    params.set("query", query)
    params.set("max_results", String(maxResults))
    params.set("tweet.fields", "created_at,text,public_metrics,author_id")
    params.set("expansions", "author_id")
    params.set("user.fields", "username")
    if (options.nextToken) params.set("next_token", options.nextToken)

    const result = await this.request<{
      data?: Array<ApiTweetWithMetrics & { author_id?: string }>
      includes?: { users?: Array<{ id: string; username: string }> }
      meta?: { next_token?: string }
    }>(`/2/tweets/search/recent?${params.toString()}`, { method: "GET" })

    const usersById = new Map((result.includes?.users ?? []).map((user) => [user.id, user]))
    const tweets = (result.data ?? [])
      .map((tweet): XSearchTweet | undefined => {
        const parsed = parseTweetWithMetrics(tweet)
        if (!parsed) return undefined
        return {
          ...parsed,
          authorId: tweet.author_id,
          authorUsername: tweet.author_id ? usersById.get(tweet.author_id)?.username : undefined,
        }
      })
      .filter((tweet): tweet is XSearchTweet => tweet !== undefined)

    return { tweets, nextToken: result.meta?.next_token }
  }

  async getLikingUsers(tweetId: string, maxResults = 100): Promise<XUser[]> {
    const capped = Math.min(Math.max(maxResults, 1), 100)
    const result = await this.request<{
      data?: Array<{ id: string; username: string; name?: string }>
    }>(
      `/2/tweets/${encodeURIComponent(tweetId)}/liking_users?max_results=${capped}&user.fields=username,name`,
      { method: "GET" },
    )
    return (result.data ?? []).map((user) => ({
      id: user.id,
      username: user.username,
      name: user.name ?? user.username,
    }))
  }

  async getTrendsByWoeid(woeid: number, maxTrends = 20): Promise<XTrend[]> {
    const capped = Math.min(Math.max(maxTrends, 1), 50)
    const result = await this.request<{
      data?: Array<{ trend_name: string; tweet_count?: number }>
    }>(`/2/trends/by/woeid/${woeid}?max_trends=${capped}`, { method: "GET" })
    return (result.data ?? []).map((trend) => ({
      name: trend.trend_name,
      tweetCount: trend.tweet_count,
    }))
  }
}
