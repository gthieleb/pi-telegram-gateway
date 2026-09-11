// src/voice-control.ts
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { voiceIpcMessage, type VoiceCommand, type VoiceEvent } from "./voice.js";

export interface SpawnedChild {
  stdin: { write(s: string): void };
  stdout: { on(event: string, cb: (buf: { toString(): string }) => void): void };
  stderr: { on(event: string, cb: (buf: unknown) => void): void };
  on(event: string, cb: (code?: number) => void): void;
  kill(signal?: string): void;
  killed: boolean;
  exitCode: number | null;
}

export interface VoiceControlDeps {
  send: (chatId: number, threadId: number | undefined, text: string) => Promise<void>;
  pythonBin?: string;
  workerPath: string;
  env?: Record<string, string>;
  idleExitMs?: number;
  spawnFn?: (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: string[] }) => SpawnedChild;
  log?: (msg: string) => void;
}

/** Spawns and drives the python voice sidecar over JSON-lines IPC. */
export class VoiceController {
  private child: SpawnedChild | null = null;
  private ready = false;
  private queue: string[] = [];
  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: VoiceControlDeps) {}

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Handle a !voice command from Telegram; spawns the worker lazily. */
  async command(v: VoiceCommand, chatId: number, threadId?: number): Promise<void> {
    this.lastActivity = Date.now();
    this.ensureChild(chatId, threadId);
    const line = voiceIpcMessage({ cmd: v.cmd, chat: chatId, url: v.url, volume: v.args ? Number(v.args) : undefined });
    if (!this.ready) {
      this.queue.push(line);
      return;
    }
    this.child!.stdin.write(line);
  }

  private lastOrigin: { chatId: number; threadId?: number } = { chatId: 0 };

  /** Play a local TTS file into the active voice chat; errors stay quiet. */
  async playFileQuiet(chatId: number, path: string): Promise<void> {
    this.ensureChild(chatId, undefined);
    const line = voiceIpcMessage({ cmd: "play_file", chat: chatId, path, quiet: true });
    if (!this.ready) {
      this.queue.push(line);
      return;
    }
    this.child?.stdin.write(line);
  }

  /** test seam: feed one stdout line as if the worker emitted it. */
  handleStdoutLine(line: string): void {
    const event = line.trim();
    if (!event) return;
    let parsed: VoiceEvent;
    try {
      parsed = JSON.parse(event) as VoiceEvent;
    } catch {
      return;
    }
    if (parsed.event === "ready") {
      this.ready = true;
      const q = this.queue;
      this.queue = [];
      for (const l of q) this.child?.stdin.write(l);
      return;
    }
    const text = (parsed as { text?: string }).text;
    const quiet = (parsed as { quiet?: boolean }).quiet === true;
    if (quiet) return; // suppressed (e.g. play_file into a non-active call)
    if (typeof text === "string" && text) {
      const chat = (parsed as { chat?: number }).chat ?? this.lastOrigin.chatId;
      void this.deps.send(chat, this.lastOrigin.threadId, text);
    }
  }


  private ensureChild(chatId: number, threadId?: number): void {
    this.lastOrigin = { chatId, threadId };
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    const spawnFn = this.deps.spawnFn ?? nodeSpawn;
    const child = spawnFn(this.deps.pythonBin ?? "python3", [this.deps.workerPath], {
      env: { ...process.env, ...(this.deps.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    }) as SpawnedChild;
    child.stdout?.on("data", (buf: { toString(): string }) => {
      for (const line of buf.toString().split("\n")) this.handleStdoutLine(line);
    });
    child.stderr?.on("data", () => {
      /* pyrogram logs to stderr — ignored */
    });
    child.on("exit", () => {
      this.child = null;
      this.ready = false;
      this.queue = [];
    });
    this.child = child;
    this.ready = false;
    this.queue = [];
    this.deps.log?.("🎙 voice worker spawned (lazy)");
    void this.deps.send(chatId, threadId, "⏳ Voice-Client startet …");
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => {
        if (Date.now() - this.lastActivity > (this.deps.idleExitMs ?? 600_000)) {
          this.child?.kill("SIGTERM");
          this.child = null;
          this.ready = false;
        }
      }, 30_000);
    }
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* ok */
    }
    this.child = null;
    this.ready = false;
  }
}