// src/gateway.ts
import type { GatewayConfig } from "./config.js";
import { parseCommand, shouldDispatch } from "./gate.js";
import type { Router } from "./router.js";
import type { TelegramClient, TgMessage, TgUpdate, CallbackQuery } from "./telegram.js";
import { laneKey } from "./router.js";

export interface GatewayDeps {
  config: GatewayConfig;
  client: TelegramClient;
  router: Router;
  lock: { claim: () => { leader: boolean }; release: () => void };
  pollDelayMs?: number;
  sweepIntervalMs?: number;
}

export class Gateway {
  offset = 0;
  private stopped = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private username = "";

  constructor(private deps: GatewayDeps) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  async resolveBotUsername(): Promise<string> {
    if (this.username) return this.username;
    if (this.deps.config.botUsername) {
      this.username = this.deps.config.botUsername;
      return this.username;
    }
    const me = await this.deps.client.getMe();
    this.deps.config.botUsername = me.username;
    this.username = me.username;
    return this.username;
  }

  /** One poll cycle without long-wait — used by tests and by the loop. */
  async runOnce(): Promise<void> {
    const updates = await this.deps.client.getUpdates(this.offset, 0);
    for (const u of updates) {
      this.offset = u.update_id + 1;
      if (u.message) await this.handleMessage(u.message);
      if (u.callback_query) await this.handleCallback(u.callback_query);
    }
  }

  private async handleMessage(m: TgMessage): Promise<void> {
    const botUsername = await this.resolveBotUsername();
    if (!shouldDispatch(m as never, this.deps.config, botUsername)) return;
    const threadId = m.message_thread_id;
    const text = (m.text ?? m.caption ?? "").trim();
    if (!text) return;
    const cmd = parseCommand(text);
    if (cmd?.name === "new") {
      await this.deps.router.reset(laneKey(m.chat.id, threadId));
      return;
    }
    if (cmd?.name === "status") {
      await this.deps.client.sendMessage(
        m.chat.id, threadId,
        `Gateway online · lanes: ${this.deps.router.size} · mode: ${this.deps.config.mode}`,
      );
      return;
    }
    await this.deps.client.sendChatAction(m.chat.id, threadId);
    await this.deps.router.dispatch(laneKey(m.chat.id, threadId), text);
  }

  /** Handle inline-keyboard callbacks (v2): gw:model:<provider>/<id>, gw:confirm:new:<key>. */
  async handleCallback(cb: CallbackQuery): Promise<boolean> {
    const allowed = this.deps.config.allowedUsers.includes(cb.from.id);
    if (!allowed) return false;
    const threadId = cb.message?.message_thread_id;
    const chatId = cb.message?.chat.id;
    if (chatId === undefined) return false;
    if (cb.data?.startsWith("gw:confirm:new:")) {
      const key = cb.data.slice("gw:confirm:new:".length);
      await this.deps.router.reset(key);
      await this.deps.client.sendMessage(chatId, threadId, "🆕 Lane zurückgesetzt");
      return true;
    }
    await this.deps.client.sendChatAction(chatId, threadId);
    return true;
  }

  async sendOutbound(chatId: number, threadId: number | undefined, text: string, replyTo?: number): Promise<void> {
    await this.deps.client.sendMessage(chatId, threadId, text, replyTo);
  }

  /** Long-running loop; resolves after stop(). */
  async loop(): Promise<void> {
    this.stopped = false;
    this.sweepTimer = setInterval(() => this.deps.router.sweepIdle(), this.deps.sweepIntervalMs ?? 30_000);
    try {
      while (!this.stopped) {
        try {
          await this.runOnce();
          await this.sleep(this.deps.pollDelayMs ?? 0);
        } catch {
          await this.sleep(2000); // backoff; status line handled by host
        }
      }
    } finally {
      this.stopSweep();
    }
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopSweep();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}