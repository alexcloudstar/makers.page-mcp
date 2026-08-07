import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import type { SpotlightStorage, StoredSpotlight, Supporter } from "./types.js"
import { PRIVATE_FILE_MODE, writeFileAtomic } from "../util/atomic-write.js"
import { createKeyedLock } from "../util/lock.js"

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

const spotlightPath = (spotlightsDir: string, dateKey: string) => path.join(spotlightsDir, `${dateKey}.json`)

const spotlightLocks = createKeyedLock()

export class SpotlightStore implements SpotlightStorage {
  private readonly spotlightsDir: string

  constructor(config: Pick<Config, "spotlightsDir">) {
    this.spotlightsDir = config.spotlightsDir
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.spotlightsDir, { recursive: true })
  }

  async get(dateKey: string): Promise<StoredSpotlight | undefined> {
    if (!DATE_KEY_RE.test(dateKey)) return undefined

    await this.ensureDir()
    try {
      const raw = await readFile(spotlightPath(this.spotlightsDir, dateKey), "utf8")
      return JSON.parse(raw) as StoredSpotlight
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async save(dateKey: string, supporters: Supporter[]): Promise<StoredSpotlight> {
    return spotlightLocks.withLock(dateKey, async () => {
      const existing = await this.get(dateKey)
      const spotlight: StoredSpotlight = {
        date: dateKey,
        supporters,
        generatedPost: existing?.generatedPost ?? "",
      }
      await this.write(spotlight)
      return spotlight
    })
  }

  async setGeneratedPost(dateKey: string, generatedPost: string): Promise<StoredSpotlight | undefined> {
    return spotlightLocks.withLock(dateKey, async () => {
      const existing = await this.get(dateKey)
      if (!existing) return undefined
      const spotlight: StoredSpotlight = { ...existing, generatedPost }
      await this.write(spotlight)
      return spotlight
    })
  }

  private async write(spotlight: StoredSpotlight): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(spotlightPath(this.spotlightsDir, spotlight.date), JSON.stringify(spotlight, null, 2), {
      mode: PRIVATE_FILE_MODE,
    })
  }
}
