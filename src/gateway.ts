// src/gateway.ts
import type { GatewayConfig } from "./config.js";
import { parseCommand, shouldDispatch } from "./gate.js";
import type { Router } from "./router.js";
import type { TelegramClient, TgMessage, TgUpdate, CallbackQuery } from "./telegram.js";
import { laneKey } from "./router.js";
import { CallbackRegistry, newMenuId } from "./callbacks.js";
import { sessionsKeyboard, attachReplayKeyboard, askUserKeyboard, type SessionOption } from "./keyboard.js";
import { readSessionMessages, renderSessionHistory } from "./replay.js";
import { isVoiceCommand, type VoiceCommand } from "./voice.js";

export interface SessionListItem extends SessionOption {}

export type MenuPayload =
  | { kind: "attach-pick"; files: SessionListItem[] }
  | { kind: "attach-replay"; key: string; chatId: number; threadId?: number; file: string; label: string }
  | { kind: "ask"; key: string; chatId: number; threadId?: number; options: string[] };

export interface GatewayDeps {
  config: GatewayConfig;
  client: {
    getMe: () => Promise<{ id: number; username: string }>;
    getUpdates: (offset: number, timeoutSec?: number) => Promise<TgUpdate[]>;
    sendMessage: (
      chatId: number,
      threadId: number | undefined,
      text: string,
      replyTo?: number,
      replyMarkup?: object,
    ) => Promise<void>;
    sendChatAction: (chatId: number, threadId?: number) => Promise<void>;
    answerCallbackQuery?: (id: string, text?: string) => Promise<void>;
    setMyCommands?: (commands: { command: string; description: string }[]) => Promise<void>;
  };
  router: Router;
  /** voice sidecar controller (only when voice.enabled in config) */
  voice?: { command: (v: VoiceCommand, chatId: number, threadId?: number) => Promise<void>; dispose(): void };
  pollDelayMs?: number;
  sweepIntervalMs?: number;
  /** injected: session list for the /attach picker */
  listSessions?: () => Promise<SessionListItem[]>;
  /** injected: transcript history reader for replay */
  readHistory?: (file: string) => { role: string; text: string }[];
  /** shared inline-keyboard menu registry */
  callbacks?: CallbackRegistry<MenuPayload>;
}

const RECENT_LIMIT = 10;

export class Gateway {
  offset = 0;
  private stopped = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private username = "";
  private menus: CallbackRegistry<MenuPayload>;
  private pendingAskByLane = new Map<string, string>(); // laneKey → menuId
  private pendingAskMenu = new Map<string, { key: string; resolve: (v: string) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private deps: GatewayDeps) {
    this.menus = deps.callbacks ?? new CallbackRegistry<MenuPayload>();
  }

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

  async handleMessage(m: TgMessage): Promise<void> {
    const botUsername = await this.resolveBotUsername();
    if (!shouldDispatch(m as never, this.deps.config, botUsername)) return;
    const threadId = m.message_thread_id;
    const text = (m.text ?? m.caption ?? "").trim();
    if (!text) return;
    const laneKeyStr = laneKey(m.chat.id, threadId);

    const cmd = parseCommand(text);
    if (cmd?.name === "new") {
      this.deps.router.reset(laneKeyStr);
      await this.deps.client.sendMessage(m.chat.id, threadId, "🆕 Lane zurückgesetzt — nächste Nachricht startet frisch.");
      return;
    }
    if (cmd?.name === "attach") {
      await this.openAttachPicker(m);
      return;
    }
    if (cmd?.name === "status") {
      await this.deps.client.sendMessage(
        m.chat.id, threadId,
        `Gateway online · lanes: ${this.deps.router.size} · mode: ${this.deps.config.mode}`,
      );
      return;
    }
    if (cmd?.name === "help") {
      await this.deps.client.sendMessage(
        m.chat.id, threadId,
        "Kommandos: /new (Lane zurücksetzen) · /attach (pi-Session anhängen) · /status · " +
          "normale Nachrichten gehen an den Agent. Der Agent kann Entscheidungen als Buttons stellen (ask_user).",
      );
      return;
    }

    // pending ask_user in this lane? → free-text reply resolves it, no dispatch
    const pendingMenuId = this.pendingAskByLane.get(laneKeyStr);
    if (pendingMenuId && this.pendingAskMenu.has(pendingMenuId)) {
      this.resolveAsk(pendingMenuId, text);
      return;
    }

    // voice commands (!play, !pause, …) bypass the lane and drive the sidecar
    const voice = isVoiceCommand(text);
    if (voice) {
      if (this.deps.voice) {
        await this.deps.voice.command(voice, m.chat.id, threadId);
        return;
      }
      await this.deps.client.sendMessage(m.chat.id, threadId, "🔇 Voice ist in dieser Konfiguration deaktiviert.");
      return;
    }

    await this.deps.client.sendChatAction(m.chat.id, threadId);
    await this.deps.router.dispatch(laneKeyStr, text);
  }

