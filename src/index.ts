#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { registerDraftTools } from "./tools/draft.js"
import { registerApprovalTools } from "./tools/approve.js"
import { registerPublishTools } from "./tools/publish.js"
import { registerAccountTools } from "./tools/account.js"

const main = async () => {
  const config = loadConfig()

  const server = new McpServer({
    name: "makers-page-mcp",
    version: "0.1.0",
  })

  registerDraftTools(server, config)
  registerApprovalTools(server, config)
  registerPublishTools(server, config)
  registerAccountTools(server, config)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error("makers-page-mcp failed to start:", error instanceof Error ? error.message : error)
  process.exit(1)
})
