// src/config.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostMode = "auto" | "daemon" | "extension";

export interface VoiceConfig {
  enabled: boolean;
  idleExitMinutes?: number;
  workerPath?: string;
  pythonBin?: string;
}

export interface GatewayConfig {
  version: number;
  botToken: string;
  botUsername?: string;
  allowedUsers: number[];
  requireMention: boolean;
  cwd: string;
  idleTimeoutMinutes: number;
  maxLanes: number;
  mode: HostMode;
  voice?: VoiceConfig;
}

const HOST_MODES = new Set<HostMode>(["auto", "daemon", "extension"]);

function assertValid(r: Record<string, unknown>): void {
  if (typeof r.botToken !== "string" || !r.botToken.trim()) throw new Error("Invalid config: botToken required");
  if (!Array.isArray(r.allowedUsers) || r.allowedUsers.length === 0)
    throw new Error("Invalid config: allowedUsers must be a non-empty array of Telegram user ids");
  if (r.maxLanes !== undefined && (typeof r.maxLanes !== "number" || r.maxLanes < 1))
    throw new Error("Invalid config: maxLanes must be >= 1");
  if (r.idleTimeoutMinutes !== undefined && (typeof r.idleTimeoutMinutes !== "number" || r.idleTimeoutMinutes < 1))
    throw new Error("Invalid config: idleTimeoutMinutes must be >= 1");
  if (r.mode !== undefined && (typeof r.mode !== "string" || !HOST_MODES.has(r.mode as HostMode)))
    throw new Error("Invalid config: mode must be one of auto|daemon|extension");
  if (r.voice !== undefined) {
    if (typeof r.voice !== "object" || r.voice === null || typeof (r.voice as { enabled?: unknown }).enabled !== "boolean")
      throw new Error("Invalid config: voice.enabled must be a boolean");
  }
}

function build(r: Record<string, unknown>): GatewayConfig {
  return {
    version: 1,
    botToken: r.botToken as string,
    botUsername: r.botUsername as string | undefined,
    allowedUsers: r.allowedUsers as number[],
    requireMention: (r.requireMention as boolean | undefined) ?? false,
    cwd: (r.cwd as string | undefined) ?? homedir(),
    idleTimeoutMinutes: (r.idleTimeoutMinutes as number | undefined) ?? 30,
    maxLanes: (r.maxLanes as number | undefined) ?? 8,
    mode: (r.mode as HostMode | undefined) ?? "auto",
  };
}

export function validateRaw(raw: unknown): GatewayConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid config: not an object");
  const r = raw as Record<string, unknown>;
  assertValid(r);
  return build(r);
}

export function normalizeConfig(partial: Partial<GatewayConfig>): GatewayConfig {
  const r = partial as Record<string, unknown>;
  assertValid(r);
  return build(r);
}

export function configPaths(agentDir: string) {
  const base = join(agentDir, "pi-telegram-gateway");
  return {
    base,
    configFile: join(base, "config.json"),
    runtimeDir: join(base, "runtime"),
    lockFile: join(base, "runtime", "leader.json"),
    stateFile: join(base, "runtime", "state.json"),
    statusFile: join(base, "runtime", "status.json"),
    sessionsDir: join(agentDir, "gateway", "sessions"),
  };
}

export function loadConfigFrom(file: string): GatewayConfig | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return validateRaw(JSON.parse(raw));
  } catch (err) {
    throw new Error(`Invalid ${file}: ${(err as Error).message}`);
  }
}

export function loadConfig(agentDir: string): GatewayConfig | null {
  return loadConfigFrom(configPaths(agentDir).configFile);
}

export interface BotIdentity { id: number; username: string }

export async function enrichConfigWithBot(cfg: GatewayConfig, getMe: () => Promise<BotIdentity>): Promise<GatewayConfig> {
  const me = await getMe();
  return { ...cfg, botUsername: cfg.botUsername ?? me.username };
}