// src/voice.ts
export interface VoiceCommand {
  cmd: "play" | "pause" | "resume" | "stop" | "volume" | "status";
  args?: string;
  url?: string;
}
export interface VoiceEvent {
  event: string;
  [k: string]: unknown;
}

const VOICE_RE = /^!(play|pause|resume|stop|volume|vstatus)(?:\s+([\s\S]+))?$/i;

export function isVoiceCommand(text: string): VoiceCommand | null {
  const m = VOICE_RE.exec(text.trim());
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const cmd = (raw === "vstatus" ? "status" : raw) as VoiceCommand["cmd"];
  const args = (m[2] ?? "").trim();
  return cmd === "play" ? { cmd, url: args, args } : { cmd, args };
}

export function voiceIpcMessage(msg: Record<string, unknown>): string {
  return JSON.stringify(msg) + "\n";
}

export function parseVoiceEvent(line: string): VoiceEvent | null {
  try {
    return JSON.parse(line) as VoiceEvent;
  } catch {
    return null;
  }
}