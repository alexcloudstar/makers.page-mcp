# Makers Page MCP

**The indie stack [Model Context Protocol](https://modelcontextprotocol.io) server — one connection for your founder tools, instead of wiring a hundred separate ones.**

Indie founders already juggle socials, Stripe, analytics, GitHub, and a database. Each usually means another MCP, another config block, another context the agent doesn't share. Makers Page MCP aggregates those surfaces into one local server your coding agent already understands, so it can draft a launch post with revenue context, check a deploy, or pull product metrics without hopping tools.

`makers-page-mcp` runs locally next to Cursor, Claude Code, Codex, or any other MCP client. **v1 ships X first**: your agent drafts a channel-native post about what you just built, you approve it, and it goes out through the real X API v2. Nothing publishes without a human in the loop. More connectors (payments, analytics, GitHub, DBs, and more) are on the [roadmap](#roadmap).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/makers-page-mcp.svg)](https://www.npmjs.com/package/makers-page-mcp)
[![npm downloads](https://img.shields.io/npm/dm/makers-page-mcp.svg)](https://www.npmjs.com/package/makers-page-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.alexcloudstar%2Fmakers--page--mcp-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.alexcloudstar/makers-page-mcp)
[![makers.page-mcp MCP server](https://glama.ai/mcp/servers/alexcloudstar/makers.page-mcp/badges/score.svg)](https://glama.ai/mcp/servers/alexcloudstar/makers.page-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1-fbf0df?logo=bun&logoColor=black)](package.json)

[makers.page](https://makers.page) — the indie stack MCP that already knows your tools.

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

Most agents end up with a pile of MCP servers — one for GitHub, one for Stripe, one for analytics, one for socials — each with its own auth and none sharing context. Makers Page MCP is the opposite bet: **one indie stack connection that already knows the tools founders actually use**, so the agent can act across the stack instead of juggling integrations.

Today that means approval-gated publishing to X. Next: the rest of the stack (see [Roadmap](#roadmap)).

- **One MCP, not a hundred.** Aggregate the indie stack (socials, payments, analytics, GitHub, DBs) behind a single local server instead of a config file full of one-off connectors.
- **Shared context by design.** The agent shouldn't re-learn who you are and what you shipped every time it switches tools.
- **Agent-native, not another dashboard.** Same protocol, same config file as your other MCP servers. No new app to log into.
- **Approval-gated by default.** Every post is a `draft` until you explicitly call `approve_draft`. `publish_draft` refuses to post anything that hasn't been approved, unless you turn that off yourself. The same pattern will apply to anything that spends money or posts publicly.
- **Built for real, paid API calls.** X's write API costs money per post (see below). The draft/approve/publish split exists so an agent can never spam your account or your wallet.
- **Crash-safe by design.** Publishing uses atomic file writes, keyed locks around concurrent operations on the same draft, and a three-way error split (definitive failure, ambiguous network failure, unexpected error) so a dropped connection can never turn into a silent duplicate post.
- **Local-first.** Drafts and credentials live on your machine (`~/.local/share/makers-page-mcp`, `~/.config/makers-page-mcp`), written with `0600` permissions, not in someone else's cloud.
- **Zero lock-in.** It's a stdio MCP server distributed on npm under the MIT license. Read the source, fork it, self-host it.

## How it compares

| | Manual / browser hopping | Separate MCP per tool | Zapier / Make | **Makers Page MCP** |
|---|---|---|---|---|
| Lives inside your coding agent | No | Yes | No | **Yes** |
| One connection for the indie stack | No | No (N configs) | Partial (N apps) | **Yes (aggregates)** |
| Shared context across socials, money, code, data | No | No | Only with glue | **Yes (destination)** |
| Human approval before anything ships or spends | Depends on you | Depends on each server | No (auto-triggered) | **Yes, by default** |
| Open source / self-hostable | *(n/a)* | Varies | No | **Yes (MIT)** |
| Where data lives | You | Mixed | Their servers | **Your machine** |

v1 covers X posting today; the aggregator columns describe where this indie stack MCP is headed.

## Cost per post

As of 2026, X's API is pay-per-use for self-serve developer accounts: creating a post costs **$0.015** (plain text) or **$0.20** (if the post contains a URL), charged against credits you prepay in the [X developer console](https://developer.x.com). There's no free write tier anymore. Every `publish_draft` call is a real charge: treat it accordingly (approve deliberately, don't script bulk test-publishing).

## Quick start

### 1. Create an X developer app

1. Go to the [X developer portal](https://developer.x.com) and create (or open) a project + app.
2. Under **User authentication settings**, enable **OAuth 2.0**.
3. Set **App permissions** to **Read and write**.
4. Set the **Type of App** to **Web App, Automated App or Bot** (this gives you a Client ID, and a Client Secret if confidential).
5. Add an exact-match **Callback URI / Redirect URL**: `http://127.0.0.1:8879/callback`
   (must be a **loopback** host: `127.0.0.1`, `localhost`, or `::1` — non-loopback URIs are rejected at auth time).
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
export TWITTER_CLIENT_ID=your-client-id
export TWITTER_CLIENT_SECRET=your-client-secret   # omit if your app is a public client
export TWITTER_REDIRECT_URI=http://127.0.0.1:8879/callback  # must match the portal exactly
```

If you're building from source, you can instead copy `.env.example` to `.env` and fill in the same values. Bun loads `.env` automatically for anything run with `bun` (`bun run auth`, `bun run dev`, `bun dist/index.js`). `.env` is gitignored, so your keys never get committed.

Run the one-time authorization flow:

```bash
npx -y makers-page-mcp-auth   # npm install
bun run auth                  # from source
```

This prints an authorize URL: open it, log in as the X account you want to post from, and approve. The server captures the redirect locally and stores an access + refresh token at `~/.config/makers-page-mcp/credentials.json`. Tokens auto-refresh on future use; re-run auth if you revoke access, or after upgrading to a version that adds scopes (e.g. `media.write` for image/GIF/video uploads).

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
        "TWITTER_CLIENT_ID": "your-client-id",
        "TWITTER_CLIENT_SECRET": "your-client-secret",
        "TWITTER_REDIRECT_URI": "http://127.0.0.1:8879/callback"
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
| `create_draft` | Save a new draft post for X. Required: `{ channel: "x", text }`. Optional: `parts` (thread), `poll`, `mediaPaths` (absolute local paths, max 4), `quoteTweetId`, `communityId`, `shareWithFollowers`, `paidPartnership`, `allowLinksInMainPost`. **No http(s) links in the main post** — put URLs in `parts[1+]` unless the user explicitly forces `allowLinksInMainPost`. |
| `list_drafts` | List drafts, optionally filtered by status (`draft`, `approved`, `rejected`, `publishing`, `published`, `deleted`). |
| `get_draft` | Fetch a single draft by id. |
| `update_draft` | Edit draft content (same fields as create; pass `null` to clear an optional field). Resets an approved or rejected draft back to `draft` so it can be re-approved. |
| `approve_draft` | Mark a draft approved. Required before publishing (unless approvals are disabled). |
| `reject_draft` | Mark a draft rejected. Also reconciles a draft stuck in `publishing` when nothing was posted (no recorded live ids). If live ids were recorded, use `delete_published_draft` instead. |
| `publish_draft` | Publish an approved draft to X via `POST /2/tweets` (uploads media first when needed; threads reply to the previous part). Returns the live URL(s). If the request fails ambiguously (e.g. a timeout), or a thread fails mid-way, the draft is left in `publishing` rather than auto-retried. |
| `edit_published_draft` | Edit the **root** post of a published draft (`edit_options.previous_post_id`). Re-attaches media/quote when present. Each edit creates a new post id, which is stored locally. Rejects polls and community posts. |
| `delete_published_draft` | Delete every stored post id on X whenever live ids are recorded (published, partial `publishing`, or legacy/corrupt records), then mark the local draft `deleted`. |
| `get_x_account` | Check connection status and show the connected `@handle`. |
| `lookup_x_user` | Resolve an `@handle` to a user id (and DM eligibility). |
| `get_dm_rate_limit` | Show local DM send limits and current usage. |
| `create_dm_draft` | Save a draft DM. Required: `text` plus a target — `recipientId`/`recipientUsername` (1:1), `participantIds`/`participantUsernames` with `conversationType: "group"` (new group), or `conversationId` (reply). Optional: one `mediaPaths` entry. |
| `list_dm_drafts` | List DM drafts, optionally filtered by status (`draft`, `approved`, `rejected`, `sending`, `sent`, `deleted`). |
| `get_dm_draft` | Fetch a single DM draft by id. |
| `update_dm_draft` | Edit a DM draft (pass `null` to clear optional fields). Resets approved drafts to `draft`. |
| `approve_dm_draft` | Mark a DM draft approved. Required before sending (unless approvals are disabled). |
| `reject_dm_draft` | Mark a DM draft rejected, or reconcile one stuck in `sending`. |
| `send_dm_draft` | Send an approved DM via the X API. Enforces local rate limits. |
| `list_dm_events` | Read recent events in a 1:1 DM thread (`participantId` or `username`). |
| `list_dm_inbox` | Read recent DM events across all conversations (inbox view for agent context). |
| `list_dm_conversation_events` | Read recent events in a conversation by `conversationId` (1:1 or group thread). |
| `get_x_post_metrics` | Fetch impressions, likes, reposts, replies, quotes, and bookmarks for up to 100 post ids. |
| `get_x_account_summary` | Calendar-day impressions and engagements via `GET /2/tweets/analytics` (aligned with x.com account analytics). Period totals and top posts for the window. |
| `analyze_x_posting_times` | Hour-of-day analysis: avg impressions and engagement rate by when you posted. |
| `create_retweet_draft` | Save a draft retweet or undo-retweet for a post id. Not executed until approved. |
| `list_retweet_drafts` | List retweet/undo drafts, optionally filtered by status. |
| `get_retweet_draft` | Fetch a single retweet/undo draft by id. |
| `approve_retweet_draft` | Mark a retweet/undo draft approved (required before execution unless approvals disabled). |
| `reject_retweet_draft` | Mark a retweet/undo draft rejected; also reconcile drafts stuck in executing. |
| `retweet_post` | Retweet an approved draft immediately via `POST /2/users/:id/retweets`. |
| `undo_retweet` | Undo an approved retweet draft via `DELETE /2/users/:id/retweets/:tweet_id`. |
Typical agent flow: `create_draft` → show the user the draft → user says "approve" → `approve_draft` → `publish_draft`.

Typical retweet flow: `create_retweet_draft` → user approves → `approve_retweet_draft` → `retweet_post` (or `undo_retweet` for undo drafts).

Typical DM flow: `lookup_x_user` (optional) → `create_dm_draft` → user approves → `approve_dm_draft` → `send_dm_draft`.

To reply in context: `list_dm_inbox` or `list_dm_conversation_events` → draft with `conversationId` → approve → send.

### X create/update fields

| Field | Notes |
|------|--------|
| `text` | Main post copy. Must equal `parts[0]` when `parts` is set. On `update_draft`, if both `text` and `parts` are sent and disagree, **`text` wins** and becomes `parts[0]`. **No http(s) URLs** unless `allowLinksInMainPost` is true. |
| `parts` | Thread of 2+ posts. Each part after the first replies to the previous one (standard X thread chain). **Put every link in `parts[1+]`, never in the main post.** Polls are not allowed on threads. |
| `poll` | `{ options: string[2..4], durationMinutes: 5..10080 }`. Mutually exclusive with `mediaPaths` and `quoteTweetId`. |
| `mediaPaths` | Absolute local paths (`.jpg`/`.jpeg`/`.png`/`.webp`/`.gif`/`.mp4`), 1–4 files. Up to 4 images, or one GIF, or one video (no mixing). Symlinks are rejected; MIME/category is chosen from the **file extension** and verified with **magic-byte sniffing** before upload. Requires re-auth with `media.write` (see below). |
| `quoteTweetId` | Quote another post. **Enterprise-only** on self-serve / pay-per-use X API tiers — the tool still sends it; X may reject. |
| `communityId` / `shareWithFollowers` | Post to a Community; `shareWithFollowers` requires `communityId`. |
| `paidPartnership` | Sets `paid_partnership: true` on create (and on edit when provided). |
| `allowLinksInMainPost` | Opt out of the default ban on links in the main post. **Only when the user explicitly insists.** |

### Caveats (X product limits)

- **Links in comments, not the main post:** By default, `create_draft` / `update_draft` / `edit_published_draft` reject `http://` or `https://` URLs in `text` / `parts[0]`. Put links in follow-up thread parts (`parts[1]`, `parts[2]`, …). Override only with `allowLinksInMainPost: true` when the user forces it.
- **Re-auth for media:** OAuth scopes now include `media.write`. If you authorized before this change, run `makers-page-mcp-auth` / `bun run auth` once more.
- **Re-auth for DMs:** OAuth scopes now include `dm.read` and `dm.write`. Re-run auth after upgrading to send or read DMs.
- **Quote posts:** OpenAPI documents quote as Enterprise-only on self-serve; expect API errors on lower tiers.
- **Edit:** Requires **X Premium**, roughly a **30-minute** window and **up to 5 edits** from the original. Each edit returns a **new post id** (we update the local draft). Polls and community posts are not editable.
- **Replies:** Self-serve apps can create **self-threads** (reply to your own previous part). Replies to *other* accounts are blocked unless summoned.
- **Cashtags:** Self-serve allows **at most one cashtag** (`$TICKER`) per post.

## If a publish attempt fails ambiguously

`publish_draft` marks a draft `publishing` before calling the X API, and only clears that if the API gives a
definitive answer (a real HTTP response, or a clear "not authenticated" error). If the request instead fails
in a way that could mean X received it anyway (a timeout or network drop), the draft is deliberately left in
`publishing` and **not** auto-reverted, so an agent can't retry and risk a second, real, paid post.

Reconciliation:

- **Nothing posted** (no live ids recorded): call `reject_draft` or `update_draft` to reset.
- **Partial thread** (some ids recorded): do **not** retry `publish_draft`. Call `delete_published_draft` to remove the live posts, or finish the remainder on X manually.
- **Ambiguous single post** (may or may not have posted, no ids recorded): check X yourself; if it did not post, reset with `reject_draft` / `update_draft`; if it did, leave the draft as-is and note the URL.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TWITTER_CLIENT_ID` | *(none)* | Required. X/Twitter OAuth 2.0 Client ID. |
| `TWITTER_CLIENT_SECRET` | *(none)* | Set if your X app is a confidential client. |
| `TWITTER_REDIRECT_URI` | `http://127.0.0.1:8879/callback` | Must match the callback registered in the X developer portal **and** use a loopback host (`127.0.0.1`, `localhost`, or `::1`). |
| `MAKERS_PAGE_CONFIG_DIR` | `~/.config/makers-page-mcp` | Where credentials are stored. |
| `MAKERS_PAGE_DATA_DIR` | `~/.local/share/makers-page-mcp` | Where drafts are stored. |
| `MAKERS_PAGE_REQUIRE_APPROVAL` | `true` | Set to `false` to let agents publish drafts without a separate approval step. |
| `MAKERS_PAGE_MAX_POST_LENGTH` | `280` | Max characters per post (X's weighted count: URLs count as 23, emoji count once); raise this if you're on X Premium. |
| `MAKERS_PAGE_MAX_DM_LENGTH` | `10000` | Max characters per DM. |
| `MAKERS_PAGE_DM_MAX_PER_HOUR` | `10` | Local cap on DM sends per rolling hour (before calling X). |
| `MAKERS_PAGE_DM_MAX_PER_DAY` | `50` | Local cap on DM sends per rolling 24 hours. |
| `MAKERS_PAGE_DM_MIN_INTERVAL_MS` | `3000` | Minimum milliseconds between consecutive DM sends. |

## Roadmap

Destination: **one local indie stack MCP** that already knows the founder tools — socials, payments, analytics, GitHub, databases — so you don't maintain a hundred separate connections. v1 ships **X only**, on purpose: prove the approval-gated write loop before adding more surfaces that spend money or post publicly.

**Shipped**

- X manage-posts: text, threads, polls, media (chunked upload), quote, community + `share_with_followers`, paid partnership, edit, and delete — still behind draft → approve → publish with crash-safe / no-auto-retry semantics.
- X DMs: draft → approve → send (1:1 text, media attachment, group conversations) with local rate limits; read inbox and thread events; `@handle` lookup.
- X analytics (read-only): post metrics, account summary (today + top posts), posting-time analysis. No local DB; fetches from X API on demand.
- X retweets: draft → approve → `retweet_post` / `undo_retweet` (immediate; no scheduling).

**Next**

1. **More socials** — LinkedIn, Reddit, Threads, Bluesky; same draft adapted to channel-native tone and length.
2. **Payments & code** — Stripe (Lemon Squeezy as a secondary path), GitHub.
3. **Analytics & data** — PostHog / Plausible, Postgres via Supabase / Neon.
4. **Ops extras** — Resend, Sentry, as the core set stabilizes.
5. **Launch directories** — research launches and draft listing copy where useful; **submit only where a stable API or first-class MCP write path exists**. Today that is thin: Product Hunt community MCPs are read-only (the PH API has no create-post mutation), Hacker News write MCPs scrape browser login (no public write API), and Peerlist / BetaList / Uneed / Fazier / Microlaunch / Dev Hunt / Tiny Launch have no MCP for submissions. MCP registries (official registry, Smithery, PulseMCP, Glama, mcp.so) are for listing *this* server, not for submitting your product to launch boards.

**Always**

- Local-only drafts and credentials, whichever connectors land.
- Approval gates for anything that posts publicly or spends money.

Want a connector prioritized? [Open an issue](https://github.com/alexcloudstar/makers.page-mcp/issues).

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

It's a local process. Drafts, DM drafts, retweet drafts, and rate-limit state are stored as files under `MAKERS_PAGE_DATA_DIR` (default `~/.local/share/makers-page-mcp`); your X OAuth tokens live under `MAKERS_PAGE_CONFIG_DIR` (default `~/.config/makers-page-mcp/credentials.json`). All of these files are written with `0600` permissions. Nothing goes through a third-party server; the server talks directly to `api.x.com`.

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
  Built by <a href="https://github.com/alexcloudstar">@alexcloudstar</a> for <a href="https://makers.page">makers.page</a> — the indie stack MCP.
</p>
