# Marketing Assistant MCP

**The [Model Context Protocol](https://modelcontextprotocol.io) server that turns "I just shipped this" into a published post on X, without leaving your coding agent.**

`makers-page-mcp` runs locally next to Cursor, Claude Code, Codex, or any other MCP client. Your agent drafts a channel-native post about what you just built, you read it and say "approve," and it goes out through the real X API v2. Nothing publishes without a human in the loop, and every draft, approval, and post lives in a local, auditable file, not a third-party dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/makers-page-mcp.svg)](https://www.npmjs.com/package/makers-page-mcp)
[![npm downloads](https://img.shields.io/npm/dm/makers-page-mcp.svg)](https://www.npmjs.com/package/makers-page-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.alexcloudstar%2Fmakers--page--mcp-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.alexcloudstar/makers-page-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1-fbf0df?logo=bun&logoColor=black)](package.json)

Part of [makers.page](https://makers.page), Marketing Assistant for indie startups.

---

<details>
<summary><strong>Table of contents</strong></summary>

- [Why this exists](#why-this-exists)
- [How it compares](#how-it-compares)
- [Cost per post](#cost-per-post)
- [Quick start](#quick-start)
  - [1. Create an X developer app](#1-create-an-x-developer-app)
  - [2. Install](#2-install)
  - [3. Set credentials and authorize](#3-set-credentials-and-authorize)
  - [4. Connect it to your coding agent](#4-connect-it-to-your-coding-agent)
- [Works with any MCP client](#works-with-any-mcp-client)
- [Tools](#tools)
- [If a publish attempt fails ambiguously](#if-a-publish-attempt-fails-ambiguously)
- [Configuration](#configuration)
- [Roadmap](#roadmap)
- [Development](#development)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

</details>

---

## Why this exists

Coding agents already have an MCP for your docs, your issue tracker, your database. This is the one for telling people what you built, without you having to open X, retype the release note in the right voice, and hit publish yourself.

- **Agent-native, not another dashboard.** Same protocol, same config file as your other MCP servers. No new app to log into.
- **Approval-gated by default.** Every post is a `draft` until you explicitly call `approve_draft`. `publish_draft` refuses to post anything that hasn't been approved, unless you turn that off yourself.
- **Built for real, paid API calls.** X's write API costs money per post (see below). The draft/approve/publish split exists so an agent can never spam your account or your wallet.
- **Crash-safe by design.** Publishing uses atomic file writes, keyed locks around concurrent operations on the same draft, and a three-way error split (definitive failure, ambiguous network failure, unexpected error) so a dropped connection can never turn into a silent duplicate post.
- **Local-first.** Drafts and credentials live on your machine (`~/.local/share/makers-page-mcp`, `~/.config/makers-page-mcp`), not in someone else's cloud.
- **Zero lock-in.** It's a stdio MCP server distributed on npm under the MIT license. Read the source, fork it, self-host it.

## How it compares

| | Manual posting | Buffer / Hootsuite | Zapier / Make | **Marketing Assistant MCP** |
|---|---|---|---|---|
| Lives inside your coding agent | No | No | No | **Yes** |
| Writes channel-native copy from what you just shipped | No | No | Only with extra prompting glue | **Yes** |
| Requires a new app / dashboard login | No | Yes | Yes | **No** |
| Human approval before anything ships | Depends on you | No (auto-scheduled) | No (auto-triggered) | **Yes, by default** |
| Open source / self-hostable | *(n/a)* | No | No | **Yes (MIT)** |
| Where data lives | You | Their servers | Their servers | **Your machine** |

## Cost per post

As of 2026, X's API is pay-per-use for self-serve developer accounts: creating a post costs **$0.015** (plain text) or **$0.20** (if the post contains a URL), charged against credits you prepay in the [X developer console](https://developer.x.com). There's no free write tier anymore. Every `publish_draft` call is a real charge: treat it accordingly (approve deliberately, don't script bulk test-publishing).

## Quick start

### 1. Create an X developer app

1. Go to the [X developer portal](https://developer.x.com) and create (or open) a project + app.
2. Under **User authentication settings**, enable **OAuth 2.0**.
3. Set **App permissions** to **Read and write**.
4. Set the **Type of App** to **Web App, Automated App or Bot** (this gives you a Client ID, and a Client Secret if confidential).
5. Add an exact-match **Callback URI / Redirect URL**: `http://127.0.0.1:8879/callback`
   (or your own value; just set `X_REDIRECT_URI` to match in step 3 below).
6. Copy the **Client ID** (and **Client Secret**, if shown).

### 2. Install

Pick one:

**Option A: npm (recommended, no clone needed)**

```bash
npx -y makers-page-mcp-auth   # run once to authorize, see step 3
```

`npx`/`bunx` fetch and cache the package on first run; nothing to build yourself.

**Option B: from source**

```bash
git clone https://github.com/alexcloudstar/makers.page-mcp.git
cd makers.page-mcp/mcp
bun install
bun run build
```

### 3. Set credentials and authorize

Set these environment variables (from your X developer app, step 1):

```bash
export X_CLIENT_ID=your-client-id
export X_CLIENT_SECRET=your-client-secret   # omit if your app is a public client
export X_REDIRECT_URI=http://127.0.0.1:8879/callback  # must match the portal exactly
```

If you're building from source, you can instead copy `.env.example` to `.env` and fill in the same values. Bun loads `.env` automatically for anything run with `bun` (`bun run auth`, `bun run dev`, `bun dist/index.js`). `.env` is gitignored, so your keys never get committed.

Run the one-time authorization flow:

```bash
npx -y makers-page-mcp-auth   # npm install
bun run auth                  # from source
```

This prints an authorize URL: open it, log in as the X account you want to post from, and approve. The server captures the redirect locally and stores an access + refresh token at `~/.config/makers-page-mcp/credentials.json`. Tokens auto-refresh on future use; you shouldn't need to run this again unless you revoke access.

### 4. Connect it to your coding agent

Add to your Cursor `mcp.json` (Settings → MCP, or `~/.cursor/mcp.json`). The same shape works for Claude Desktop/Code, Codex, GitHub Copilot, and other MCP clients, just under each tool's own config file:

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

## Works with any MCP client

This server only uses the standard MCP `stdio` transport: no client-specific extensions, no remote/HTTP requirement. That means the same `command`/`args`/`env` block above works everywhere, just under each client's own config file:

| Client | Config file |
|---|---|
| **Cursor** | `~/.cursor/mcp.json` (or Settings → MCP) |
| **Claude Desktop** | `claude_desktop_config.json` |
| **Claude Code** | `.mcp.json` (project) or `~/.claude.json` (user) |
| **OpenAI Codex** (CLI, Desktop, IDE extension) | `~/.codex/config.toml`, or run `codex mcp add makers-page -- npx -y makers-page-mcp` |
| **Google Gemini CLI** | `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project), or `gemini mcp add` |
| **GitHub Copilot** (VS Code, Copilot SDK) | `.vscode/mcp.json` or `mcp.json` |
| **Windsurf** (Cascade) | `~/.codeium/windsurf/mcp_config.json`, same `command`/`args` shape as Cursor |
| **Cline** (VS Code / JetBrains extension) | its MCP settings panel, or the underlying `cline_mcp_settings.json` |
| **Zed** | `settings.json` → `context_servers` |
| **JetBrains AI Assistant** (IntelliJ, PyCharm, WebStorm, ...) | Settings → Tools → AI Assistant → MCP Servers → Add (stdio) |

All of these read the same `mcpServers`-style JSON (Gemini CLI and JetBrains use slightly different top-level keys, `mcpServers` and a UI form respectively, but the same `command`/`args`/`env` fields underneath). If your tool of choice isn't listed here but supports MCP over stdio, the config above should work unchanged.

## Tools

| Tool | What it does |
|------|--------------|
| `create_draft` | Save a new draft post (`{ channel: "x", text }`). |
| `list_drafts` | List drafts, optionally filtered by status. |
| `get_draft` | Fetch a single draft by id. |
| `update_draft` | Edit a draft's text. Resets an approved or rejected draft back to `draft` so it can be re-approved. |
| `approve_draft` | Mark a draft approved. Required before publishing (unless approvals are disabled). |
| `reject_draft` | Mark a draft rejected. Also the way to manually reconcile a draft stuck in `publishing` after a crashed/interrupted publish attempt. |
| `publish_draft` | Publish an approved draft to X via `POST /2/tweets`. Returns the live URL. If the request fails ambiguously (e.g. a timeout), the draft is left in `publishing` rather than auto-retried, to avoid a duplicate paid post (see below). |
| `get_x_account` | Check connection status and show the connected `@handle`. |

Typical agent flow: `create_draft` → show the user the draft → user says "approve" → `approve_draft` → `publish_draft`.

## If a publish attempt fails ambiguously

`publish_draft` marks a draft `publishing` before calling the X API, and only clears that if the API gives a
definitive answer (a real HTTP response, or a clear "not authenticated" error). If the request instead fails
in a way that could mean X received it anyway (a timeout or network drop), the draft is deliberately left in
`publishing` and **not** auto-reverted, so an agent can't retry and risk a second, real, paid post. In that
case: check your X account for the post yourself, then call `reject_draft` (if it didn't go out) or
`update_draft` (to edit and reset it to `draft`) to reconcile the local record.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `X_CLIENT_ID` | *(none)* | Required. X OAuth 2.0 Client ID. |
| `X_CLIENT_SECRET` | *(none)* | Set if your X app is a confidential client. |
| `X_REDIRECT_URI` | `http://127.0.0.1:8879/callback` | Must match the callback registered in the X developer portal. |
| `MAKERS_PAGE_CONFIG_DIR` | `~/.config/makers-page-mcp` | Where credentials are stored. |
| `MAKERS_PAGE_DATA_DIR` | `~/.local/share/makers-page-mcp` | Where drafts are stored. |
| `MAKERS_PAGE_REQUIRE_APPROVAL` | `true` | Set to `false` to let agents publish drafts without a separate approval step. |
| `MAKERS_PAGE_MAX_POST_LENGTH` | `280` | Max characters per post (X's weighted count: URLs count as 23, emoji count once); raise this if you're on X Premium. |

## Roadmap

v1 ships with **X only**, on purpose: get the approval-gated publish loop right for one channel before adding more surface area for something that costs real money per post.

- **Text-only posts to X** (no media, threads, or polls): done.
- **More channels**: LinkedIn, Reddit, Threads, Bluesky, and others from the [makers.page](https://makers.page) roadmap, adapting the same draft into channel-native tone and length per platform.
- **Local-only, always**: drafts and credentials stay on your machine, whichever channels land.

Have a channel you want prioritized? [Open an issue](https://github.com/alexcloudstar/makers.page-mcp/issues).

## Development

```bash
bun test        # run the unit test suite
bun run typecheck
```

## FAQ

<details>
<summary><strong>Does this post automatically, without me seeing it first?</strong></summary>
<br>

No, not by default. Every draft starts in `draft` status, and `publish_draft` refuses to run unless the draft has gone through `approve_draft` first. You can disable that gate with `MAKERS_PAGE_REQUIRE_APPROVAL=false` if you fully trust the flow, but it's opt-in.

</details>

<details>
<summary><strong>Is this a hosted service? Where does my data go?</strong></summary>
<br>

It's a local process. Drafts are stored as files under `MAKERS_PAGE_DATA_DIR` (default `~/.local/share/makers-page-mcp`), and your X OAuth tokens live under `MAKERS_PAGE_CONFIG_DIR` (default `~/.config/makers-page-mcp/credentials.json`, `0600` permissions). Nothing goes through a third-party server; the server talks directly to `api.x.com`.

</details>

<details>
<summary><strong>Why does creating a post cost money?</strong></summary>
<br>

That's an X API pricing decision, not this project's. As of 2026 there's no free write tier for X's API; see [Cost per post](#cost-per-post) above for current rates. The approval gate exists specifically so an agent can't accidentally run up a bill.

</details>

<details>
<summary><strong>What happens if publishing fails partway through?</strong></summary>
<br>

See [If a publish attempt fails ambiguously](#if-a-publish-attempt-fails-ambiguously). Short version: definitive failures revert the draft automatically; anything ambiguous (timeouts, dropped connections) is left in `publishing` for you to check and reconcile manually, so you never get a silent double-post.

</details>

<details>
<summary><strong>Does this work with agents other than Cursor?</strong></summary>
<br>

Yes. It's a plain `stdio` MCP server with no client-specific extensions, so it works anywhere MCP is supported: Claude Desktop/Code, OpenAI Codex, Gemini CLI, GitHub Copilot, Windsurf, Cline, Zed, JetBrains AI Assistant, and more. See [Works with any MCP client](#works-with-any-mcp-client).

</details>

<details>
<summary><strong>Can I self-host or fork this instead of using the npm package?</strong></summary>
<br>

Yes, it's MIT-licensed. See [Option B: from source](#2-install) to build it yourself, and [CONTRIBUTING.md](CONTRIBUTING.md) if you want to send changes back upstream.

</details>

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and PR guidelines.

## Security

Found a vulnerability? Please don't open a public issue: see [SECURITY.md](SECURITY.md) for how to report it privately.

## License

[MIT](LICENSE). See the [changelog](CHANGELOG.md) for release notes.

---

<p align="center">
  Built by <a href="https://github.com/alexcloudstar">@alexcloudstar</a> for <a href="https://makers.page">makers.page</a>, Marketing Assistant for indie startups.
</p>
