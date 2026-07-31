import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Config } from "../config.js"
import { writeFileAtomic } from "../util/atomic-write.js"

export type Credentials = {
  accessToken: string
  refreshToken?: string
  expiresAt: string
  scope: string
}

export class CredentialStore {
  private readonly credentialsPath: string

  constructor(config: Pick<Config, "credentialsPath">) {
    this.credentialsPath = config.credentialsPath
  }

  async read(): Promise<Credentials | undefined> {
    try {
      const raw = await readFile(this.credentialsPath, "utf8")
      return JSON.parse(raw) as Credentials
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async write(credentials: Credentials): Promise<void> {
    await mkdir(path.dirname(this.credentialsPath), { recursive: true })
    await writeFileAtomic(this.credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
  }
}
