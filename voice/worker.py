#!/usr/bin/env python3
"""
pi-telegram-gateway voice sidecar — JSON-lines IPC worker.

Architecture (dual-stack, ported from pilemma-voicebot/bot.py):
  - MTProto (Pyrogram, no_updates=True) + PyTgCalls → drives group voice calls.
  - NO Bot API usage at all: the gateway owns getUpdates exclusively; commands
    arrive via JSON lines on stdin, replies are forwarded as JSON events on
    stdout (the gateway sends them into the origin topic).

Protocol (stdin, one JSON object per line):
    {"cmd":"play","chat":-100...,"url":"<url|path>"}
    {"cmd":"pause"|"resume"|"stop"|"status","chat":-100...}
    {"cmd":"volume","chat":-100...,"volume":150}

Events (stdout):
    {"event":"ready","username":"PiLemmaBot"}
    {"event":"state","chat":...,"text":"▶️ Playing: …"}
    {"event":"error","message":"…"}
    {"event":"idle-exit"}
"""
import json
import os
import sys
import time
import asyncio
import threading

from dotenv import load_dotenv
from pyrogram import Client
from pytgcalls import PyTgCalls, idle
from pytgcalls.types import MediaStream

VOICE_ENV = os.environ.get("VOICE_ENV", os.path.join(os.path.dirname(__file__), "voice.env"))
load_dotenv(VOICE_ENV)

API_ID = int(os.getenv("API_ID", "0") or 0)
API_HASH = os.getenv("API_HASH", "")
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
IDLE_EXIT_SECONDS = int(os.getenv("IDLE_EXIT_SECONDS", "600"))

if not API_ID or not API_HASH or not BOT_TOKEN:
    print(json.dumps({"event": "error", "message": "missing API_ID/API_HASH/BOT_TOKEN in voice.env"}), flush=True)
    sys.exit(78)


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


app = Client(
    "pi_gw_voice",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
    workdir=os.path.join(os.path.dirname(__file__), "session"),
    no_updates=True,
)

call_py: PyTgCalls = PyTgCalls(app)
loop = asyncio.get_event_loop()
last_activity = time.time()
stopping = threading.Event()


async def handle(cmd: dict) -> None:
    kind = cmd.get("cmd", "")
    chat = int(cmd.get("chat", 0))
    try:
        if kind == "play":
            url = (cmd.get("url") or "").strip()
            if url:
                await call_py.play(chat, MediaStream(url, video_flags=MediaStream.Flags.IGNORE))
                emit({"event": "state", "chat": chat, "playing": True, "text": f"▶️ Playing: {url}"})
            else:
                await call_py.resume(chat)
                emit({"event": "state", "chat": chat, "playing": True, "text": "▶️ Resumed."})
        elif kind == "pause":
            await call_py.pause(chat)
            emit({"event": "state", "chat": chat, "playing": False, "text": "⏸️ Paused."})
        elif kind == "resume":
            await call_py.resume(chat)
            emit({"event": "state", "chat": chat, "playing": True, "text": "▶️ Resumed."})
        elif kind == "stop":
            await call_py.leave_call(chat)
            emit({"event": "state", "chat": chat, "playing": False, "text": "⏹️ Left the voice chat."})
        elif kind == "volume":
            vol = int(cmd.get("volume", 100))
            await call_py.change_volume_call(chat, vol)
            emit({"event": "state", "chat": chat, "text": f"🔊 Volume set to {vol}"})
        elif kind == "play_file":
            # TTS output (local wav/ogg) — spoken into the active voice chat.
            # Success is silent (no text forwarded); failures only when not quiet.
            path = cmd.get("path", "")
            quiet = bool(cmd.get("quiet", False))
            try:
                await call_py.play(chat, MediaStream(path, video_flags=MediaStream.Flags.IGNORE))
                emit({"event": "speaking", "chat": chat})
            except Exception as e:
                if not quiet:
                    emit({"event": "error", "chat": chat, "text": f"❌ {type(e).__name__}: {e}"})
                else:
                    emit({"event": "error", "quiet": True, "text": str(e)})
        elif kind == "status":
            try:
                seconds = await call_py.time(chat)
                emit({"event": "state", "chat": chat, "text": f"⏱️ Position: {seconds:.1f}s"})
            except Exception as e:
                emit({"event": "state", "chat": chat, "text": f"Not in a voice chat ({e})"})
        else:
            emit({"event": "error", "message": f"unknown cmd: {kind}"})
    except Exception as e:  # noqa: BLE001 — surface any pytg error to the gateway
        emit({"event": "error", "chat": chat, "text": f"❌ {type(e).__name__}: {e}"})


def stdin_loop() -> None:
    global last_activity
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        last_activity = time.time()
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            emit({"event": "error", "text": "bad json"})
            continue
        if not isinstance(cmd, dict) or not cmd.get("cmd"):
            emit({"event": "error", "text": "missing cmd"})
            continue
        try:
            fut = asyncio.run_coroutine_threadsafe(handle(cmd), loop)
            fut.result(timeout=180)
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "text": f"❌ {type(e).__name__}: {e}"})
    stopping.set()


def idle_watch() -> None:
    while not stopping.is_set():
        if time.time() - last_activity > IDLE_EXIT_SECONDS:
            emit({"event": "idle-exit"})
            os._exit(0)
        time.sleep(10)


async def main() -> None:
    global last_activity
    await call_py.start()
    me = await app.get_me()
    emit({"event": "ready", "username": me.username})
    last_activity = time.time()
    threading.Thread(target=stdin_loop, daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    await idle()


if __name__ == "__main__":
    asyncio.run(main())