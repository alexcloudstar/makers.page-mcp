import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import type { CreateRetweetDraftInput, RetweetDraft, RetweetDraftStatus } from "./types.js"
import { writeFileAtomic } from "../util/atomic-write.js"
import { createKeyedLock } from "../util/lock.js"

export class RetweetDraftNotFoundError extends Error {
  constructor(id: string) {
    super(`Retweet draft "${id}" was not found.`)
    this.name = "RetweetDraftNotFoundError"
  }
}

export class InvalidRetweetDraftTransitionError extends Error {
  constructor(id: string, from: RetweetDraftStatus, to: RetweetDraftStatus) {
    super(`Retweet draft "${id}" cannot move from "${from}" to "${to}".`)
    this.name = "InvalidRetweetDraftTransitionError"
  }
}

const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const draftPath = (draftsDir: string, id: string) => path.join(draftsDir, `${id}.json`)

const retweetDraftLocks = createKeyedLock()
export const withRetweetDraftLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
  retweetDraftLocks.withLock(id, fn)

export class RetweetDraftStore {
  private readonly draftsDir: string

  constructor(config: Pick<Config, "retweetDraftsDir">) {
    this.draftsDir = config.retweetDraftsDir
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.draftsDir, { recursive: true })
  }

  async create(input: CreateRetweetDraftInput): Promise<RetweetDraft> {
    await this.ensureDir()
    const now = new Date().toISOString()
    const draft: RetweetDraft = {
      id: randomUUID(),
      tweetId: input.tweetId.trim(),
      action: input.action,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      tweetUrl: `https://x.com/i/web/status/${input.tweetId.trim()}`,
    }
    await this.write(draft)
    return draft
  }

  async get(id: string): Promise<RetweetDraft> {
    if (!DRAFT_ID_RE.test(id)) throw new RetweetDraftNotFoundError(id)

    await this.ensureDir()
    try {
      const raw = await readFile(draftPath(this.draftsDir, id), "utf8")
      return JSON.parse(raw) as RetweetDraft
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RetweetDraftNotFoundError(id)
      }
      throw error
    }
  }

  async list(status?: RetweetDraftStatus): Promise<RetweetDraft[]> {
    await this.ensureDir()
    const files = await readdir(this.draftsDir)
    const parsed = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const raw = await readFile(path.join(this.draftsDir, file), "utf8")
            return JSON.parse(raw) as RetweetDraft
          } catch (error) {
            console.error(
              `Skipping unreadable retweet draft file "${file}":`,
              error instanceof Error ? error.message : error,
            )
            return undefined
          }
        }),
    )
    const drafts = parsed.filter((draft): draft is RetweetDraft => draft !== undefined)
    const filtered = status ? drafts.filter((draft) => draft.status === status) : drafts
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async approve(id: string): Promise<RetweetDraft> {
    const draft = await this.get(id)
    if (draft.status !== "draft") {
      throw new InvalidRetweetDraftTransitionError(id, draft.status, "approved")
    }
    const updated: RetweetDraft = { ...draft, status: "approved", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async reject(id: string): Promise<RetweetDraft> {
    const draft = await this.get(id)
    if (draft.status === "completed" || draft.status === "deleted") {
      throw new InvalidRetweetDraftTransitionError(id, draft.status, "rejected")
    }
    const updated: RetweetDraft = { ...draft, status: "rejected", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async beginExecuting(id: string): Promise<RetweetDraft> {
    const draft = await this.get(id)
    const updated: RetweetDraft = { ...draft, status: "executing", updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async revertExecuting(id: string, status: RetweetDraftStatus): Promise<RetweetDraft> {
    const draft = await this.get(id)
    const updated: RetweetDraft = { ...draft, status, updatedAt: new Date().toISOString() }
    await this.write(updated)
    return updated
  }

  async markCompleted(id: string): Promise<RetweetDraft> {
    const draft = await this.get(id)
    const now = new Date().toISOString()
    const updated: RetweetDraft = {
      ...draft,
      status: "completed",
      executedAt: now,
      updatedAt: now,
    }
    await this.write(updated)
    return updated
  }

  private async write(draft: RetweetDraft): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(draftPath(this.draftsDir, draft.id), JSON.stringify(draft, null, 2))
  }
}
