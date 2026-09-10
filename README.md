# pi-telegram-gateway

A Telegram **gateway** extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent):
one bot, **every group & topic** it is a member/admin of, per-peer embedded
pi sessions (pi SDK `createAgentSession`), replies in the origin topic.

Hermes-style gateway behavior on top of pi — successor in spirit to the
1:1-binding `pi-telegram-mux`.

```
@YourBot (getUpdates — single poller, file-lock leader election)
     │ updates from every chat the bot is member/admin of
     ▼
Router  key = (chat_id, thread_id)
     ▼
embedded createAgentSession()  — shared ~/.pi/agent home (auth, skills, models)
     ▼
sendMessage(chat_id, message_thread_id) — answer lands in the origin topic
```

> ⚠️ Work in progress — see
> [`docs/superpowers/specs/2026-09-10-pi-telegram-gateway-design.md`](docs/superpowers/specs/2026-09-10-pi-telegram-gateway-design.md)
> for the approved design. Implementation ongoing.

## Install (planned)

```bash
pi install git:github.com/gthieleb/pi-telegram-gateway
```

Config: `~/.pi/agent/pi-telegram-gateway/config.json`

```jsonc
{
  "botToken": "123:ABC",
  "allowedUsers": [123456789],
  "requireMention": false,      // false = react to every allowed user's message
  "cwd": "/home/gun",
  "idleTimeoutMinutes": 30,
  "maxLanes": 8
}
```

## Status

| Stage | State |
|---|---|
| Design spec | ✅ approved |
| Implementation | 🚧 in progress |
| Switchover from pi-telegram-mux | ⏳ pending |

## License

MIT