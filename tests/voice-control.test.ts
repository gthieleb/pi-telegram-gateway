import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { VoiceController, type SpawnedChild } from "../src/voice-control.js";

function fakeChild(): SpawnedChild & { dataCb?: (buf: { toString(): string }) => void; exitCb?: (code?: number) => void } {
  const c = {
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn((e: string, cb: (buf: { toString(): string }) => void) => { if (e === "data") c.dataCb = cb; }) },
    stderr: { on: vi.fn() },
    on: vi.fn((e: string, cb: (code?: number) => void) => { if (e === "exit") c.exitCb = cb; }),
    kill: vi.fn(),
    killed: false,
    exitCode: null,
    dataCb: undefined as ((buf: { toString(): string }) => void) | undefined,
    exitCb: undefined as ((code?: number) => void) | undefined,
  };
  return c as never;
}

function makeController(opts: { send: (chatId: number, threadId: number | undefined, text: string) => Promise<void>; idleExitMs?: number }) {
  const child = fakeChild();
  const spawn = vi.fn(() => child as unknown as SpawnedChild);
  const controller = new VoiceController({
    send: opts.send,
    pythonBin: "python3",
    workerPath: "/gw/voice/worker.py",
    env: { API_ID: "1", API_HASH: "h", BOT_TOKEN: "t" },
    idleExitMs: opts.idleExitMs ?? 60_000,
    spawnFn: spawn,
    log: vi.fn(),
  });
  return { controller, spawn, child };
}

describe("VoiceController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lazy spawns on first command, queues IPC until ready, then flushes", async () => {
    const sends: string[] = [];
    const { controller, spawn, child } = makeController({ send: async (_c, _t, text) => void sends.push(text) });
    await controller.command({ cmd: "play", url: "https://x" }, -100, 7);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.stdin.write).not.toHaveBeenCalled(); // queued until ready
    expect(sends.some((t) => t.includes("Voice-Client start"))).toBe(true);
    child.dataCb!({ toString: () => JSON.stringify({ event: "ready", username: "PiLemmaBot" }) + "\n" });
    expect(child.stdin.write).toHaveBeenCalledWith('{"cmd":"play","chat":-100,"url":"https://x"}\n');
  });

  it("state events are forwarded to the origin topic", async () => {
    const sends: string[] = [];
    const { controller, child } = makeController({ send: async (_c, _t, text) => void sends.push(text) });
    await controller.command({ cmd: "play", url: "https://x" }, -100, 7);
    child.dataCb!({ toString: () => JSON.stringify({ event: "ready" }) + "\n" });
    child.dataCb!({ toString: () => JSON.stringify({ event: "state", text: "▶️ Playing: https://x" }) + "\n" });
    expect(sends).toContain("▶️ Playing: https://x");
  });

  it("idle exit terminates the child", async () => {
    const { controller, child } = makeController({ send: async () => {}, idleExitMs: 1000 });
    await controller.command({ cmd: "pause" }, -100, 7);
    expect(controller.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(child.kill).toHaveBeenCalled();
    expect(controller.isRunning()).toBe(false);
  });
});