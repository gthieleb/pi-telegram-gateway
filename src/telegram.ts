// src/telegram.ts
import { splitMessage } from "./chunk.js";

export interface TgUser { id: number; is_bot: boolean; username?: string }
export interface TgMessage {
  message_id: number;
  date: number;
  from?: TgUser;
  chat: { id: number; type: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number; mime_type?: string };
  reply_to_message?: { message_id: number; from?: TgUser };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: CallbackQuery;
}
export interface CallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgMe { id: number; username: string }

export class BotApiError extends Error {
  constructor(
    public readonly description: string,
    public readonly code: number,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram API: ${description} (${code})`);
  }
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async call<T = unknown>(method: string, body?: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {};
      try {
        payload = await res.json();
      } catch {
        /* non-json */
      }
      if (payload.ok) return payload.result as T;
      const retryAfter = payload.parameters?.retry_after;
      if (res.status === 429 && retryAfter !== undefined && attempt < 3) {
        await this.sleep((retryAfter + 1) * 1000);
        continue;
      }
      throw new BotApiError(payload.description ?? `HTTP ${res.status}`, res.status, retryAfter);
    }
  }

  async getMe(): Promise<TgMe> {
    return this.call<TgMe>("getMe");
  }

  async getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    const updates = await this.call<TgUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
    return updates ?? [];
  }

  async sendMessage(
    chatId: number,
    threadId: number | undefined,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: object,
  ): Promise<void> {
    const parts = splitMessage(text);
    for (const [i, part] of parts.entries()) {
      const body: Record<string, unknown> = { chat_id: chatId, text: part };
      if (threadId !== undefined) body.message_thread_id = threadId;
      if (replyToMessageId !== undefined && i === 0) {
        body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
      }
      if (replyMarkup && i === 0) body.reply_markup = replyMarkup; // keyboard on first chunk only
      await this.call("sendMessage", body);
    }
  }

  async sendChatAction(chatId: number, threadId?: number): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
    if (threadId !== undefined) body.message_thread_id = threadId;
    try {
      await this.call("sendChatAction", body);
    } catch {
      /* typing is best-effort */
    }
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    try {
      await this.call("answerCallbackQuery", body);
    } catch {
      /* best effort — expired callbacks */
    }
  }

  /** Download a file (voice note etc.) by file_id to a local path. */
  async downloadFile(fileId: string, destPath: string): Promise<string | null> {
    try {
      const info = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
      if (!info?.file_path) return null;
      const res = await this.fetchFn(`${this.baseUrl}/file/bot${this.token}/${info.file_path}`);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import("node:fs");
      writeFileSync(destPath, buf);
      return destPath;
    } catch {
      return null;
    }
  }

  /** Send a voice note (OGG/Opus). */
  async sendVoice(chatId: number, threadId: number | undefined, filePath: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(filePath);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (threadId !== undefined) form.append("message_thread_id", String(threadId));
    form.append("voice", new Blob([new Uint8Array(buf)], { type: "audio/ogg" }), "reply.ogg");
    const res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/sendVoice`, { method: "POST", body: form });
    if (!res.ok) {
      let desc = "";
      try { desc = (await res.json() as { description?: string }).description ?? ""; } catch { /* */ }
      throw new BotApiError(desc || `sendVoice HTTP ${res.status}`, res.status);
    }
  }
}