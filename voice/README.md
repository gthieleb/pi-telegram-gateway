# Voice Sidecar (pi-telegram-gateway)

Python-Worker für Gruppen-Voice-Chats über **denselben Bot** (`@PiLemmaBot`) —
portiert aus `pilemma-voicebot/bot.py`, aber **ohne Bot-API-Updates**: Der
Gateway-Poller ist der einzige `getUpdates`-Client; dieser Worker läuft mit
`no_updates=True` und wird per JSON-Lines-IPC (stdin/stdout) gesteuert.

## Setup (auf dem Host)

```bash
pip install -r voice/requirements.txt       # in der venv des Daemon-Users
cp voice/voice.env.example ~/.pi/agent/pi-telegram-gateway/voice.env
$EDITOR ~/.pi/agent/pi-telegram-gateway/voice.env   # API_ID/API_HASH/BOT_TOKEN
```

`API_ID`/`API_HASH` von https://my.telegram.org (API development tools).
Der Bot muss in der Zielgruppe Admin/Member sein und ein **Gruppen-Sprachchat
muss gestartet sein**, bevor `!play` joint.

## Nutzung (aus Telegram)

In jedem Topic/Gruppe, wo der Bot Member ist (nicht DM):

```
!play <url|pfad>   # joint + streamt; ohne url = resume
!pause / !resume / !stop
!volume <0-200>
!vstatus
```

Der Gateway erkennt diese `!`-Kommandos (nur für erlaubte User) und steuert
den Worker; Antworten landen im Ursprungs-Topic.

## Lifecycle

- Lazy-Spawn beim ersten `!`-Kommando, Idle-Exit nach 10 min (`IDLE_EXIT_SECONDS`)
- Worker self-exits zusätzlich; der Gateway terminiert bei Idle ebenfalls
- `session/`-Verzeichnis neben worker.py hält die MTProto-Bot-Session

## Warum dual-stack? (siehe pilemma-voicebot/CONCEPT.md)

MTProto-Bot-Accounts liefern (empirisch, pyrofork 2.3.69) keine
Message-Updates — Bot-API-Polling bleibt zuverlässig. Die Bot-API kann aber
keine Voice-Chats joinen → MTProto zwingend für die Call-Steuerung.