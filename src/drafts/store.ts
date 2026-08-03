import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import type { CreateDraftInput, Draft, DraftStatus, UpdateDraftInput } from "./types.js"
import { PRIVATE_FILE_MODE, writeFileAtomic } from "../util/atomic-write.js"
import { createKeyedLock } from "../util/lock.js"

export class DraftNotFoundError extends Error {
  constructor(id: string) {
    super(`Draft "${id}" was not found.`)
    this.name = "DraftNotFoundError"
  }
}

export class InvalidDraftTransitionError extends Error {
  constructor(id: string, from: DraftStatus, to: DraftStatus) {
    super(`Draft "${id}" cannot move from "${from}" to "${to}".`)
    this.name = "InvalidDraftTransitionError"
  }
}

/** Draft still points at live X posts; reset/reject would orphan them. */
export class DraftHasLivePostsError extends Error {
  constructor(id: string, ids: string[]) {
    super(
      `Draft "${id}" has live post id(s) recorded (${ids.join(", ")}). ` +
        "Call delete_published_draft to remove them from X before rejecting or editing this draft.",
    )
    this.name = "DraftHasLivePostsError"
  }
}

export const recordedLiveIds = (draft: Pick<Draft, "externalId" | "externalIds">): string[] => {
  if (draft.externalIds && draft.externalIds.length > 0) return draft.externalIds
  if (draft.externalId) return [draft.externalId]
  return []
}

// Matches the shape of `randomUUID()`. Rejecting anything else before it
// reaches a filesystem path prevents path traversal via a crafted `id`
// (e.g. "../../../.ssh/id_rsa") in any draft tool call.
const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const draftPath = (draftsDir: string, id: string) => path.join(draftsDir, `${id}.json`)

// Serializes read-modify-write sequences per draft id across all tool
// calls, so e.g. two concurrent `publish_draft` calls for the same draft
// can't both pass the "not yet published" check before either writes.
const draftLocks = createKeyedLock()
export const withDraftLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
  draftLocks.withLock(id, fn)

const clearOrSet = <K extends keyof Draft>(
  draft: Draft,
  key: K,
  value: Draft[K] | null | undefined,
): void => {
  if (value === undefined) return
  if (value === null) {
    delete draft[key]
    return
  }
  draft[key] = value
}

export class DraftStore {
  private readonly draftsDir: string

