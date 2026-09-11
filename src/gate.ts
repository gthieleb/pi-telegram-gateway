// src/gate.ts
import type { GatewayConfig } from "./config.js";

export interface GateMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; username?: string };
  chat: { id: number; type: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number };
  reply_to_message?: { from?: { id: number; is_bot?: boolean } };
}

const GROUP_TYPES = new Set(["group", "supergroup"]);

/** User-allowlist check only (voice messages have no text/mention). */
export function isAllowedSender(m: GateMessage, cfg: GatewayConfig): boolean {
  return Boolean(m.from && !m.from.is_bot && cfg.allowedUsers.includes(m.from.id));
}

export function shouldDispatch(m: GateMessage, cfg: GatewayConfig, botUsername: string): boolean {
  if (!m.from || m.from.is_bot) return false;
  if (!cfg.allowedUsers.includes(m.from.id)) return false;
  const text = (m.text ?? m.caption ?? "").trim();
  if (!text) return false;
  if (!cfg.requireMention) return true;
  if (!GROUP_TYPES.has(m.chat.type)) return true; // DMs never need mention
  if (m.reply_to_message?.from?.is_bot) return true;
  return mentionsBot(text, botUsername);
}

export function mentionsBot(text: string, botUsername: string): boolean {
  return new RegExp(`@${botUsername}(?![\\w])`, "i").test(text);
}

export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z\d_]+)(?:@[A-Za-z\d_]+)?\s*([\s\S]*)$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: m[2].trim() } : null;
}