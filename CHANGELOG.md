# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/alexcloudstar/makers.page-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alexcloudstar/makers.page-mcp/releases/tag/v0.1.0