  constructor(config: Pick<Config, "draftsDir">) {
    this.draftsDir = config.draftsDir
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.draftsDir, { recursive: true })
  }

  async create(input: CreateDraftInput): Promise<Draft> {
    await this.ensureDir()
    const now = new Date().toISOString()
    const draft: Draft = {
      id: randomUUID(),
      channel: input.channel,
      text: input.text,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    }
    if (input.poll) draft.poll = input.poll
    if (input.mediaPaths && input.mediaPaths.length > 0) draft.mediaPaths = input.mediaPaths
    if (input.parts) draft.parts = input.parts
    if (input.quoteTweetId) draft.quoteTweetId = input.quoteTweetId
    if (input.communityId) draft.communityId = input.communityId
    if (input.shareWithFollowers !== undefined) draft.shareWithFollowers = input.shareWithFollowers
    if (input.paidPartnership !== undefined) draft.paidPartnership = input.paidPartnership
    if (input.allowLinksInMainPost) draft.allowLinksInMainPost = true
    await this.write(draft)
    return draft
  }

  async get(id: string): Promise<Draft> {
    if (!DRAFT_ID_RE.test(id)) throw new DraftNotFoundError(id)

    await this.ensureDir()
    try {
      const raw = await readFile(draftPath(this.draftsDir, id), "utf8")
      return JSON.parse(raw) as Draft
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DraftNotFoundError(id)
      }
      throw error
    }
  }

  async list(status?: DraftStatus): Promise<Draft[]> {
    await this.ensureDir()
    const files = await readdir(this.draftsDir)
    const parsed = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const raw = await readFile(path.join(this.draftsDir, file), "utf8")
            return JSON.parse(raw) as Draft
          } catch (error) {
            console.error(
              `Skipping unreadable draft file "${file}":`,
              error instanceof Error ? error.message : error,
            )
            return undefined
          }
        }),
    )
    const drafts = parsed.filter((draft): draft is Draft => draft !== undefined)
    const filtered = status ? drafts.filter((draft) => draft.status === status) : drafts
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async updateText(id: string, text: string): Promise<Draft> {
    return this.update(id, { text })
  }

  async update(id: string, input: UpdateDraftInput): Promise<Draft> {
    const draft = await this.get(id)
    if (draft.status === "published" || draft.status === "deleted") {
      throw new InvalidDraftTransitionError(id, draft.status, draft.status)
    }

    const liveIds = recordedLiveIds(draft)
    if (liveIds.length > 0) {
      // Partial thread publish (or similar): resetting would orphan live posts
      // and let a later publish_draft double-post.
      throw new DraftHasLivePostsError(id, liveIds)
    }

    // Editing content is meant to send a draft back through approval, whether
    // it was previously approved or rejected. "publishing" is included so a
    // draft stuck there after a crashed/interrupted publish attempt (with no
    // recorded live ids) can be manually reconciled and re-approved.
    const resetsToDraft =
      draft.status === "approved" || draft.status === "rejected" || draft.status === "publishing"

    if (input.text !== undefined) draft.text = input.text
    clearOrSet(draft, "poll", input.poll)
    // Empty mediaPaths means "clear" — never persist [].
    clearOrSet(
      draft,
      "mediaPaths",
      input.mediaPaths !== undefined && input.mediaPaths !== null && input.mediaPaths.length === 0
        ? null
        : input.mediaPaths,
    )
    clearOrSet(draft, "parts", input.parts)
    clearOrSet(draft, "quoteTweetId", input.quoteTweetId)
    clearOrSet(draft, "communityId", input.communityId)
    clearOrSet(draft, "shareWithFollowers", input.shareWithFollowers)
    clearOrSet(draft, "paidPartnership", input.paidPartnership)
    clearOrSet(draft, "allowLinksInMainPost", input.allowLinksInMainPost)

    if (draft.parts !== undefined && input.text === undefined) {
      draft.text = draft.parts[0]!
    }
    if (draft.parts !== undefined && input.text !== undefined) {
      draft.parts = [input.text, ...draft.parts.slice(1)]
    }

    draft.status = resetsToDraft ? "draft" : draft.status
    draft.updatedAt = new Date().toISOString()
    await this.write(draft)
    return draft
  }

  async approve(id: string): Promise<Draft> {
    const draft = await this.get(id)
    if (draft.status !== "draft") {
      throw new InvalidDraftTransitionError(id, draft.status, "approved")
    }
    const updated: Draft = { ...draft, status: "approved", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async reject(id: string): Promise<Draft> {
    const draft = await this.get(id)
    // "publishing" is allowed through here too: it's the manual-reconciliation
    // path for a draft stuck mid-publish after a crash (see beginPublishing),
    // once the caller has verified the post did NOT go out (no recorded ids).
    if (draft.status === "published" || draft.status === "deleted") {
      throw new InvalidDraftTransitionError(id, draft.status, "rejected")
    }
    const liveIds = recordedLiveIds(draft)
    if (liveIds.length > 0) {
      throw new DraftHasLivePostsError(id, liveIds)
    }
    const updated: Draft = { ...draft, status: "rejected", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  /**
   * Marks a draft as actively being published, before the X API call
   * happens. This is a safety net: if the process dies between the tweet
   * being created and `markPublished` recording that fact, the draft is
   * left in "publishing" (not "approved"), so a later `publish_draft` call
   * refuses to retry and risk posting a duplicate tweet.
   */
  async beginPublishing(id: string): Promise<Draft> {
    const draft = await this.get(id)
    const updated: Draft = { ...draft, status: "publishing", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  /** Reverts a "publishing" draft back to a given status, e.g. after a failed API call that never reached X. */
  async revertPublishing(id: string, status: DraftStatus): Promise<Draft> {
    const draft = await this.get(id)
    const updated: Draft = { ...draft, status, updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async markPublished(
    id: string,
    result: { externalId: string; url: string; externalIds?: string[]; urls?: string[] },
  ): Promise<Draft> {
    const draft = await this.get(id)
    const now = new Date().toISOString()
    const externalIds = result.externalIds ?? [result.externalId]
    const urls = result.urls ?? [result.url]
    const updated: Draft = {
      ...draft,
      status: "published",
      externalId: externalIds[0] ?? result.externalId,
      url: urls[0] ?? result.url,
      externalIds,
      urls,
      publishedAt: now,
      updatedAt: now,
    }
    await this.write(updated)
    return updated
  }

  /** Persist ids/urls from a partial thread publish; leave status as publishing. */
  async recordPartialPublish(
    id: string,
    result: { externalIds: string[]; urls: string[] },
  ): Promise<Draft> {
    const draft = await this.get(id)
    const updated: Draft = {
      ...draft,
      status: "publishing",
      externalId: result.externalIds[0],
      url: result.urls[0],
      externalIds: result.externalIds,
      urls: result.urls,
      updatedAt: new Date().toISOString(),
    }
    await this.write(updated)
    return updated
  }

  async markDeleted(id: string): Promise<Draft> {
    const draft = await this.get(id)
    // Allowed from any non-deleted status so delete_published_draft can clean
    // up partial publishes and any corrupt/legacy records that still point at
    // live X posts.
    if (draft.status === "deleted") {
      throw new InvalidDraftTransitionError(id, draft.status, "deleted")
    }
    const updated: Draft = {
      ...draft,
      status: "deleted",
      updatedAt: new Date().toISOString(),
    }
    await this.write(updated)
    return updated
  }

  /**
   * After a partial delete, keep the current status but replace the remaining
   * live ids so a retry only targets posts that may still exist on X.
   */
  async setRemainingLiveIds(
    id: string,
    result: { externalIds: string[]; urls: string[] },
  ): Promise<Draft> {
    const draft = await this.get(id)
    if (draft.status === "deleted") {
      throw new InvalidDraftTransitionError(id, draft.status, "deleted")
    }
    const updated: Draft = {
      ...draft,
      externalId: result.externalIds[0],
      url: result.urls[0],
      externalIds: result.externalIds,
      urls: result.urls,
      updatedAt: new Date().toISOString(),
    }
    if (result.externalIds.length === 0) {
      delete updated.externalId
      delete updated.url
      delete updated.externalIds
      delete updated.urls
    }
    await this.write(updated)
    return updated
  }

  /**
   * After a successful edit, X returns a new post id. Replace the root
   * externalId/url (and index 0 of the arrays) while keeping later thread ids.
   */
  async applyEdit(
    id: string,
    result: {
      text: string
      externalId: string
      url: string
      paidPartnership?: boolean | null
    },
  ): Promise<Draft> {
    const draft = await this.get(id)
    if (draft.status !== "published") {
      throw new InvalidDraftTransitionError(id, draft.status, "published")
    }

    const externalIds = [...(draft.externalIds ?? (draft.externalId ? [draft.externalId] : []))]
    const urls = [...(draft.urls ?? (draft.url ? [draft.url] : []))]
    if (externalIds.length === 0) {
      externalIds.push(result.externalId)
      urls.push(result.url)
    } else {
      externalIds[0] = result.externalId
      urls[0] = result.url
    }

    draft.text = result.text
    if (draft.parts !== undefined && draft.parts.length > 0) {
      draft.parts = [result.text, ...draft.parts.slice(1)]
    }
    draft.externalId = result.externalId
    draft.url = result.url
    draft.externalIds = externalIds
    draft.urls = urls
    draft.updatedAt = new Date().toISOString()

    if (result.paidPartnership === null) {
      delete draft.paidPartnership
    } else if (result.paidPartnership !== undefined) {
      draft.paidPartnership = result.paidPartnership
    }

    await this.write(draft)
    return draft
  }

  private async write(draft: Draft): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(draftPath(this.draftsDir, draft.id), JSON.stringify(draft, null, 2), {
      mode: PRIVATE_FILE_MODE,
    })
  }
}
