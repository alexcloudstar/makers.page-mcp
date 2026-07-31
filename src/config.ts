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
  credentialsPath: string
  requireApproval: boolean
  maxPostLength: number
  x: {
    clientId: string | undefined
    clientSecret: string | undefined
    redirectUri: string
  }
}

export const loadConfig = (): Config => {
  const configDir = resolveConfigDir()
  const dataDir = resolveDataDir()

  return {
    configDir,
    dataDir,
    draftsDir: path.join(dataDir, "drafts"),
    credentialsPath: path.join(configDir, "credentials.json"),
    requireApproval: process.env.MAKERS_PAGE_REQUIRE_APPROVAL !== "false",
    maxPostLength: Number(process.env.MAKERS_PAGE_MAX_POST_LENGTH ?? 280),
    x: {
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET,
      redirectUri: process.env.X_REDIRECT_URI ?? "http://127.0.0.1:8879/callback",
    },
  }
}
