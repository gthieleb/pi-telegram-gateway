// src/runtime.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join as joinPaths } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Lane } from "./lane.js";
import { makeLaneDeps } from "./lane-factory.js";
import { VoiceController } from "./voice-control.js";
import { transcribeFile } from "./stt.js";
import { synthesizeVoice } from "./tts.js";
import { configPaths, loadConfig, type GatewayConfig } from "./config.js";
import { claimLock, readLock, releaseLock, type LockHandle } from "./lock.js";
import { Gateway } from "./gateway.js";
import { Router } from "./router.js";
import { TelegramClient } from "./telegram.js";

function __dirnameVoice(): string {
  // package root (…/pi-telegram-gateway) — src/ is one level below
  return joinPaths(fileURLToPath(import.meta.url), "..", "..");
}

export interface StatusSink {
  setStatus(key: string, text: string): void;
}

export interface RuntimeStatus {
  mode: string;
  hostType: "daemon" | "extension";
  pid: number;
  lanes: number;
  since: number;
  lastError?: string;
}

export function readRuntimeStatus(statusFile: string): RuntimeStatus | null {
  try {
    return JSON.parse(readFileSync(statusFile, "utf8")) as RuntimeStatus;
  } catch {
    return null;
  }
}

export function writeRuntimeStatus(statusFile: string, status: RuntimeStatus): void {
  try {
    mkdirSync(configPaths(getAgentDir()).runtimeDir, { recursive: true });
    writeFileSync(statusFile, JSON.stringify(status));
  } catch {
    /* best effort */
  }
}

export interface StartedGateway {
  gateway: Gateway;
  release: () => void;
}

