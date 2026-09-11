import { describe, expect, it, vi } from "vitest";
import { transcribeFile } from "../src/stt.js";
import { synthesizeVoice } from "../src/tts.js";
import { VoiceController } from "../src/voice-control.js";

describe("stt bridge", () => {
  it("parses worker json output", async () => {
    vi.mock("node:child_process", () => ({
      spawn: vi.fn(() => ({
        stdout: { on: vi.fn((e: string, cb: (b: { toString(): string }) => void) => cb({ toString: () => '{"text":"Hallo Welt"}\n' })) },
        stderr: { on: vi.fn() },
        on: vi.fn((e: string, cb: () => void) => { if (e === "exit") cb(); }),
        stdin: { end: vi.fn() },
        kill: vi.fn(),
      })),
    }));
    const { transcribeFile: tf } = await import("../src/stt.js");
    const text = await tf("/tmp/x.ogg", { scriptPath: "/s/transcribe.py" });
    expect(text).toBe("Hallo Welt");
  });
});

describe("tts bridge", () => {
  it("piper → ffmpeg chain returns ogg path", async () => {
    const spawned: string[][] = [];
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn((cmd: string, args: string[]) => {
        spawned.push([cmd, ...args]);
        return {
          stdin: { end: vi.fn() },
          on: vi.fn((e: string, cb: (code?: number) => void) => { if (e === "exit") cb(0); }),
        };
      }),
    }));
    const { synthesizeVoice: sv } = await import("../src/tts.js");
    const result = await sv("Hallo", { modelPath: "/m.onnx", tmpDir: "/tmp/tts-test" });
    expect(result?.endsWith(".ogg")).toBe(true);
    expect(spawned[0][0]).toBe("python3"); // piper via python -m
    expect(spawned[1][0]).toBe("ffmpeg");
  });
});

describe("voice controller: play_file quiet", () => {
  it("play_file errors are not forwarded (quiet)", async () => {
    const sends: string[] = [];
    const child = {
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      killed: false,
      exitCode: null,
    };
    const controller = new VoiceController({
      send: async (_c, _t, text) => void sends.push(text),
      workerPath: "/w.py",
      spawnFn: () => child as never,
      log: vi.fn(),
    });
    await controller.command({ cmd: "play", url: "x" }, -100, 7);
    controller.handleStdoutLine(JSON.stringify({ event: "ready" }) + "\n");
    await controller.playFileQuiet(-100, "/tmp/tts.ogg");
    expect(child.stdin.write).toHaveBeenCalledWith('{"cmd":"play_file","chat":-100,"path":"/tmp/tts.ogg","quiet":true}\n');
    controller.handleStdoutLine(JSON.stringify({ event: "error", quiet: true, text: "not in call" }) + "\n");
    expect(sends.filter((s) => s.includes("not in call"))).toEqual([]);
  });
});