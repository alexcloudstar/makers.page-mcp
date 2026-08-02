import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DmRateLimiter, DmRateLimitError } from "./rate-limit.js"
import type { Config } from "../config.js"

let dataDir: string
let config: Config

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "dm-rate-"))
  config = {
    dataDir,
    dmRateLimit: { maxPerHour: 2, maxPerDay: 5, minIntervalMs: 1000 },
  } as Config
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe("DmRateLimiter", () => {
  test("allows sends under limits", async () => {
    const limiter = new DmRateLimiter(config)
    await limiter.assertCanSend()
    await limiter.recordSend()
    await limiter.assertCanSend(Date.now() + 2000)
  })

  test("blocks when min interval not elapsed", async () => {
    const limiter = new DmRateLimiter(config)
    const now = Date.now()
    await limiter.recordSend(now)
    await expect(limiter.assertCanSend(now + 500)).rejects.toThrow(DmRateLimitError)
  })

  test("blocks when hourly limit reached", async () => {
    const limiter = new DmRateLimiter(config)
    const now = Date.now()
    await limiter.recordSend(now - 3000)
    await limiter.recordSend(now - 2000)
    await expect(limiter.assertCanSend(now)).rejects.toThrow(/hour/)
  })
})
