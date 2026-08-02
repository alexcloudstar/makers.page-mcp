import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import type { CreateDmDraftInput, DmDraft, DmDraftStatus, UpdateDmDraftInput } from "./types.js"
import { PRIVATE_FILE_MODE, writeFileAtomic } from "../util/atomic-write.js"
import { createKeyedLock } from "../util/lock.js"

export class DmDraftNotFoundError extends Error {
  constructor(id: string) {
    super(`DM draft "${id}" was not found.`)
    this.name = "DmDraftNotFoundError"
  }
}

export class InvalidDmDraftTransitionError extends Error {
  constructor(id: string, from: DmDraftStatus, to: DmDraftStatus) {
    super(`DM draft "${id}" cannot move from "${from}" to "${to}".`)
    this.name = "InvalidDmDraftTransitionError"
  }
}

const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const draftPath = (draftsDir: string, id: string) => path.join(draftsDir, `${id}.json`)

const dmDraftLocks = createKeyedLock()
export const withDmDraftLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
  dmDraftLocks.withLock(id, fn)

const clearOrSet = <K extends keyof DmDraft>(
  draft: DmDraft,
  key: K,
  value: DmDraft[K] | null | undefined,
): void => {
  if (value === undefined) return
  if (value === null) {
    delete draft[key]
    return
  }
  draft[key] = value
}

export class DmDraftStore {
  private readonly draftsDir: string

  constructor(config: Pick<Config, "dmDraftsDir">) {
    this.draftsDir = config.dmDraftsDir
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.draftsDir, { recursive: true })
  }

  async create(input: CreateDmDraftInput): Promise<DmDraft> {
    await this.ensureDir()
    const now = new Date().toISOString()
    const draft: DmDraft = {
      id: randomUUID(),
      text: input.text,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    }
    if (input.conversationType) draft.conversationType = input.conversationType
    if (input.recipientId) draft.recipientId = input.recipientId
    if (input.recipientUsername) draft.recipientUsername = input.recipientUsername.replace(/^@/, "")
    if (input.participantIds && input.participantIds.length > 0) {
      draft.participantIds = input.participantIds
    }
    if (input.participantUsernames && input.participantUsernames.length > 0) {
      draft.participantUsernames = input.participantUsernames.map((u) => u.replace(/^@/, ""))
    }
    if (input.conversationId) draft.conversationId = input.conversationId
    if (input.mediaPaths && input.mediaPaths.length > 0) draft.mediaPaths = input.mediaPaths
    await this.write(draft)
    return draft
  }

  async get(id: string): Promise<DmDraft> {
    if (!DRAFT_ID_RE.test(id)) throw new DmDraftNotFoundError(id)

    await this.ensureDir()
    try {
      const raw = await readFile(draftPath(this.draftsDir, id), "utf8")
      return JSON.parse(raw) as DmDraft
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DmDraftNotFoundError(id)
      }
      throw error
    }
  }

  async list(status?: DmDraftStatus): Promise<DmDraft[]> {
    await this.ensureDir()
    const files = await readdir(this.draftsDir)
    const parsed = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const raw = await readFile(path.join(this.draftsDir, file), "utf8")
            return JSON.parse(raw) as DmDraft
          } catch (error) {
            console.error(
              `Skipping unreadable DM draft file "${file}":`,
              error instanceof Error ? error.message : error,
            )
            return undefined
          }
        }),
    )
    const drafts = parsed.filter((draft): draft is DmDraft => draft !== undefined)
    const filtered = status ? drafts.filter((draft) => draft.status === status) : drafts
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async update(id: string, input: UpdateDmDraftInput): Promise<DmDraft> {
    const draft = await this.get(id)
    if (draft.status === "sent" || draft.status === "deleted") {
      throw new InvalidDmDraftTransitionError(id, draft.status, draft.status)
    }
    if (draft.dmEventId) {
      throw new InvalidDmDraftTransitionError(id, draft.status, "draft")
    }

    const resetsToDraft =
      draft.status === "approved" || draft.status === "rejected" || draft.status === "sending"

    if (input.text !== undefined) draft.text = input.text
    clearOrSet(draft, "conversationType", input.conversationType)
    if (input.recipientId !== undefined) {
      clearOrSet(draft, "recipientId", input.recipientId === null ? undefined : input.recipientId)
    }
    if (input.recipientUsername !== undefined) {
      clearOrSet(
        draft,
        "recipientUsername",
        input.recipientUsername === null ? undefined : input.recipientUsername.replace(/^@/, ""),
      )
    }
    clearOrSet(
      draft,
      "participantIds",
      input.participantIds !== undefined && input.participantIds !== null && input.participantIds.length === 0
        ? null
        : input.participantIds,
    )
    clearOrSet(
      draft,
      "participantUsernames",
      input.participantUsernames !== undefined &&
        input.participantUsernames !== null &&
        input.participantUsernames.length === 0
        ? null
        : input.participantUsernames !== undefined && input.participantUsernames !== null
          ? input.participantUsernames.map((u) => u.replace(/^@/, ""))
          : input.participantUsernames,
    )
    clearOrSet(draft, "conversationId", input.conversationId)
    clearOrSet(
      draft,
      "mediaPaths",
      input.mediaPaths !== undefined && input.mediaPaths !== null && input.mediaPaths.length === 0
        ? null
        : input.mediaPaths,
    )

    draft.status = resetsToDraft ? "draft" : draft.status
    draft.updatedAt = new Date().toISOString()
    await this.write(draft)
    return draft
  }

  async approve(id: string): Promise<DmDraft> {
    const draft = await this.get(id)
    if (draft.status !== "draft") {
      throw new InvalidDmDraftTransitionError(id, draft.status, "approved")
    }
    const updated: DmDraft = { ...draft, status: "approved", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async reject(id: string): Promise<DmDraft> {
    const draft = await this.get(id)
    if (draft.status === "sent" || draft.status === "deleted") {
      throw new InvalidDmDraftTransitionError(id, draft.status, "rejected")
    }
    if (draft.dmEventId) {
      throw new InvalidDmDraftTransitionError(id, draft.status, "rejected")
    }
    const updated: DmDraft = { ...draft, status: "rejected", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async beginSending(id: string): Promise<DmDraft> {
    const draft = await this.get(id)
    const updated: DmDraft = { ...draft, status: "sending", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async revertSending(id: string, status: DmDraftStatus): Promise<DmDraft> {
    const draft = await this.get(id)
    const updated: DmDraft = { ...draft, status, updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async markSent(
    id: string,
    result: { dmEventId: string; dmConversationId: string; recipientId?: string },
  ): Promise<DmDraft> {
    const draft = await this.get(id)
    const now = new Date().toISOString()
    const updated: DmDraft = {
      ...draft,
      status: "sent",
      dmEventId: result.dmEventId,
      dmConversationId: result.dmConversationId,
      sentAt: now,
      updatedAt: now,
    }
    if (result.recipientId) updated.recipientId = result.recipientId
    await this.write(updated)
    return updated
  }

  private async write(draft: DmDraft): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(draftPath(this.draftsDir, draft.id), JSON.stringify(draft, null, 2), {
      mode: PRIVATE_FILE_MODE,
    })
  }
}