/** Shared gateway bootstrap used by both hosts (daemon CLI + extension). */
export async function startGateway(
  sink: StatusSink,
  log: (msg: string) => void,
  hostType: "daemon" | "extension" = "extension",
): Promise<Gateway | null> {
  const agentDir = getAgentDir();
  const paths = configPaths(agentDir);
  const cfg = loadConfig(agentDir);
  if (!cfg) {
    sink.setStatus("tg-gw", "unconfigured");
    return null;
  }

  const res = claimLock(paths.lockFile, { capability: `${hostType}:${process.pid}` });
  if (!res.leader || !res.lock) {
    const leaderPid = res.lock?.pid;
    sink.setStatus("tg-gw", `follower (other host pid ${leaderPid})`);
    return null;
  }
  const handle: LockHandle = { path: paths.lockFile, data: res.lock };

  const modelRuntime = await ModelRuntime.create();
  mkdirSync(paths.sessionsDir, { recursive: true });

  let offset = 0;
  try {
    offset = (JSON.parse(readFileSync(paths.stateFile, "utf8")) as { offset?: number }).offset ?? 0;
  } catch {
    /* fresh */
  }

  // persistent topic→session bindings
  let laneSessions: Record<string, string> = {};
  const readState = (): { offset?: number; laneSessions?: Record<string, string> } => {
    try {
      return JSON.parse(readFileSync(paths.stateFile, "utf8")) as { offset?: number; laneSessions?: Record<string, string> };
    } catch {
      return {};
    }
  };
  try {
    laneSessions = readState().laneSessions ?? {};
  } catch {
    laneSessions = {};
  }

  const client = new TelegramClient(cfg.botToken);
  const username = cfg.botUsername ?? (await client.getMe()).username;

  let gwRef: Gateway | null = null; // assigned after router; lanes only created via dispatch

  const router = new Router({
    createLane: async (key, resumeSessionFile) => {
      const [chatIdStr, threadPart] = key.split(":");
      const chatId = Number(chatIdStr);
      const threadId = threadPart === "root" ? undefined : Number(threadPart);
      if (resumeSessionFile) log(`lane ${key}: resuming ${resumeSessionFile.split("/").pop()}`);
      return await Lane.create(
        key,
        makeLaneDeps({
          cwd: cfg.cwd,
          sessionDir: paths.sessionsDir,
          modelRuntime,
          resumeSessionFile,
          onReply: async (text) => {
            await client.sendMessage(chatId, threadId, text);
            // voice conversation replies: TTS voice note + optional call output
            if (cfg.voice?.enabled && (cfg.voice.replies ?? "both") !== "text") {
              const ogg = await synthesizeVoice(text, {
                pythonBin: cfg.voice.pythonBin,
                modelPath: cfg.voice.ttsModelPath,
                log,
              });
              if (ogg?.endsWith(".ogg")) {
                try {
                  await client.sendVoice(chatId, threadId, ogg);
                } catch (err) {
                  log(`sendVoice failed: ${String(err)}`);
                }
              }
              if ((cfg.voice.callOutput ?? true) && voiceCtl) {
                if (ogg) await voiceCtl.playFileQuiet(chatId, ogg);
              }
            }
          },
          onAskUser: (question, options) => {
            if (!gwRef) throw new Error("gateway not ready");
            const pending = gwRef.registerAskUser(key, chatId, threadId, question, options);
            void client.sendMessage(chatId, threadId, question, undefined, pending.keyboard);
            return pending.promise;
          },
          log,
        }),
      );
    },
    idleTimeoutMs: cfg.idleTimeoutMinutes * 60_000,
    maxLanes: cfg.maxLanes,
    loadBinding: (key) => laneSessions[key],
    saveBinding: (key, sessionFile) => {
      laneSessions[key] = sessionFile;
      persistState();
    },
    clearBinding: (key) => {
      delete laneSessions[key];
      persistState();
    },
  });

  const voiceCtl: VoiceController | null =
    cfg.voice?.enabled === true
      ? (() => {
          const workerPath = cfg.voice.workerPath ?? joinPaths(__dirnameVoice(), "voice", "worker.py");
          const env: Record<string, string> = { VOICE_ENV: joinPaths(paths.base, "voice.env") };
          return new VoiceController({
            send: (chatId, threadId, text) => client.sendMessage(chatId, threadId, text),
            pythonBin: cfg.voice.pythonBin,
            workerPath,
            env,
            idleExitMs: (cfg.voice.idleExitMinutes ?? 10) * 60_000,
            log,
          });
        })()
      : null;

  const voiceConv: { transcribeVoice: (fileId: string) => Promise<string> } | undefined =
    cfg.voice?.enabled === true
      ? {
          transcribeVoice: async (fileId) => {
            const tmp = joinPaths(tmpdir(), `gw-voice-${fileId.slice(-12)}.ogg`);
            const downloaded = await client.downloadFile(fileId, tmp);
            if (!downloaded) return "";
            return await transcribeFile(downloaded, {
              pythonBin: cfg.voice?.pythonBin,
              scriptPath: joinPaths(__dirnameVoice(), "voice", "transcribe.py"),
              env: {
                WHISPER_MODEL: cfg.voice?.sttModel ?? "base",
                WHISPER_LANG: cfg.voice?.sttLanguage ?? "de",
              },
              log,
            });
          },
        }
      : undefined;

  const gw: Gateway = new Gateway({
    config: cfg,
    client,
    router,
    pollDelayMs: 50,
    sweepIntervalMs: 30_000,
    voice: voiceCtl ?? undefined,
    voiceConv,
  });
  gwRef = gw;
  gw.offset = offset;

  try {
    await client.setMyCommands([
      { command: "new", description: "Lane zurücksetzen (frische Session)" },
      { command: "attach", description: "Bestehende pi-Session anhängen" },
      { command: "status", description: "Gateway-Status zeigen" },
      { command: "help", description: "Kommando-Übersicht" },
    ]);
  } catch {
    /* menu sync is best effort */
  }

  const writeStatus = () =>
    writeRuntimeStatus(paths.statusFile, {
      mode: cfg.mode,
      hostType,
      pid: process.pid,
      lanes: router.size,
      since: Date.now(),
    });
  const persistOffset = () => {
    try {
      writeFileSync(paths.stateFile, JSON.stringify({ offset: gw.offset, laneSessions }));
    } catch {
      /* ok */
    }
  };
  const persistState = persistOffset;

  const sweep = setInterval(() => {
    // mode takeover: if a daemon claimed the lock, extension host must stop polling
    if (hostType === "extension") {
      const current = readLock(paths.lockFile);
      if (current && current.capability.startsWith("daemon:")) {
        log("daemon took over lock — stopping extension gateway");
        sink.setStatus("tg-gw", `daemon (pid ${current.pid})`);
        gw.stop();
        return;
      }
    }
    router.sweepIdle();
    writeStatus();
  }, 30_000);

  void (async () => {
    sink.setStatus("tg-gw", `connected · bot @${username} (${hostType})`);
    writeStatus();
    try {
      await gw.loop();
    } finally {
      clearInterval(sweep);
      await router.abortAll().catch(() => {});
      router.disposeAll();
      persistOffset();
      releaseLock(paths.lockFile, handle);
    }
  })().catch(() => {});

  return gw;
}