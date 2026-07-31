# Security Policy

makers-page-mcp stores OAuth credentials for your X account locally and uses them to post on your behalf. If you find a security issue, please report it privately so it can be fixed before it's public.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/alexcloudstar/makers.page-mcp/security/advisories/new) for this repository. If that's unavailable, reach out to [@alexcloudstar](https://github.com/alexcloudstar) directly and ask for a secure channel to share the details.

Include as much of this as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The affected version/commit
- Any suggested fix, if you have one

You should get an initial response within 5 business days. This is a small, spare-time-maintained project, so please be patient — but every report will get a reply.

## Supported versions

This project is pre-1.0. Only the latest published version on `main` / npm receives security fixes. There's no backport policy yet.

## Scope

In scope:

- The MCP server itself (`src/`): OAuth 2.0 (PKCE) flow, credential storage, X API client, draft storage, and the MCP tools it exposes.
- Anything that could leak an X access/refresh token, let an unapproved draft get published, or let a draft be published twice from a single `publish_draft` call.

Out of scope:

- Vulnerabilities in the X API itself, or in `@modelcontextprotocol/sdk`, `zod`, Bun, or Node.js — report those upstream.
- Issues that require an attacker to already have local filesystem or shell access to the machine running the server (credentials are stored in a config file with `0600` permissions on disk; protecting that machine is your responsibility).

## Design notes for reviewers

A few things worth knowing if you're auditing this project:

- Credentials (`~/.config/makers-page-mcp/credentials.json` by default) are written with `0600` permissions and never logged.
- The server only ever talks to `api.x.com` and `x.com` (for the OAuth authorize step); there's no telemetry and no third-party network calls.
- Draft IDs are validated as well-formed UUIDs before being used in any filesystem path, to prevent path traversal.
- Publishing is designed to fail closed: on an ambiguous error (e.g. a network timeout while creating a post), the draft is left in a `publishing` state rather than being retried automatically, specifically to avoid a duplicate, real, paid post to X. See the README's "If a publish attempt fails ambiguously" section for the full reasoning.
