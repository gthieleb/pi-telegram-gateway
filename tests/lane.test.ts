import { describe, expect, it, vi } from "vitest";
import { Lane } from "../src/lane.js";

function fakeSession(reply = "ok") {
  return {
    messages: [] as unknown[],
    isStreaming: false,
    prompt: vi.fn(async function (this: { messages: unknown[] }) {
      this.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
    }),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

const deps = (onReply = vi.fn()) => ({
  onReply,
  log: vi.fn(),
  createSession: async () => fakeSession() as never,
});

describe("Lane", () => {
  it("creates session lazily and sends reply text", async () => {
    const onReply = vi.fn();
    const lane = await Lane.create("k1", deps(onReply));
    await lane.prompt("hello");
    expect(onReply).toHaveBeenCalledWith("ok");
    lane.dispose();
  });

  it("queues follow-up while busy, serializes replies", async () => {
    const onReply = vi.fn();
    const d = deps(onReply);
    const lane = await Lane.create("k2", d);
    const session = lane.sessionForTest();
    (session as { isStreaming: boolean }).isStreaming = true;
    await lane.prompt("second");
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.followUp).toHaveBeenCalledWith("second");
    lane.dispose();
  });

  it("dispose is idempotent", async () => {
    const lane = await Lane.create("k3", deps());
    const s = lane.sessionForTest();
    lane.dispose();
    lane.dispose();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });
});