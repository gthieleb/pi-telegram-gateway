// src/stt.ts — speech-to-text bridge (faster-whisper via python script)
import { spawn as nodeSpawn } from "node:child_process";

export interface SttDeps {
  pythonBin?: string;
  scriptPath: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Transcribe an audio file (ogg/wav/mp3) to text. Empty on failure. */
export async function transcribeFile(file: string, deps: SttDeps): Promise<string> {
  const pythonBin = deps.pythonBin ?? "python3";
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const child = nodeSpawn(pythonBin, [deps.scriptPath, file], {
    env: { ...process.env, ...(deps.env ?? {}) },
  });
  let out = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  await new Promise<void>((resolve) => {
    child.stdout?.on("data", (buf: { toString(): string }) => (out += buf.toString()));
    child.stderr?.on("data", () => {
      /* whisper progress → ignored */
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  clearTimeout(timer);
  try {
    const parsed = JSON.parse(out.trim()) as { text?: string; error?: string };
    if (parsed.error) {
      deps.log?.(`stt error: ${parsed.error}`);
      return "";
    }
    return parsed.text ?? "";
  } catch {
    deps.log?.(`stt: invalid output: ${out.slice(0, 200)}`);
    return "";
  }
}