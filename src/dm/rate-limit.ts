import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import { writeFileAtomic } from "../util/atomic-write.js"
import { createKeyedLock } from "../util/lock.js"

export class DmRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DmRateLimitError"
  }
}

type RateLimitState = {
  sentAt: number[]
  lastSentAt?: number
}

const lock = createKeyedLock()
const STATE_KEY = "dm-rate-limit"

const pruneSentAt = (sentAt: number[], now: number): number[] =>
  sentAt.filter((timestamp) => now - timestamp <= 86_400_000)

export class DmRateLimiter {
  private readonly statePath: string
  private readonly maxPerHour: number
  private readonly maxPerDay: number
  private readonly minIntervalMs: number

  constructor(config: Pick<Config, "dataDir" | "dmRateLimit">) {
    this.statePath = path.join(config.dataDir, "dm-rate-limit.json")
    this.maxPerHour = config.dmRateLimit.maxPerHour
    this.maxPerDay = config.dmRateLimit.maxPerDay
    this.minIntervalMs = config.dmRateLimit.minIntervalMs
  }

  private async readState(): Promise<RateLimitState> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    try {
      const raw = await readFile(this.statePath, "utf8")
      const parsed = JSON.parse(raw) as RateLimitState
      return {
        sentAt: Array.isArray(parsed.sentAt) ? parsed.sentAt : [],
        lastSentAt: typeof parsed.lastSentAt === "number" ? parsed.lastSentAt : undefined,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sentAt: [] }
      }
      throw error
    }
  }

  private async writeState(state: RateLimitState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    await writeFileAtomic(this.statePath, JSON.stringify(state, null, 2))
  }

  private assertWithinLimits(
    sentAt: number[],
    lastSentAt: number | undefined,
    now: number,
  ): void {
    if (lastSentAt !== undefined && now - lastSentAt < this.minIntervalMs) {
      const waitSecs = Math.ceil((this.minIntervalMs - (now - lastSentAt)) / 1000)
      throw new DmRateLimitError(
        `DM rate limit: wait ${waitSecs}s before sending another message (min interval ${this.minIntervalMs}ms).`,
      )
    }

    const inLastHour = sentAt.filter((timestamp) => now - timestamp <= 3_600_000).length
    if (inLastHour >= this.maxPerHour) {
      throw new DmRateLimitError(
        `DM rate limit: ${this.maxPerHour} messages per hour reached. Try again later.`,
      )
    }

    if (sentAt.length >= this.maxPerDay) {
      throw new DmRateLimitError(
        `DM rate limit: ${this.maxPerDay} messages per day reached. Try again tomorrow.`,
      )
    }
  }

  /** Throws DmRateLimitError when a send would exceed configured limits. */
  async assertCanSend(now: number = Date.now()): Promise<void> {
    await lock.withLock(STATE_KEY, async () => {
      const state = await this.readState()
      const sentAt = pruneSentAt(state.sentAt, now)
      this.assertWithinLimits(sentAt, state.lastSentAt, now)
    })
  }

  /** Atomically checks limits and records a send slot. Call immediately before the X API request. */
  async reserveSendSlot(now: number = Date.now()): Promise<void> {
    await lock.withLock(STATE_KEY, async () => {
      const state = await this.readState()
      const sentAt = pruneSentAt(state.sentAt, now)
      this.assertWithinLimits(sentAt, state.lastSentAt, now)
      sentAt.push(now)
      await this.writeState({ sentAt, lastSentAt: now })
    })
  }

  async recordSend(now: number = Date.now()): Promise<void> {
    await this.reserveSendSlot(now)
  }

  /** For tests and diagnostics. */
  async snapshot(now: number = Date.now()): Promise<{
    sentLastHour: number
    sentLastDay: number
    maxPerHour: number
    maxPerDay: number
    minIntervalMs: number
  }> {
    const state = await this.readState()
    const sentAt = pruneSentAt(state.sentAt, now)
    return {
      sentLastHour: sentAt.filter((timestamp) => now - timestamp <= 3_600_000).length,
      sentLastDay: sentAt.length,
      maxPerHour: this.maxPerHour,
      maxPerDay: this.maxPerDay,
      minIntervalMs: this.minIntervalMs,
    }
  }
}
