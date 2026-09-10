// src/replay.ts
import { readFileSync } from "node:fs";

interface ReplayMessage {
  role: string;
  text: string;
}

type ContentLike = string | { type: string; text?: string }[] | undefined;

function textOf(content: ContentLike): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** Parse a pi session transcript into user/assistant turns (no tool noise). */
export function readSessionMessages(file: string): { role: string; text: string }[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const msgs: { role: string; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: ContentLike } };
      if (e.type !== "message" || !e.message) continue;
      const role = e.message.role ?? "";
      if (role !== "user" && role !== "assistant") continue;
      const text = textOf(e.message.content).trim();
      if (text) msgs.push({ role, text });
    } catch {
      /* skip malformed lines */
    }
  }
  return msgs;
}

/** Render history with role prefixes; optional tail limit with omission note. */
export function renderSessionHistory(msgs: { role: string; text: string }[], limit?: number): string {
  const render = (m: { role: string; text: string }) => (m.role === "user" ? `**You:** ${m.text}` : `**Pi:** ${m.text}`);
  let slice = msgs;
  let prefix = "";
  if (limit !== undefined && msgs.length > limit) {
    slice = msgs.slice(-limit);
    prefix = `… (${msgs.length - limit} ältere Nachrichten ausgelassen)\n\n`;
  }
  return prefix + slice.map(render).join("\n\n");
}