# pi-telegram-gateway — Design Spec

**Date:** 2026-09-10 · **Status:** approved · **Author:** Gunnar Thielebein (with pi)

## Problem

`pi-telegram-mux` binds each pi session 1:1 to a single forum topic
(`coordinator.ts`: `routes.get(message_thread_id) ?? return`). Messages in any
other topic, group, or chat are silently dropped. There is no gateway-style
plugin for pi that answers messages from **all** topics in **all** groups where
the bot is a member — the behavior Hermes-style agents have.

Goal: a pi extension that acts as a **Telegram gateway**: one bot, every group
topic it can see, per-peer embedded pi sessions, replies in the origin topic.

## Prior art

| Project | Lesson taken |
|---|---|
| `pi-telegram-mux` (hkfires) | Leader election + lockfile, config layout, topic routing pitfalls |
| `@amanm/disk-agent` | Embedded `createAgentSession` pattern, shared `~/.pi/agent` auth, per-peer transcripts |
| `NousResearch/hermes-agent` | Gateway architecture: `SessionSource = (chat_id, thread_id)`, per-source session lanes, observe/mention gating |

## Architecture

```
@PiLemmaBot (Bot API getUpdates — exactly one poller, file-lock leader)
     │ updates from every chat the bot is member/admin of
     ▼
Router  key = (chat_id, thread_id | null)
     │  lazy per-peer lane
     ▼
embedded createAgentSession()          ← pi SDK
  · agentDir = getAgentDir() (~/.pi/agent)  — auth.json, skills, models SHARED
  · transcripts → ~/.pi/agent/gateway/sessions/   (own dir, not the TUI list)
  · model = pi default (kimi-for-coding/kimi-k2.6 via shared settings)
     │
     ▼
sendMessage(chat_id, message_thread_id) — answer lands in the origin topic
```

Design decision (user-confirmed): **free response** in groups the bot is
member/admin of — no per-topic binding table. Gating is user-allowlist based.

## Components (v1)

### 1. Poller (`src/poller.ts`)
- Bot API `getUpdates` long-polling loop (timeout ~25s), offset-managed.
- Single-poller guarantee: lockfile `~/.pi/agent/pi-telegram-gateway/runtime/leader.json`
  (`{pid, capability, epoch, createdAt}`); PID-liveness check on claim
  (mirrors mux mutex PID-reuse fix, v1.3.0); stale locks are reclaimed.
- 429 handling: respect `retry_after` on the shared bot; back off globally.
- 409 conflict detection → status line `tg-gw: conflict` (another poller on
  same token, e.g. mux not yet stopped).

### 2. Router (`src/router.ts`)
- Lane key: `(chat_id, thread_id)`; `thread_id = message_thread_id` when set
  (forum topics / DM topics), else `null` (plain group / DM).
- Lanes lazily create an embedded session on first message; disposed after
  `idleTimeout` (default 30 min) to bound memory; transcript persists.
- No mention requirement by default (`requireMention: false`) — the bot reacts
  to every allowed user's message in every chat it is in.

### 3. Session lanes (`src/lane.ts`)
- `createAgentSession({ cwd, agentDir, modelRuntime, settingsManager,
  sessionManager })` with `agentDir = getAgentDir()`.
- `cwd`: configured `cwd` in config.json (default `$HOME`).
- Shared `ModelRuntime` across lanes (one instance).
- Transcripts: `SessionManager` pointed at `~/.pi/agent/gateway/sessions/`
  (own directory; user approved "same home, separate session dir if needed").
- Outbound: assistant final text → Telegram, chunked at 4096 chars. Every
  send carries `message_thread_id` of the lane. If `requireMention` is on or
  the chat is a plain group, additionally anchor with `reply_parameters` to
  the triggering message; inside forum topics the thread id alone is
  sufficient (no reply anchor, keeps the topic lane clean).
- Prompt metadata: lane prepends a short system-style prefix? — **No.** The
  origin context (chat/topic) is transport, not task content; keep prompts
  verbatim.

### 4. Gating (`src/gate.ts`)
- `allowedUsers: number[]` — only messages from these Telegram user IDs are
  dispatched (default: owner id). Everything else ignored (no replies).
- `requireMention: false` default (user request); when `true`, groups only
  dispatch on `@botname` mention or reply-to-bot.
- DMs: always allowed for `allowedUsers` (mention not required in DMs).

### 5. Commands (Telegram, v1)
- `/new` — reset current lane's session (archive + fresh).
- `/status` — lane id, model, uptime, queue depth.
- Bot `/`-menu registration optional.

### 6. Config (`src/config.ts`)
- Path: `~/.pi/agent/pi-telegram-gateway/config.json`
- Schema:

```jsonc
{
  "version": 1,
  "botToken": "…",                 // required
  "botUsername": "PiLemmaBot",     // filled at first start via getMe
  "allowedUsers": [915681932],     // Telegram user ids
  "requireMention": false,         // groups: mention needed?
  "cwd": "/home/gun",
  "idleTimeoutMinutes": 30,
  "maxLanes": 8                    // LRU cap; overflow → polite busy reply
}
```
- Validation errors → clear TUI status line, no crash loop.

### 7. Status bar (pi TUI)
- `tg-gw: ready` / `connected (leader)` / `follower (leader pid …)` /
  `conflict (409)` / `429 · Ns` / `error: …` — same UX vocabulary as the mux.

## Extension loading & lifecycle
- Ships as a pi package: `pi install npm:pi-telegram-gateway` (or
  `git:github.com/gthieleb/pi-telegram-gateway`).
- Extension activates in **any** pi session that loads it; leader election
  decides who polls. Follower pi sessions stay silent (no IPC fan-out in v1).
