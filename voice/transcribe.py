#!/usr/bin/env python3
"""STT bridge: transcribe an audio file via faster-whisper.
Usage: python transcribe.py <audio-file> [language]
stdout: JSON {"text": "..."}  (or {"error": "..."} on failure)
"""
import json
import sys

def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe.py <file>"}), flush=True)
        sys.exit(2)
    path = sys.argv[1]
    try:
        from faster_whisper import WhisperModel
        model_size = os.environ.get("WHISPER_MODEL", "base")
        model = WhisperModel(model_size, device="auto", compute_type="auto")
        segments, info = model.transcribe(path, language=os.environ.get("WHISPER_LANG") or None)
        text = " ".join(seg.text.strip() for seg in segments).strip()
        print(json.dumps({"text": text}, ensure_ascii=False), flush=True)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}, ensure_ascii=False), flush=True)
        sys.exit(1)

import os

if __name__ == "__main__":
    main()