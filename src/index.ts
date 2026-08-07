#!/usr/bin/env node
import { createRequire } from "node:module"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { registerDraftTools } from "./tools/draft.js"
import { registerApprovalTools } from "./tools/approve.js"
import { registerPublishTools } from "./tools/publish.js"
import { registerAccountTools } from "./tools/account.js"
import { registerDmTools } from "./tools/dm.js"
import { registerAnalyticsTools } from "./tools/analytics.js"
import { registerRetweetTools } from "./tools/retweet.js"
import { registerTrendTools } from "./tools/trend.js"
import { registerSupporterSpotlightTools } from "./tools/supporterSpotlight.js"

// Read the version from package.json at runtime (via createRequire, since it lives
// outside rootDir and can't be a static import) so it can't drift from the published version.
const require = createRequire(import.meta.url)
const { version } = require("../package.json") as { version: string }

const main = async () => {
  const config = loadConfig()

  const server = new McpServer({
    name: "makers-page-mcp",
    version,
  })

  registerDraftTools(server, config)
  registerApprovalTools(server, config)
  registerPublishTools(server, config)
  registerAccountTools(server, config)
  registerDmTools(server, config)
  registerAnalyticsTools(server, config)
  registerRetweetTools(server, config)
  registerTrendTools(server, config)
  registerSupporterSpotlightTools(server, config)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error("makers-page-mcp failed to start:", error instanceof Error ? error.message : error)
  process.exit(1)
})