  /** Handle inline-keyboard callbacks: attach, replay, ask_user, confirm:new. */
  async handleCallback(cb: CallbackQuery): Promise<boolean> {
    const allowed = this.deps.config.allowedUsers.includes(cb.from.id);
    if (!allowed) return false;
    const threadId = cb.message?.message_thread_id;
    const chatId = cb.message?.chat.id;
    if (chatId === undefined) return false;
    const data = cb.data ?? "";
    const answer = (text?: string) => this.deps.client.answerCallbackQuery?.(cb.id, text);

    // --- attach: pick session
    if (data.startsWith("gw:att:")) {
      const [, rest] = ["gw:att:", data.slice("gw:att:".length)];
      const menuId = rest.split(":")[0];
      const idx = rest.split(":")[1];
      const menu = this.menus.peekAt(`att:${menuId}`) as { files: SessionListItem[] } | undefined;
      if (!menu || idx === "cancel") {
        await answer("Abgebrochen");
        return true;
      }
    const picked = menu.files[Number(idx)];
      if (!picked) {
        await answer("Ungültige Auswahl");
        return true;
      }
      const repId = newMenuId();
      this.menus.registerAt(`rep:${repId}`, { kind: "attach-replay", key: laneKey(chatId, threadId), chatId, threadId, file: picked.file, label: picked.label });
      await answer();
      await this.deps.client.sendMessage(chatId, threadId, `📎 „${picked.label}" — Verlauf senden?`, undefined, attachReplayKeyboard(repId));
      return true;
    }

    // --- attach: replay choice → history + bind
    if (data.startsWith("gw:rep:")) {
      const menuId = data.slice("gw:rep:".length).split(":")[0];
      const mode = data.slice("gw:rep:".length).split(":")[1];
      const menu = this.menus.peekAt(`rep:${menuId}`) as MenuPayload | undefined;
      await answer();
      if (!menu || menu.kind !== "attach-replay") {
        await this.deps.client.sendMessage(chatId, threadId, "⏱ Menü abgelaufen — bitte /attach erneut.");
        return true;
      }
      if (mode === "recent" || mode === "full") {
        const history = (this.deps.readHistory ?? ((f: string) => readSessionMessages(f)))(menu.file);
        const rendered = renderSessionHistory(history, mode === "recent" ? RECENT_LIMIT : undefined);
        if (rendered) await this.deps.client.sendMessage(chatId, threadId, rendered);
      }
      await this.deps.router.attachSession(menu.key, menu.file);
      await this.deps.client.sendMessage(chatId, threadId, `📎 „${menu.label}" angehängt — ab hier lebt diese Session in diesem Topic.`);
      return true;
    }

    // --- ask_user resolution
    if (data.startsWith("gw:ans:")) {
      const menuId = data.slice("gw:ans:".length).split(":")[0];
      const choice = data.slice("gw:ans:".length).split(":")[1] ?? "";
      const pending = this.pendingAskMenu.get(menuId);
      if (!pending) {
        await answer("⏱ Abgelaufen");
        return true;
      }
      if (choice === "text") {
        await answer("Schreib deine Antwort als normale Nachricht in diesem Topic.");
        return true; // pending stays open; next text message resolves it
      }
      if (choice === "skip") {
        this.resolveAsk(menuId, "(übersprungen)");
        await answer("Übersprungen");
        return true;
      }
      const ask = this.menus.peekAt(`ask:${menuId}`) as { options: string[] } | undefined;
      const answerText = ask?.options[Number(choice)] ?? "(ungültige Auswahl)";
      this.resolveAsk(menuId, answerText);
      await answer();
      return true;
    }

    // --- /new confirm (v2 later: keyboard) — keep plain for now
    if (data.startsWith("gw:confirm:new:")) {
      const key = data.slice("gw:confirm:new:".length);
      this.deps.router.reset(key);
      await this.deps.client.sendMessage(chatId, threadId, "🆕 Lane zurückgesetzt");
      return true;
    }
    return false;
  }

