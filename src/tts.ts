// src/tts.ts — text-to-speech via piper (wav) + ffmpeg (ogg/opus for sendVoice)
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TtsDeps {
  piperBin?: string; // default "python3 -m piper"
  modelPath?: string; // default ~/.local/share/piper/de_DE-thorsten-medium.onnx
  pythonBin?: string;
  ffmpegBin?: string; // default "ffmpeg"
  tmpDir?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

function run(cmd: string, args: string[], input: string | undefined, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { stdio: input !== undefined ? ["pipe", "ignore", "inherit"] : ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Synthesize text → OGG/Opus file suitable for Telegram sendVoice. Returns path or null. */
export async function synthesizeVoice(text: string, deps: TtsDeps): Promise<string | null> {
  const pythonBin = deps.pythonBin ?? "python3";
  const model = deps.modelPath ?? join(deps.tmpDir ?? process.env.HOME ?? "/tmp", ".local/share/piper/de_DE-thorsten-medium.onnx");
  const tmpDir = deps.tmpDir ?? mkdtempSync(join(tmpdir(), "tts-"));
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const wav = join(tmpDir, `tts-${randomUUID().slice(0, 8)}.wav`);
  const ogg = join(tmpDir, `tts-${randomUUID().slice(0, 8)}.ogg`);

  const code = await run(
    pythonBin,
    ["-m", "piper", "-m", model, "-f", wav],
    text,
    timeoutMs,
  );
  if (code !== 0) {
    deps.log?.("tts: piper failed");
    return null;
  }
  const ffCode = await run("ffmpeg", ["-y", "-i", wav, "-c:a", "libopus", "-b:a", "32k", ogg], undefined, timeoutMs);
  return ffCode === 0 ? ogg : wav; // ogg preferred; wav fallback (sendAudio)
}