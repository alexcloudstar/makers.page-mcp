#!/usr/bin/env node
import { loadConfig } from "../config.js"
import { runAuthorizationCodeFlow } from "./oauth2.js"
import { CredentialStore } from "./store.js"

const main = async () => {
  const config = loadConfig()
  const store = new CredentialStore(config)

  console.error("Starting X OAuth 2.0 (PKCE) authorization...")
  console.error(`Redirect URI: ${config.x.redirectUri}`)
  console.error(
    "Make sure this exact URI is registered as a callback URL for your app in the X developer portal.\n",
  )

  const credentials = await runAuthorizationCodeFlow(config, (authorizeUrl) => {
    console.error("Open this URL in your browser to authorize makers-page-mcp:\n")
    console.error(authorizeUrl)
    console.error("\nWaiting for authorization...")
  })

  await store.write(credentials)
  console.error(`\nAuthorized. Credentials saved to ${config.credentialsPath}`)
}

main().catch((error) => {
  console.error("\nAuthorization failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
