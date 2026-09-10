import { describe, expect, it, vi } from "vitest";
import { Gateway } from "../src/gateway.js";
import type { TelegramClient, TgUpdate } from "../src/telegram.js";
import { CallbackRegistry } from "../src/callbacks.js";

const cfg = {
  version: 1, botToken: "t", botUsername: "PiLemmaBot", allowedUsers: [42],
  requireMention: false, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 4, mode: "auto",
};

function makeClient() {
  return {
    getMe: async () => ({ id: 1, username: "PiLemmaBot" }),
    getUpdates: vi.fn(async () => [] as TgUpdate[]),
    sendMessage: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
    setMyCommands: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
  } as unknown as TelegramClient & {
    sendMessage: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
}

const cbMsg = (over: object = {}): TgUpdate => ({
  update_id: 9,
  callback_query: {
    id: "cb1", from: { id: 42, is_bot: false },
    message: {
      message_id: 50, date: 0, from: { id: 1, is_bot: true },
      chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 7,
    },
    data: "",
  } as TgUpdate["callback_query"],
  ...over,
});

const router = () => ({
  dispatch: vi.fn(async () => {}),
  reset: vi.fn(),
  attachSession: vi.fn(async () => {}),
  sweepIdle: vi.fn(),
  disposeAll: vi.fn(),
  abortAll: vi.fn(async () => {}),
  size: 0,
});

describe("attach flow", () => {
  it("/attach sends a session picker keyboard", async () => {
    const client = makeClient();
    const r = router();
    const listSessions = vi.fn(async () => [
      { label: "Gateway · 12 msg", file: "/s/a.jsonl" },
      { label: "Refactor · 3 msg", file: "/s/b.jsonl" },
    ]);
    const gw = new Gateway({ config: cfg as never, client, router: r as never, listSessions });
    await gw.handleMessage({
      message_id: 1, date: 0, from: { id: 42, is_bot: false },
      chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "/attach",
    } as never);
    const kb = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][4] as {
      inline_keyboard: { callback_data: string }[][];
    };
    expect(kb.inline_keyboard).toHaveLength(3); // 2 sessions + cancel
    expect(kb.inline_keyboard[2][0].callback_data).toContain("cancel");
  });

  it("attach pick → replay choice → replay sends history + binds session", async () => {
    const client = makeClient();
    const r = router();
    const listSessions = vi.fn(async () => [{ label: "Gateway · 12 msg", file: "/s/a.jsonl" }]);
    const gw = new Gateway({
      config: cfg as never, client, router: r as never, listSessions,
      readHistory: () => [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello!" }],
    });
    // 1) /attach opens picker
    await gw.handleMessage({
      message_id: 1, date: 0, from: { id: 42, is_bot: false },
      chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "/attach",
    } as never);
    const pickKb = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][4] as {
      inline_keyboard: { callback_data: string }[][];
    };
    const pickCb: string = pickKb.inline_keyboard[0][0].callback_data; // gw:att:<pickId>:0
    // 2) user picks session 0
    await gw.handleCallback({
      id: "cb1", from: { id: 42, is_bot: false },
      message: { message_id: 50, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 7 },
      data: pickCb,
    } as never);
    // → replay keyboard sent (new menu id — extract from the keyboard itself)
    const repKb = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][4] as {
      inline_keyboard: { callback_data: string }[][];
    };
    const repCb: string = repKb.inline_keyboard[0][0].callback_data;
    expect(repCb.startsWith("gw:rep:")).toBe(true);
    // 3) user chooses "recent"
    (client.sendMessage as ReturnType<typeof vi.fn>).mockClear();
    await gw.handleCallback({
      id: "cb2", from: { id: 42, is_bot: false },
      message: { message_id: 51, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 7 },
      data: repCb,
    } as never);
    expect(r.attachSession).toHaveBeenCalledWith("-100:7", "/s/a.jsonl");
    const sentTexts = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as string);
    expect(sentTexts.some((t) => t.includes("**You:** Hi"))).toBe(true);
    expect(sentTexts.some((t) => t.includes("angehängt"))).toBe(true);
  });

  it("cancel answers the callback without attaching", async () => {
    const client = makeClient();
    const r = router();
    const gw = new Gateway({
      config: cfg as never, client, router: r as never,
      listSessions: async () => [{ label: "Gateway · 12 msg", file: "/s/a.jsonl" }],
    });
    await gw.handleMessage({
      message_id: 1, date: 0, from: { id: 42, is_bot: false },
      chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "/attach",
    } as never);
    const kb = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][4] as {
      inline_keyboard: { callback_data: string }[][];
    };
    const cancelCb = kb.inline_keyboard[1][0].callback_data; // 1 session + cancel row
    await gw.handleCallback({
      id: "cbx", from: { id: 42, is_bot: false },
      message: { message_id: 50, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 7 },
      data: cancelCb,
    } as never);
    expect(r.attachSession).not.toHaveBeenCalled();
    expect(client.answerCallbackQuery).toHaveBeenCalled();
  });

  it("ask_user callback resolves pending answer", async () => {
    const client = makeClient();
    const gw = new Gateway({ config: cfg as never, client, router: router() as never });
    const pending = gw.registerAskUser("-100:7", -100, 7, "Weiter?", ["Ja", "Nein"]);
    const kb = pending.keyboard;
    void kb;
    await gw.handleCallback({
      id: "cba", from: { id: 42, is_bot: false },
      message: { message_id: 60, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 7 },
      data: `gw:ans:${pending.menuId}:0`,
    } as never);
    expect(await pending.promise).toBe("Ja");
  });

  it("ask_user free-text reply resolves instead of dispatching", async () => {
    const client = makeClient();
    const r = router();
    const gw = new Gateway({ config: cfg as never, client, router: r as never });
    const pending = gw.registerAskUser("-100:7", -100, 7, "Weiter?", ["Ja"]);
    await gw.handleMessage({
      message_id: 2, date: 0, from: { id: 42, is_bot: false },
      chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "mach mal so",
    } as never);
    expect(r.dispatch).not.toHaveBeenCalled();
    expect(await pending.promise).toBe("mach mal so");
  });
});