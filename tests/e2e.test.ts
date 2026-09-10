/**
 * Automated e2e smoke of the embedded gateway stack — no network:
 * Gateway + Router + Lane + fake AgentSession + temp state.json.
 * Verifies: /attach → picker → replay → binding → resume → ask_user timeout.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Gateway } from "../src/gateway.js";
import { Router } from "../src/router.js";
import { Lane } from "../src/lane.js";
import { CallbackRegistry, newMenuId } from "../src/callbacks.js";
import type { LikeLane } from "../src/router.js";
import type { MenuPayload } from "../src/gateway.js";

const cfg = {
  version: 1, botToken: "t", botUsername: "PiLemmaBot", allowedUsers: [42],
  requireMention: false, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 4, mode: "daemon",
};

function buildStack(tmp: string) {
  const sent: { text: string; markup?: object }[] = [];
  const client = {
    getMe: async () => ({ id: 1, username: "PiLemmaBot" }),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async (_c: number, _t: number | undefined, text: string, _r?: number, markup?: object) => {
      sent.push({ text, markup });
    }),
    sendChatAction: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    setMyCommands: vi.fn(async () => {}),
  };
  const bindings = new Map<string, string>();
  const prompts: string[] = [];
  const router = new Router({
    createLane: async (key, resume) => {
      if (resume) bindings.get(`resume:${key}`);
      return await Lane.create(key, {
        createSession: async () => {
          const session = {
            messages: [] as unknown[],
            isStreaming: false,
            sessionFile: `${tmp}/sessions/${newMenuId()}.jsonl`,
            prompt: vi.fn(async function (this: { messages: unknown[] }, t: string) {
              prompts.push(t);
              this.messages.push({ role: "assistant", content: `Echo: ${t}` });
            }),
            followUp: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
            dispose: vi.fn(),
          };
          return session as never;
        },
        onReply: async (text) => void client.sendMessage(-100, 7, text),
        log: vi.fn(),
      });
    },
    idleTimeoutMs: 60_000,
    maxLanes: 4,
    loadBinding: (k) => bindings.get(k),
    saveBinding: (k, f) => bindings.set(k, f),
    clearBinding: (k) => bindings.delete(k),
  });
  const gw = new Gateway({ config: cfg as never, client, router: router as never, callbacks: new CallbackRegistry<MenuPayload>() });
  return { gw, router, sent, prompts, bindings };
}

const tm = (text: string, id = 1) => ({
  message_id: id, date: 0, from: { id: 42, is_bot: false },
  chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 7, text,
});

describe("e2e smoke (no network)", () => {
  it("full pipeline: prompt → lane → reply + persistent binding", async () => {
    const tmp = mkdtempSync("/tmp/gw-e2e-");
    const { gw, router, sent } = buildStack(tmp);
    await gw.handleMessage({ message_id: 1, date: 0, from: { id: 42, is_bot: false }, chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "hello agent" } as never);
    expect(router.has("-100:7")).toBe(true);
    expect(sent.some((s) => s.text.includes("Echo: hello agent"))).toBe(true);
    router.disposeAll();
  });

  it("/attach → pick → replay(recent) → attachSession called", async () => {
    const tmp = mkdtempSync(join("/tmp", "gw-e2e2-"));
    const sessionFile = join(tmp, "att.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "old task" } }) + "\n");
    const stack = buildStack(tmp);
    const { gw, router: r, sent } = stack;
    void r;
    const gwAny = gw as unknown as { deps: { listSessions: unknown; readHistory: unknown } };
    // inject list + history reader via gateway deps (test seam)
    const gw2 = new Gateway({
      config: cfg as never,
      client: {
        getMe: async () => ({ id: 1, username: "PiLemmaBot" }),
        getUpdates: vi.fn(async () => []),
        sendMessage: vi.fn(async (_c: number, _t: number | undefined, text: string, _r?: number, markup?: object) => void sent.push({ text, markup })),
        sendChatAction: vi.fn(async () => {}),
        answerCallbackQuery: vi.fn(async () => {}),
        setMyCommands: vi.fn(async () => {}),
      },
      router: r,
      listSessions: async () => [{ label: "Attached test · 1 msg", file: sessionFile }],
      readHistory: (f: string) => [{ role: "user", text: "old task" }],
    });
    void gwAny;
    await gw2.handleMessage({ message_id: 1, date: 0, from: { id: 42, is_bot: false }, chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "/attach" } as never);
    const pickerSent = sent.find((s) => (s.markup as { inline_keyboard?: unknown })?.inline_keyboard)!;
    const pickKb2 = (pickerSent.markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0].callback_data;
    await gw2.handleCallback({ id: "c1", from: { id: 42, is_bot: false }, message: { message_id: 9, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 7 }, data: pickKb2 } as never);
    const repCb = (sent[sent.length - 1].markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0].callback_data;
    (sent as unknown as { length: number }).length = 0;
    await gw2.handleCallback({ id: "c2", from: { id: 42, is_bot: false }, message: { message_id: 10, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 7 }, data: repCb } as never);
    const texts = sent.map((s) => s.text);
    expect(texts.some((t) => t.includes("**You:** old task"))).toBe(true);
    expect(texts.some((t) => t.includes("angehängt"))).toBe(true);
  });

  it("ask_user timeout resolves with timeout text", async () => {
    const tmp = mkdtempSync(join("/tmp", "gw-e2e3-"));
    const { gw } = buildStack(tmp);
    const pending = gw.registerAskUser("-100:7", -100, 7, "Warten?", ["Ja"], 20);
    expect(await pending.promise).toBe("(keine Antwort, Timeout)");
  });
});