# Contributing

Thanks for considering a contribution to makers-page-mcp. This guide covers everything you need to set up the project, make a change, and get it merged.

## Setup

```bash
git clone https://github.com/alexcloudstar/makers.page-mcp.git
cd makers.page-mcp/mcp
bun install
```

You don't need a real X developer account to write or test code — only `bun run auth` and any tool that hits `api.x.com` require one. Everything else runs against local fixtures.

## Development loop

```bash
bun run build       # compile TypeScript to dist/
bun run dev          # compile in watch mode
bun run typecheck    # type-check src/ and the test suite, no emit
bun test             # run the unit test suite
```

Run `bun run typecheck` and `bun test` before opening a PR — both run in CI and a PR won't merge if either fails.

## Project layout

```
src/
  auth/       OAuth 2.0 (PKCE) flow and credential storage
  channels/x/ X API v2 client and post validation
  drafts/     Local draft storage and status transitions
  tools/      MCP tool definitions (create_draft, publish_draft, ...)
  util/       Small shared helpers (locking, atomic writes, fetch timeout)
```

Each module has a matching `*.test.ts` file next to it. Add or update tests in the same place.

## Making a change

1. **Open an issue first for anything nontrivial** — new channels, new tools, or behavior changes to publishing/approval. This project intentionally keeps a tight safety model around real, paid, irreversible posts to X, so it's worth agreeing on the approach before you write code.
2. **Keep drafts safe.** Any change touching `src/drafts/` or `src/tools/publish.ts` should preserve two guarantees: nothing publishes without going through `approve_draft` (unless approval is explicitly disabled), and a failed publish attempt never leaves the system in a state where an agent could accidentally post the same content twice. If you're not sure whether your change affects this, ask in the issue or PR.
3. **Write tests.** `bun test` uses Bun's built-in test runner (`bun:test`). Favor testing real behavior (e.g. a `DraftStore` status transition, a tool's returned result) over internals.
4. **Match the existing style.** No semicolons, `const` over `function`, early returns, descriptive names. Run `bun run typecheck` to catch obvious issues; there's no separate linter yet.
5. **Update the README** if you change a tool's behavior, add a config variable, or change the setup steps.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Use the imperative mood ("add", not "added"), and don't end the subject line with a period.

## Submitting a pull request

1. Fork the repo and create a branch off `main`.
2. Make your change, with tests, and confirm `bun run typecheck` and `bun test` both pass.
3. Open a PR against `main` describing what changed and why. Link the issue it addresses, if any.
4. Be responsive to review — this is a small project maintained in spare time, so a quick back-and-forth gets things merged faster than a large, unreviewed diff.

## Reporting bugs

Open a [GitHub issue](https://github.com/alexcloudstar/makers.page-mcp/issues) with:

- What you expected to happen, and what happened instead
- Steps to reproduce
- Your OS, Bun/Node version, and relevant config (`MAKERS_PAGE_*` env vars, redacted if needed)

If the bug is a security vulnerability, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
