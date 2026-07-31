export class NotAuthenticatedError extends Error {
  constructor() {
    super(
      "Not connected to X yet. Run the auth command (see README) to authorize this MCP server with your X account.",
    )
    this.name = "NotAuthenticatedError"
  }
}
