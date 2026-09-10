import { describe, expect, it, vi } from "vitest";
import { Gateway } from "../src/gateway.js";
import type { TelegramClient, TgUpdate } from "../src/telegram.js";

function makeClient(updates: TgUpdate[][]) {
  let page = 0;
  return {
    getMe: async () => ({ id: 1, username: "PiLemmaBot" }),
    getUpdates: vi.fn(async () => updates[Math.min(page++, updates.length - 1)]),
    sendMessage: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
    setMyCommands: vi.fn(async () => {}),
  } as unknown as TelegramClient & { getUpdates: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
}

const cfg = {
  version: 1, botToken: "t", botUsername: "PiLemmaBot", allowedUsers: [42],
  requireMention: false, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 4, mode: "auto",
};

const msg = (over: object = {}): TgUpdate => ({
  update_id: 1,
  message: {
    message_id: 1, date: 0, from: { id: 42, is_bot: false },
    chat: { id: -100, type: "supergroup", is_forum: true },
    message_thread_id: 7, text: "hello",
  } as TgUpdate["message"],
  ...over,
});

function harness(updates: TgUpdate[][], routerOverrides?: Record<string, unknown>) {
  const client = makeClient(updates);
  const router = routerOverrides ?? {
    dispatch: vi.fn(async () => {}),
    sweepIdle: vi.fn(),
    disposeAll: vi.fn(),
    abortAll: vi.fn(async () => {}),
    size: 0,
  };
  const gw = new Gateway({
    config: cfg as never,
    client,
    router: router as never,
    sweepIntervalMs: 10_000,
    pollDelayMs: 0,
  });
  return { gw, client, router };
}

describe("Gateway", () => {
  it("processes one batch and advances offset", async () => {
    const { gw, client, router } = harness([[msg()], []]);
    await gw.runOnce();
    expect(router.dispatch).toHaveBeenCalledWith("-100:7", "hello");
    expect(gw.offset).toBe(2);
    void client;
  });

  it("ignores messages from non-allowed users", async () => {
    const { gw, router } = harness([[
      msg({
        message: {
          message_id: 1, date: 0, from: { id: 999, is_bot: false },
          chat: { id: -100, type: "supergroup" }, text: "x", message_thread_id: 7,
        },
      }),
    ], []]);
    await gw.runOnce();
    expect(router.dispatch).not.toHaveBeenCalled();
  });

  it("routes /status as lane command, not prompt", async () => {
    const { gw, client, router } = harness([[
      msg({
        message: {
          message_id: 1, date: 0, from: { id: 42, is_bot: false },
          chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "/status",
        },
      }),
    ], []]);
    await gw.runOnce();
    expect(router.dispatch).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalled();
  });

  it("sendOutbound delegates to client with thread id", async () => {
    const { gw, client } = harness([[msg()], []]);
    await gw.sendOutbound(-100, 7, "hello world");
    expect(client.sendMessage).toHaveBeenCalledWith(-100, 7, "hello world", undefined);
  });

  it("callback queries with wrong user are ignored", async () => {
    const { gw, client } = harness([[], []]);
    const handled = await gw.handleCallback({
      id: "cb1", from: { id: 999, is_bot: false }, message: msg().message, data: "gw:model:x/y",
    } as never);
    expect(handled).toBe(false);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});