import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram.js";

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const update = (id: number, text = "hi") => ({
  update_id: id,
  message: { message_id: id, date: 0, from: { id: 42, is_bot: false }, chat: { id: -100, type: "supergroup" }, text },
});

describe("TelegramClient", () => {
  it("getUpdates passes offset+timeout and returns updates", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ ok: true, result: [update(5)] }));
    const client = new TelegramClient("TOK", "https://api.test", fetchFn as typeof fetch);
    const updates = await client.getUpdates(4, 25);
    expect(updates).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/botTOK/getUpdates");
    expect(String(init.body)).toContain('"offset":4');
    expect(String(init.body)).toContain('"timeout":25');
  });

  it("sendMessage chunks and threads", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ ok: true, result: {} }));
    const client = new TelegramClient("TOK", "https://api.test", fetchFn as typeof fetch);
    await client.sendMessage(-100, 77, "x".repeat(5000));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(firstBody.message_thread_id).toBe(77);
    expect(firstBody.text.length).toBeLessThanOrEqual(4096);
  });

  it("429 waits retry_after then retries", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonRes({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0 } }, 429))
      .mockResolvedValueOnce(jsonRes({ ok: true, result: { message_id: 1 } }));
    const client = new TelegramClient("TOK", "https://api.test", fetchFn as typeof fetch);
    const sleepSpy = vi.spyOn(client as unknown as { sleep: (ms: number) => Promise<void> }, "sleep").mockResolvedValue(undefined);
    const res = await client.call("sendMessage", { chat_id: 1, text: "y" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((res as { message_id: number }).message_id).toBe(1);
    sleepSpy.mockRestore();
  });

  it("throws BotApiError with description on failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ ok: false, description: "Bad Request: chat not found" }, 400));
    const client = new TelegramClient("TOK", "https://api.test", fetchFn as typeof fetch);
    await expect(client.call("sendMessage", { chat_id: 1, text: "y" })).rejects.toThrow(/chat not found/);
  });
});