# Marketing Assistant MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets your coding agent (Cursor, Claude Code, etc.) draft, get human approval for, and publish posts to **X** using the X API v2. Nothing ships until you approve it.

v1 supports **X only**. Every post is a `draft` until you call `approve_draft`, and `publish_draft` refuses to post anything that hasn't been approved.

## Cost per post

As of 2026, X's API is pay-per-use for self-serve developer accounts: creating a post costs **$0.015** (plain text) or **$0.20** (if the post contains a URL), charged against credits you prepay in the [X developer console](https://developer.x.com). There's no free write tier anymore. Every `publish_draft` call is a real charge — treat it accordingly (approve deliberately, don't script bulk test-publishing).

## 1. Create an X developer app

1. Go to the [X developer portal](https://developer.x.com) and create (or open) a project + app.
2. Under **User authentication settings**, enable **OAuth 2.0**.
3. Set **App permissions** to **Read and write**.
4. Set the **Type of App** to **Web App, Automated App or Bot** (this gives you a Client ID, and a Client Secret if confidential).
5. Add an exact-match **Callback URI / Redirect URL**: `http://127.0.0.1:8879/callback`
   (or your own value — just set `X_REDIRECT_URI` to match in step 3 below).
6. Copy the **Client ID** (and **Client Secret**, if shown).

## 2. Install

Pick one:

**Option A — npm (recommended, no clone needed):**

```bash
npx -y makers-page-mcp-auth   # run once to authorize, see step 3
```

`npx`/`bunx` fetch and cache the package on first run — nothing to build yourself.

**Option B — from source:**

```bash
git clone https://github.com/alexcloudstar/makers.page-mcp.git
cd makers.page-mcp/mcp
bun install
bun run build
```

## 3. Set credentials and authorize

Set these environment variables (from your X developer app, step 1):

```bash
export X_CLIENT_ID=your-client-id
export X_CLIENT_SECRET=your-client-secret   # omit if your app is a public client
export X_REDIRECT_URI=http://127.0.0.1:8879/callback  # must match the portal exactly
```

If you're building from source, you can instead copy `.env.example` to `.env` and fill in the same values — Bun loads `.env` automatically for anything run with `bun` (`bun run auth`, `bun run dev`, `bun dist/index.js`). `.env` is gitignored, so your keys never get committed.

Run the one-time authorization flow:

```bash
npx -y makers-page-mcp-auth   # npm install
bun run auth                  # from source
```

This prints an authorize URL — open it, log in as the X account you want to post from, and approve. The server captures the redirect locally and stores an access + refresh token at `~/.config/makers-page-mcp/credentials.json`. Tokens auto-refresh on future use; you shouldn't need to run this again unless you revoke access.

## 4. Connect it to your coding agent

Add to your Cursor `mcp.json` (Settings → MCP, or `~/.cursor/mcp.json`) — the same shape works for Claude Desktop/Code, Codex, GitHub Copilot, and other MCP clients, just under each tool's own config file:

**If you installed via npm:**

```json
{
  "mcpServers": {
    "makers-page": {
      "command": "npx",
      "args": ["-y", "makers-page-mcp"],
      "env": {
        "X_CLIENT_ID": "your-client-id",
        "X_CLIENT_SECRET": "your-client-secret",
        "X_REDIRECT_URI": "http://127.0.0.1:8879/callback"
      }
    }
  }
}
```

(`bunx` works the same way if you'd rather use Bun: `"command": "bunx", "args": ["-y", "makers-page-mcp"]`.)

**If you built from source:**

```json
{
  "mcpServers": {
    "makers-page": {
      "command": "bun",
      "args": ["--env-file=/absolute/path/to/mcp/.env", "/absolute/path/to/mcp/dist/index.js"]
    }
  }
}
```

Bun's automatic `.env` loading is relative to the process's working directory, which most MCP clients don't guarantee is `mcp/`. The explicit `--env-file` flag above points straight at your `.env` regardless of where the server is launched from, so you don't have to duplicate credentials inside `mcp.json` itself.

## Tools

| Tool | What it does |
|------|--------------|
| `create_draft` | Save a new draft post (`{ channel: "x", text }`). |
| `list_drafts` | List drafts, optionally filtered by status. |
| `get_draft` | Fetch a single draft by id. |
| `update_draft` | Edit a draft's text. Resets an approved or rejected draft back to `draft` so it can be re-approved. |
| `approve_draft` | Mark a draft approved. Required before publishing (unless approvals are disabled). |
| `reject_draft` | Mark a draft rejected. Also the way to manually reconcile a draft stuck in `publishing` after a crashed/interrupted publish attempt. |
| `publish_draft` | Publish an approved draft to X via `POST /2/tweets`. Returns the live URL. If the request fails ambiguously (e.g. a timeout), the draft is left in `publishing` rather than auto-retried, to avoid a duplicate paid post — see below. |
| `get_x_account` | Check connection status and show the connected `@handle`. |

Typical agent flow: `create_draft` → show the user the draft → user says "approve" → `approve_draft` → `publish_draft`.

### If a publish attempt fails ambiguously

`publish_draft` marks a draft `publishing` before calling the X API, and only clears that if the API gives a
definitive answer (a real HTTP response, or a clear "not authenticated" error). If the request instead fails
in a way that could mean X received it anyway — a timeout or network drop — the draft is deliberately left in
`publishing` and **not** auto-reverted, so an agent can't retry and risk a second, real, paid post. In that
case: check your X account for the post yourself, then call `reject_draft` (if it didn't go out) or
`update_draft` (to edit and reset it to `draft`) to reconcile the local record.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `X_CLIENT_ID` | — | Required. X OAuth 2.0 Client ID. |
| `X_CLIENT_SECRET` | — | Set if your X app is a confidential client. |
| `X_REDIRECT_URI` | `http://127.0.0.1:8879/callback` | Must match the callback registered in the X developer portal. |
| `MAKERS_PAGE_CONFIG_DIR` | `~/.config/makers-page-mcp` | Where credentials are stored. |
| `MAKERS_PAGE_DATA_DIR` | `~/.local/share/makers-page-mcp` | Where drafts are stored. |
| `MAKERS_PAGE_REQUIRE_APPROVAL` | `true` | Set to `false` to let agents publish drafts without a separate approval step. |
| `MAKERS_PAGE_MAX_POST_LENGTH` | `280` | Max characters per post (X's weighted count — URLs count as 23, emoji count once); raise this if you're on X Premium. |

## Development

```bash
bun test        # run the unit test suite
bun run typecheck
```

## Scope of v1

- Text-only posts to X (no media, threads, or polls).
- No other channels yet (LinkedIn, Reddit, etc. are planned but not implemented).
- Local-only: drafts and credentials live on your machine, not in the cloud.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and PR guidelines.

## Security

Found a vulnerability? Please don't open a public issue — see [SECURITY.md](SECURITY.md) for how to report it privately.

## License

[MIT](LICENSE) — see the [changelog](CHANGELOG.md) for release notes.
