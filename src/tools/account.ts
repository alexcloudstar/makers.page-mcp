import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "../config.js"
import { XClient, NotAuthenticatedError, XApiError } from "../channels/x/client.js"

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

export const registerAccountTools = (server: McpServer, config: Config): void => {
  const xClient = new XClient(config)

  server.registerTool(
    "get_x_account",
    {
      title: "Get connected X account",
      description:
        "Check whether this MCP server is connected to an X account and, if so, return the account's username and id.",
      inputSchema: {},
    },
    async () => {
      const connected = await xClient.isConnected()
      if (!connected) {
        return errorResult(
          "Not connected to X. Run the auth command described in the README to authorize this server with your X account.",
        )
      }

      try {
        const me = await xClient.getMe()
        return textResult(`Connected to X as @${me.username} (${me.name}).`)
      } catch (error) {
        if (error instanceof NotAuthenticatedError) return errorResult(error.message)
        if (error instanceof XApiError) return errorResult(`X API error (${error.status}): ${error.message}`)
        throw error
      }
    },
  )
}
