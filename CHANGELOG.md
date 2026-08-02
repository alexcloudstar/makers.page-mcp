# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- X Direct Messages: draft → approve → send flow with local rate limits (`MAKERS_PAGE_DM_MAX_PER_HOUR`, `MAKERS_PAGE_DM_MAX_PER_DAY`, `MAKERS_PAGE_DM_MIN_INTERVAL_MS`).
- DM tools: `lookup_x_user`, `get_dm_rate_limit`, `create_dm_draft`, `list_dm_drafts`, `get_dm_draft`, `update_dm_draft`, `approve_dm_draft`, `reject_dm_draft`, `send_dm_draft`, `list_dm_events`.
- OAuth scopes `dm.read` and `dm.write` (re-run `makers-page-mcp-auth` after upgrading).
- Full X manage-posts surface beyond text-only: threads (`parts`), polls, media upload (`mediaPaths` + chunked `/2/media/upload`), quote tweets, community posts (`communityId` / `shareWithFollowers`), and paid partnership.
- Tools: `edit_published_draft` (root post only; persists the new post id X returns) and `delete_published_draft` (deletes all stored ids, then marks the draft `deleted`).
- OAuth scope `media.write` (re-run `makers-page-mcp-auth` after upgrading if you need media).
- Draft status `deleted`; store helpers for partial thread publish and edit id replacement.

### Changed

- `create_draft` / `update_draft` accept the extended X fields; `poll`, `mediaPaths`, and `quoteTweetId` are mutually exclusive.
- `publish_draft` uploads media, posts thread replies to the previous part, and on mid-thread failure records posted ids while leaving status `publishing` (no auto-retry).
- X media upload migrated to current v2 endpoints (simple upload for images; `/initialize` → `/append` → `/finalize` for GIF/video).
- Partial publishes with recorded live ids cannot be reset via `reject_draft` / `update_draft` (would orphan posts); use `delete_published_draft` instead (allowed whenever live ids are recorded).
- `edit_published_draft` re-uploads `mediaPaths` and re-sends `quoteTweetId` / `paidPartnership` so edits do not strip attachments or flags.
- Media validation rejects GIF/video mixes and multiple GIFs/videos; media STATUS polling waits up to 10 minutes.

### Notes / caveats

- Quote tweets are Enterprise-only on self-serve X API tiers (tool still sends `quote_tweet_id`).
- Edit requires X Premium and is limited (~30 minutes / 5 edits); each edit creates a new post id.
- Self-serve blocks replies to other accounts unless summoned; self-threads still work.
- Self-serve: max one cashtag per post.

## [0.1.2] - 2026-07-31

### Added

- `mcpName` field in `package.json` and a `server.json` manifest so the server can be published to the [official MCP Registry](https://registry.modelcontextprotocol.io).

### Fixed

- The MCP server now reports its actual `package.json` version in the `initialize` handshake instead of a hardcoded, stale version string.

## [0.1.1] - 2026-07-31

### Added

- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, and this changelog.
- Unit test suite (`bun:test`) covering draft status transitions, keyed locking, atomic writes, post-length validation, config parsing, and `publish_draft`'s error handling.

### Fixed

- Drafts stuck in `publishing` after a crashed or interrupted `publish_draft` call can now be manually reconciled via `reject_draft` or `update_draft`, instead of being stuck permanently.
- `publish_draft` no longer reverts a draft's status on every error. Only definitive failures (not authenticated, or a real HTTP response from X) revert it; ambiguous network failures (timeouts, dropped connections) leave the draft in `publishing` so it can't be retried into a duplicate, paid post.
- Post-length validation (`weightedLength`) no longer overcounts emoji or drops trailing punctuation attached to a URL, and undercounts URLs relative to X's own weighting far less than before.
- `MAKERS_PAGE_MAX_POST_LENGTH` no longer silently disables length validation when set to an invalid value; it now falls back to the default.
- `writeFileAtomic` no longer leaves orphaned temp files behind after a failed write.

## [0.1.0] - 2026-07-31

### Added

- Initial release: a local MCP server for drafting, approving, and publishing posts to X.
- Tools: `create_draft`, `list_drafts`, `get_draft`, `update_draft`, `approve_draft`, `reject_draft`, `publish_draft`, `get_x_account`.
- OAuth 2.0 (PKCE) authorization flow for connecting an X account.
- Local, file-based draft storage with an approval gate before publishing.

[Unreleased]: https://github.com/alexcloudstar/makers.page-mcp/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/alexcloudstar/makers.page-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alexcloudstar/makers.page-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexcloudstar/makers.page-mcp/releases/tag/v0.1.0