  async sendOutbound(chatId: number, threadId: number | undefined, text: string, replyTo?: number): Promise<void> {
    await this.deps.client.sendMessage(chatId, threadId, text, replyTo);
  }

  /** /attach: list sessions as inline keyboard. */
  private async openAttachPicker(m: TgMessage): Promise<void> {
    if (!this.deps.listSessions) {
      await this.deps.client.sendMessage(m.chat.id, m.message_thread_id, "Attach nicht verfügbar.");
      return;
    }
    const sessions = (await this.deps.listSessions()).slice(0, 6);
    if (sessions.length === 0) {
      await this.deps.client.sendMessage(m.chat.id, m.message_thread_id, "Keine Sessions gefunden.");
      return;
    }
    const id = newMenuId();
    this.menus.registerAt(`att:${id}`, { kind: "attach-pick", files: sessions });
    await this.deps.client.sendMessage(m.chat.id, m.message_thread_id, "Session wählen:", undefined, sessionsKeyboard(id, sessions));
  }

  /** Ask the user via inline keyboard (used by the ask_user tool in lanes). */
  registerAskUser(
    laneKeyStr: string,
    chatId: number,
    threadId: number | undefined,
    question: string,
    options: string[],
    timeoutMs = 10 * 60_000,
  ): { menuId: string; promise: Promise<string>; keyboard: object } {
    const menuId = newMenuId();
    this.menus.registerAt(`ask:${menuId}`, { kind: "ask", key: laneKeyStr, chatId, threadId, options }, timeoutMs);
    const promise = new Promise<string>((resolve) => {
      const timer = setTimeout(() => this.resolveAsk(menuId, "(keine Antwort, Timeout)"), timeoutMs);
      this.pendingAskMenu.set(menuId, { key: laneKeyStr, resolve, timer });
    });
    this.pendingAskByLane.set(laneKeyStr, menuId);
    return { menuId, promise, keyboard: askUserKeyboard(menuId, options) };
  }

  private resolveAsk(menuId: string, answer: string): void {
    const pending = this.pendingAskMenu.get(menuId);
    if (!pending) return;
    this.pendingAskMenu.delete(menuId);
    clearTimeout(pending.timer);
    if (this.pendingAskByLane.get(pending.key) === menuId) this.pendingAskByLane.delete(pending.key);
    pending.resolve(answer);
  }

  /** Long-running loop; resolves after stop(). */
  async loop(): Promise<void> {
    this.stopped = false;
    this.sweepTimer = setInterval(() => {
      this.deps.router.sweepIdle();
      this.menus.sweep();
    }, this.deps.sweepIntervalMs ?? 30_000);
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