import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import type { CreateDraftInput, Draft, DraftStatus } from "./types.js"
import { writeFileAtomic } from "../util/atomic-write.js"
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
    const draft = await this.get(id)
    // Editing text is meant to send a draft back through approval, whether
    // it was previously approved or rejected. Only "published" is terminal.
    const resetsToDraft = draft.status === "approved" || draft.status === "rejected"
    const updated: Draft = {
      ...draft,
      text,
      status: resetsToDraft ? "draft" : draft.status,
      updatedAt: new Date().toISOString(),
    }
    await this.write(updated)
    return updated
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
    if (draft.status === "published" || draft.status === "publishing") {
      throw new InvalidDraftTransitionError(id, draft.status, "rejected")
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

  async markPublished(id: string, result: { externalId: string; url: string }): Promise<Draft> {
    const draft = await this.get(id)
    const now = new Date().toISOString()
    const updated: Draft = {
      ...draft,
      status: "published",
      externalId: result.externalId,
      url: result.url,
      publishedAt: now,
      updatedAt: now,
    }
    await this.write(updated)
    return updated
  }

  private async write(draft: Draft): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(draftPath(this.draftsDir, draft.id), JSON.stringify(draft, null, 2))
  }
}
