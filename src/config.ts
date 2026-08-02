import os from "node:os"
import path from "node:path"

const APP_DIR_NAME = "makers-page-mcp"

const resolveConfigDir = (): string => {
  if (process.env.MAKERS_PAGE_CONFIG_DIR) return process.env.MAKERS_PAGE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(base, APP_DIR_NAME)
}

const resolveDataDir = (): string => {
  if (process.env.MAKERS_PAGE_DATA_DIR) return process.env.MAKERS_PAGE_DATA_DIR
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  return path.join(base, APP_DIR_NAME)
}

export type Config = {
  configDir: string
  dataDir: string
  draftsDir: string
  dmDraftsDir: string
  credentialsPath: string
  requireApproval: boolean
  maxPostLength: number
  maxDmLength: number
  dmRateLimit: {
    maxPerHour: number
    maxPerDay: number
    minIntervalMs: number
  }
  x: {
    clientId: string | undefined
    clientSecret: string | undefined
    redirectUri: string
  }
}

export const DEFAULT_MAX_POST_LENGTH = 280
export const DEFAULT_MAX_DM_LENGTH = 10_000
export const DEFAULT_DM_MAX_PER_HOUR = 10
export const DEFAULT_DM_MAX_PER_DAY = 50
export const DEFAULT_DM_MIN_INTERVAL_MS = 3_000

// Exported for testing; not part of the public module surface otherwise.
export const resolveMaxPostLength = (): number => {
  const raw = process.env.MAKERS_PAGE_MAX_POST_LENGTH
  if (raw === undefined) return DEFAULT_MAX_POST_LENGTH

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Ignoring invalid MAKERS_PAGE_MAX_POST_LENGTH="${raw}" (must be a positive number); ` +
        `falling back to the default of ${DEFAULT_MAX_POST_LENGTH}.`,
    )
    return DEFAULT_MAX_POST_LENGTH
  }
  // Floor rather than reject non-integers (e.g. "280.5"): harmless to accept,
  // but a character count should be a whole number.
  return Math.floor(parsed)
}

const resolvePositiveInt = (
  envName: string,
  fallback: number,
): number => {
  const raw = process.env[envName]
  if (raw === undefined) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Ignoring invalid ${envName}="${raw}" (must be a positive number); falling back to ${fallback}.`,
    )
    return fallback
  }
  return Math.floor(parsed)
}

export const loadConfig = (): Config => {
  const configDir = resolveConfigDir()
  const dataDir = resolveDataDir()

  return {
    configDir,
    dataDir,
    draftsDir: path.join(dataDir, "drafts"),
    dmDraftsDir: path.join(dataDir, "dm-drafts"),
    credentialsPath: path.join(configDir, "credentials.json"),
    requireApproval: process.env.MAKERS_PAGE_REQUIRE_APPROVAL !== "false",
    maxPostLength: resolveMaxPostLength(),
    maxDmLength: resolvePositiveInt("MAKERS_PAGE_MAX_DM_LENGTH", DEFAULT_MAX_DM_LENGTH),
    dmRateLimit: {
      maxPerHour: resolvePositiveInt("MAKERS_PAGE_DM_MAX_PER_HOUR", DEFAULT_DM_MAX_PER_HOUR),
      maxPerDay: resolvePositiveInt("MAKERS_PAGE_DM_MAX_PER_DAY", DEFAULT_DM_MAX_PER_DAY),
      minIntervalMs: resolvePositiveInt("MAKERS_PAGE_DM_MIN_INTERVAL_MS", DEFAULT_DM_MIN_INTERVAL_MS),
    },
    x: {
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET,
      redirectUri: process.env.X_REDIRECT_URI ?? "http://127.0.0.1:8879/callback",
    },
  }
}