- The extension does **not** touch the host TUI session's prompt queue — the
  host is only the process carrier.

## Error handling
- Poll errors: exponential backoff, re-claim leadership before resuming.
- `send` failures: retry ×2 with 2s jitter, then surface in status line; lane
  transcript keeps the assistant reply even if delivery failed (logged).
- Session crash inside a lane: lane is disposed, next message re-creates it;
  error notice (once per lane) to the origin topic.
- Never write the bot token to logs or status output.

## Testing
- Unit: lane keying, lockfile claim/reclaim (incl. PID reuse), gate matrix,
  config validation, message chunking.
- Integration (opt-in via env `GW_LIVE=1` with test bot): poll → lane → reply
  roundtrip against a real bot in a throwaway group.
- Framework: `vitest` (mirrors mux repo tooling).

## Switchover plan (this host)
1. Build + `pi install` the package; write config with the existing
   `@PiLemmaBot` token (copied from mux config).
2. Remove `pi-telegram-mux` from `~/.pi/agent/settings.json` packages.
3. Restart pi → mux poller dies with the old session → gateway claims token.
4. Verify: message from a second topic reaches a fresh lane; answer lands in
   that topic.
5. Document the swap in `pi-agent-setup` repo (README table + note).
   ⚠️ After step 3 the mux topic 1655 channel is gone by design.

## Additions (2026-09-10, user-approved): Voice Chat (v2)

**Ziel:** Voice-Chat-Steuerung (wie `~/projects/pilemma-voicebot/`) — aber
**nativ über denselben Bot** (`@PiLemmaBot`), kein zweiter Bot-Account.

Grundlage: der Dual-Stack aus dem Voicebot-Concept ist mit Bot-Accounts
bewiesen: Bot-API `getUpdates` für Commands + MTProto (Pyrogram,
`no_updates=True`) + PyTgCalls/ntgcalls für `phone.JoinGroupCall`. MTProto
liefert bei Bot-Accounts keine Message-Updates — der Gateway bleibt also der
*einzige* Bot-API-Poller (kein 409-Conflict), der Voice-Worker bekommt
*keine* Updates selbst.

```
gateway (Node, pi extension) ── Bot API getUpdates (exklusiv)
        │ !play / !pause / !resume / !stop / !volume / !vstatus
        │ (+ /voice Inline-Menü)
        ▼  JSON-Lines IPC (stdin/stdout)
voice sidecar (Python, lazy spawned)
  · Pyrogram bot-token login (API_ID/API_HASH), no_updates=True
  · PyTgCalls: join / play / pause / resume / leave / volume
  · Events → Gateway → sendMessage in das Ursprungs-Topic
```

| Punkt | Entscheidung |
|---|---|
| Polling | Gateway exklusiv; Sidecar hat `no_updates=True` und ruft **nie** `getUpdates` auf |
| Sidecar | Thin Python-Worker (Wiederverwendung der pilemma-voicebot-Voice-Core-Logik), Spawn on first voice command, Idle-Exit nach 10 min, Kill bei `session_shutdown` |
| IPC | JSON-Lines auf stdin/stdout: `{"cmd":"play","chat":-100,"url":…}` / `{"event":"state","playing":true,"position":12}` |
| Secrets | `voice.env` in `~/.pi/agent/pi-telegram-gateway/` (API_ID, API_HASH, BOT_TOKEN) — gitignored, nur `.example` committed |
| Config | `voice: { enabled, idleExitMinutes }` + Pfad zum Python-Worker |
| Bestehender Voicebot | Während v2-Entwicklung unverändert aktiv (`pilemma-voicebot.service`, @PiLemmaVoiceBot). **Cleanup nach erfolgreicher Verifikation** (Task 10.5): Service stoppen/deaktivieren, Unit-Datei entfernen, Doku in pi-agent-setup anpassen — siehe Switchover |

## Additions (2026-09-10, user-approved): Telegram Keyboard & Menus (v2)

Übernommen aus `pi-telegram-plus` (angepasst an Gateway-Architektur):

| Feature | Umsetzung |
|---|---|
| **Bot-Menü-Sync** | `setMyCommands` beim Leader-Start: `/new`, `/status`, `/model`, `/voice`, `/help` (unter_score-Regeln der Bot-API beachtet) |
| **Inline `/model`** | Model-Picker aus `ModelRuntime`-Registry (Default zuerst, Pagination); `callback_query` → `answerCallbackQuery` → `session.setModel()` der Lane + Feedback-Message |
| **Inline `/new`-Confirm** | ✅ Reset / ❌ Abbrechen Buttons, `callback_data: gw:confirm:new:<key>` — verhindert versehentliches Zurücksetzen |
| **Callback-Routing** | `allowed_updates: ["message", "callback_query"]`; Callback-Keys laufen über `message.message_thread_id` in die Lane |
| **Typing-Pulse** | `sendChatAction` alle 4 s während die Lane streamt (statt einmalig) |
| **Quoted-Message-Kontext** | Reply auf eine Nachricht → Zitat-Text/Caption (gekürzt auf ~500 Zeichen) als `> Zitat: …`-Prefix in den Prompt |

## Non-goals (v1)
- Multi-bot profiles, followers-IPC fan-out, TTS/STT, memory, albums,
  channel posts, `direct_messages_topic_id` handling. (Voice chat +
  keyboards/menus sind als **v2-Phasen** in denselben Plan aufgenommen —
  siehe Additions; sie kommen nach dem funktionierenden v1-Kern.)

## Future
- Voice notes (Whisper STT), image input (mux v1.3-style paths), steering of
  running lanes (`streamingBehavior: steer`), per-topic model override,
  daemon mode via `pi --mode rpc` under systemd.