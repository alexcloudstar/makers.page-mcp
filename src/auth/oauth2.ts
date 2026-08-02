import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import type { Config } from "../config.js"
import type { CredentialStore, Credentials } from "./store.js"
import { NotAuthenticatedError } from "./errors.js"
import { createKeyedLock } from "../util/lock.js"
import { fetchWithTimeout } from "../util/fetch-with-timeout.js"

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
const TOKEN_URL = "https://api.x.com/2/oauth2/token"
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
  "media.write",
  "dm.read",
  "dm.write",
]
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000
// Refresh well before expiry: tool calls can chain (draft -> approve ->
// publish), and X's refresh tokens are single-use, so we'd rather refresh a
// bit early than race two concurrent calls into refreshing at once.
const EXPIRY_BUFFER_MS = 5 * 60_000

const refreshLocks = createKeyedLock()

const base64Url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const createPkcePair = () => {
  const codeVerifier = base64Url(randomBytes(32))
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

type TokenResponse = {
  token_type: string
  expires_in: number
  access_token: string
  refresh_token?: string
  scope: string
}

const toCredentials = (token: TokenResponse): Credentials => ({
  accessToken: token.access_token,
  refreshToken: token.refresh_token,
  expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  scope: token.scope,
})

const basicAuthHeader = (clientId: string, clientSecret?: string): string | undefined =>
  clientSecret ? `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` : undefined

const exchangeCodeForToken = async (
  config: Config,
  code: string,
  codeVerifier: string,
): Promise<Credentials> => {
  const clientId = requireClientId(config)
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: config.x.redirectUri,
    code_verifier: codeVerifier,
  })

  const authHeader = basicAuthHeader(clientId, config.x.clientSecret)
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to exchange code for token (${response.status}): ${text}`)
  }

  const token = (await response.json()) as TokenResponse
  return toCredentials(token)
}

const refreshAccessToken = async (config: Config, refreshToken: string): Promise<Credentials> => {
  const clientId = requireClientId(config)
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  })

  const authHeader = basicAuthHeader(clientId, config.x.clientSecret)
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to refresh access token (${response.status}): ${text}`)
  }

  const token = (await response.json()) as TokenResponse
  return toCredentials(token)
}

const requireClientId = (config: Config): string => {
  if (!config.x.clientId) {
    throw new Error(
      "X_CLIENT_ID is not set. Create an OAuth 2.0 app in the X developer portal and set X_CLIENT_ID (and X_CLIENT_SECRET if it's a confidential client).",
    )
  }
  return config.x.clientId
}

/**
 * Runs the interactive Authorization Code + PKCE flow: opens a local HTTP
 * server to receive the redirect, prints the authorize URL, and exchanges
 * the returned code for user access + refresh tokens.
 */
export const runAuthorizationCodeFlow = async (
  config: Config,
  onAuthorizeUrl: (url: string) => void,
): Promise<Credentials> => {
  const clientId = requireClientId(config)
  const { codeVerifier, codeChallenge } = createPkcePair()
  const state = base64Url(randomBytes(16))
  const redirectUrl = new URL(config.x.redirectUri)

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      fn()
    }

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
      if (url.pathname !== redirectUrl.pathname) {
        res.writeHead(404).end()
        return
      }

      const returnedState = url.searchParams.get("state")
      const returnedCode = url.searchParams.get("code")
      const error = url.searchParams.get("error")

      res.writeHead(200, { "Content-Type": "text/html" })
      if (error || !returnedCode || returnedState !== state) {
        res.end("<html><body>Authorization failed. You can close this tab.</body></html>")
        server.close()
        finish(() => reject(new Error(error ?? "Missing or mismatched authorization response.")))
        return
      }

      res.end("<html><body>Authorized. You can close this tab and return to your terminal.</body></html>")
      server.close()
      finish(() => resolve(returnedCode))
    })

    const timeoutTimer = setTimeout(() => {
      server.close()
      finish(() =>
        reject(
          new Error(
            `Timed out waiting for authorization after ${AUTHORIZATION_TIMEOUT_MS / 1000}s. Run "bun run auth" again.`,
          ),
        ),
      )
    }, AUTHORIZATION_TIMEOUT_MS)
    timeoutTimer.unref()

    server.listen(Number(redirectUrl.port || 80), redirectUrl.hostname, () => {
      const authorizeUrl = new URL(AUTHORIZE_URL)
      authorizeUrl.searchParams.set("response_type", "code")
      authorizeUrl.searchParams.set("client_id", clientId)
      authorizeUrl.searchParams.set("redirect_uri", config.x.redirectUri)
      authorizeUrl.searchParams.set("scope", SCOPES.join(" "))
      authorizeUrl.searchParams.set("state", state)
      authorizeUrl.searchParams.set("code_challenge", codeChallenge)
      authorizeUrl.searchParams.set("code_challenge_method", "S256")
      onAuthorizeUrl(authorizeUrl.toString())
    })

    server.on("error", (err) => finish(() => reject(err)))
  })

  return exchangeCodeForToken(config, code, codeVerifier)
}

const isExpiringSoon = (expiresAt: string): boolean =>
  new Date(expiresAt).getTime() - Date.now() < EXPIRY_BUFFER_MS

/**
 * Returns a valid access token, refreshing it first if it's expired or
 * about to expire. Refreshes are serialized per credentials file: X's
 * refresh tokens are single-use, so two concurrent tool calls both trying
 * to refresh would race and one of them would fail with `invalid_grant`.
 * We lock, then re-read credentials from disk inside the lock so a caller
 * that was waiting picks up whatever the previous holder just persisted
 * instead of refreshing again with an already-consumed token.
 */
export const ensureFreshAccessToken = async (
  config: Config,
  store: CredentialStore,
): Promise<string> =>
  refreshLocks.withLock(config.credentialsPath, async () => {
    const credentials = await store.read()
    if (!credentials) throw new NotAuthenticatedError()

    if (!isExpiringSoon(credentials.expiresAt)) {
      return credentials.accessToken
    }

    if (!credentials.refreshToken) {
      throw new Error(
        "X access token expired and no refresh token is stored. Run the auth command again.",
      )
    }

    const refreshed = await refreshAccessToken(config, credentials.refreshToken)
    const merged: Credentials = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? credentials.refreshToken,
    }
    await store.write(merged)
    return merged.accessToken
  })
