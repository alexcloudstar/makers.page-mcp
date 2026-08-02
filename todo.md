# DM feature phases

Track implementation of X Direct Messages in makers-page-mcp.

## Phase 1 — Send-only (1:1, text)

- [x] OAuth scopes: `dm.read`, `dm.write`
- [x] Draft store under `~/.local/share/makers-page-mcp/dm-drafts/`
- [x] `create_dm_draft` → `approve_dm_draft` → `send_dm_draft`
- [x] Send to `@handle` or user id via `POST /2/dm_conversations/with/:id/messages`
- [x] Local rate limits (hourly, daily, min interval)
- [x] `lookup_x_user`, `get_dm_rate_limit`

## Phase 2 — Media DMs

- [x] Optional `mediaPaths` (one attachment) on drafts
- [x] Reuse `uploadMedia` before send
- [x] Attach via `attachments[media_ids]` in message body
- [x] Validation: max 1 media file per DM draft

## Phase 3 — Read inbox

- [x] `list_dm_inbox` — recent DMs across all conversations (`GET /2/dm_events`)
- [x] `list_dm_events` — thread with one participant (existing)
- [x] `list_dm_conversation_events` — events by `conversationId` (group + 1:1 threads)

## Phase 4 — Group DMs

- [x] `conversationType: "group"` on drafts
- [x] `participantIds` / `participantUsernames` (2+ users for new group)
- [x] `createGroupDmConversation` via `POST /2/dm_conversations`
- [x] Reply in existing group via `conversationId` + `sendDmByConversationId`

## Re-auth

After upgrading, run:

```bash
cd mcp && bun --env-file=.env run auth
```

Required scopes: `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write`, `dm.read`, `dm.write`
