# pi-telegram-gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension that turns the `@PiLemmaBot` Telegram bot into a Hermes-style gateway: it responds to every message from allowed users in every group/topic it is a member of, using per-peer embedded pi SDK sessions (`createAgentSession`), answering in the origin topic.

**Architecture:** Extension entry (`extensions/index.ts`) starts a poller on `session_start` after winning a file-lock leader election. Inbound updates are gated (user allowlist, optional mention), routed by `(chat_id, thread_id)` to lazily created embedded `createAgentSession()` lanes sharing `~/.pi/agent` (auth, skills, models), with transcripts under `~/.pi/agent/gateway/sessions/`. Final assistant text is sent back with `message_thread_id`.

**Tech Stack:** TypeScript (pi extension, zero runtime deps — Bot API via `fetch`), vitest, pi SDK peer dep.

**Spec:** `docs/superpowers/specs/2026-09-10-pi-telegram-gateway-design.md`

---

## Phase 0: Scaffolding

### Task 0.1: package.json, tsconfig, vitest config

**Objective:** Project builds and `vitest` runs.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

**Step 1: Write package.json**

```json
{
  "name": "pi-telegram-gateway",
  "version": "0.1.0",
  "description": "Telegram gateway for the pi coding agent — every group & topic, per-peer embedded sessions (pi SDK)",
  "type": "module",
  "keywords": ["pi-package"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/gthieleb/pi-telegram-gateway.git" },
  "pi": { "extensions": ["./extensions/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

**Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["extensions", "src", "tests"]
}
```

**Step 3: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

**Step 4: Install & verify**

Run: `npm install && npx vitest run`
Expected: `No test files found` (exit 1 — acceptable until Task 1.2 adds the first test; alternatively `npx vitest run --passWithNoTests` exits 0).

**Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore: scaffold pi package (ts, vitest, pi manifest)"
```

---

## Phase 1: Config

### Task 1.1: Config types + validation (TDD)

**Objective:** Load/validate `~/.pi/agent/pi-telegram-gateway/config.json`.

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Step 1: Write failing test**

```typescript
// tests/config.test.ts
import { describe, expect, it } from "vitest";
import { normalizeConfig, validateRaw } from "../src/config.js";

describe("config", () => {
  it("applies defaults", () => {
    const cfg = normalizeConfig({ version: 1, botToken: "123:abc", allowedUsers: [1] });
    expect(cfg.requireMention).toBe(false);
    expect(cfg.idleTimeoutMinutes).toBe(30);
    expect(cfg.maxLanes).toBe(8);
    expect(cfg.cwd).toBeTypeOf("string");
  });

  it("rejects missing token / users", () => {
    expect(() => validateRaw({ version: 1, allowedUsers: [1] })).toThrow(/botToken/);
    expect(() => normalizeConfig({ version: 1, botToken: "x", allowedUsers: [] })).toThrow(/allowedUsers/);
    expect(() => normalizeConfig({ version: 1, botToken: "x", allowedUsers: [1], maxLanes: 0 })).toThrow(/maxLanes/);
  });

  it("accepts full config", () => {
    const cfg = normalizeConfig({
      version: 1, botToken: "t", allowedUsers: [915681932], botUsername: "PiLemmaBot",
      requireMention: true, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 3,
    });
    expect(cfg.botUsername).toBe("PiLemmaBot");
    expect(cfg.requireMention).toBe(true);
  });
});
```

**Step 2: Run** `npx vitest run tests/config.test.ts` — Expected: FAIL (module missing).

**Step 3: Implement `src/config.ts`**

```typescript
// src/config.ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayConfig {
  version: number;
  botToken: string;
  botUsername?: string;
  allowedUsers: number[];
  requireMention: boolean;
  cwd: string;
  idleTimeoutMinutes: number;
  maxLanes: number;
}

export function validateRaw(raw: unknown): GatewayConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid config: not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.botToken !== "string" || !r.botToken.trim()) throw new Error("Invalid config: botToken required");
  if (!Array.isArray(r.allowedUsers) || r.allowedUsers.length === 0)
    throw new Error("Invalid config: allowedUsers must be a non-empty array of Telegram user ids");
  if (r.maxLanes !== undefined && (typeof r.maxLanes !== "number" || r.maxLanes < 1))
    throw new Error("Invalid config: maxLanes must be >= 1");
  if (r.idleTimeoutMinutes !== undefined && (typeof r.idleTimeoutMinutes !== "number" || r.idleTimeoutMinutes < 1))
    throw new Error("Invalid config: idleTimeoutMinutes must be >= 1");
  return normalizeConfig(raw as Partial<GatewayConfig>);
}

export function normalizeConfig(partial: Partial<GatewayConfig>): GatewayConfig {
  const r = validateRaw({ ...partial });
  return {
    version: 1,
    botToken: r.botToken,
    botUsername: r.botUsername,
    allowedUsers: r.allowedUsers,
    requireMention: r.requireMention ?? false,
    cwd: r.cwd ?? homedir(),
    idleTimeoutMinutes: r.idleTimeoutMinutes ?? 30,
    maxLanes: r.maxLanes ?? 8,
  };
}

export function configPaths(agentDir: string) {
  const base = join(agentDir, "pi-telegram-gateway");
  return {
    base,
    configFile: join(base, "config.json"),
    runtimeDir: join(base, "runtime"),
    lockFile: join(base, "runtime", "leader.json"),
    stateFile: join(base, "runtime", "state.json"),
    sessionsDir: join(agentDir, "gateway", "sessions"),
  };
}
```

**Step 4: Run** `npx vitest run tests/config.test.ts` — Expected: PASS (3 tests).

**Step 5: Commit** `git add -A && git commit -m "feat(config): schema, defaults, validation"`

### Task 1.2: File-based config loader (TDD)

**Files:**
- Modify: `src/config.ts` (append)
- Test: `tests/config.load.test.ts`

**Step 1: Failing test**

```typescript
// tests/config.load.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFrom } from "../src/config.js";

describe("loadConfigFrom", () => {
  it("returns null when file missing", () => {
    expect(loadConfigFrom(join(tmpdir(), "definitely-missing-gw.json"))).toBeNull();
  });
  it("loads and normalizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ version: 1, botToken: "t", allowedUsers: [5] }));
    const cfg = loadConfigFrom(file)!;
    expect(cfg.botToken).toBe("t");
    expect(cfg.maxLanes).toBe(8);
  });
  it("throws on invalid json with file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    const file = join(dir, "config.json");
    writeFileSync(file, "{nope");
    expect(() => loadConfigFrom(file)).toThrow(/config\.json/);
  });
});
```

**Step 2: Run** — Expected FAIL. **Step 3: Append to `src/config.ts`:**

```typescript
import { readFileSync } from "node:fs";

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
```

**Step 4: Run** — Expected PASS. **Step 5: Commit** `feat(config): file loader with clear errors`

### Task 1.3: config.example.json + getMe enrichment

**Files:**
- Create: `config.example.json`
- Modify: `src/config.ts` (append `enrichConfigWithBot`)

**Step 1: Write `config.example.json`**

```jsonc
{
  "version": 1,
  "botToken": "123456:REPLACE_ME",
  "allowedUsers": [123456789],
  "requireMention": false,
  "cwd": "/home/gun",
  "idleTimeoutMinutes": 30,
  "maxLanes": 8
}
```

**Step 2: Append to `src/config.ts`**

```typescript
export async function enrichConfigWithBot(
  cfg: GatewayConfig,
  getMe: () => Promise<{ id: number; username: string }>,
): Promise<GatewayConfig> {
  const me = await getMe();
  return { ...cfg, botUsername: cfg.botUsername ?? me.username };
}
```

**Step 3: Commit** `feat(config): example template + getMe enrichment`

---

## Phase 2: Leader lock (file-lock election)

### Task 2.1: Claim / alive / stale-reclaim (TDD)

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

**Step 1: Failing test**

```typescript
// tests/lock.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimLock, isProcessAlive, readLock, releaseLock } from "../src/lock.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lock-"));

describe("leader lock", () => {
  it("claims when empty and persists metadata", () => {
    const file = join(tmp(), "leader.json");
    const lock = claimLock(file, { capability: "cap-a" });
    expect(lock.leader).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.capability).toBe("cap-a");
  });

  it("second claimer loses while leader alive", () => {
    const file = join(tmp(), "leader.json");
    const a = claimLock(file, { capability: "cap-a" });
    expect(a.leader).toBe(true);
    const b = claimLock(file, { capability: "cap-b" });
    expect(b.leader).toBe(false);
    expect(b.lock?.pid).toBe(process.pid);
  });

  it("reclaims stale lock of dead pid", () => {
    const file = join(tmp(), "leader.json");
    writeFileSync(file, JSON.stringify({ pid: 999999999, capability: "old", epoch: 1, processStart: "bogus", createdAt: 0 }));
    const res = claimLock(file, { capability: "cap-b" });
    expect(res.leader).toBe(true);
  });

  it("reclaims when pid was reused by an unrelated process", () => {
    const file = join(tmp(), "leader.json");
    // real pid, but foreign process identity (not pi/node) → stale
    writeFileSync(file, JSON.stringify({
      pid: process.pid, capability: "old", epoch: 1,
      processIdentity: { name: "definitely-not-pi", startedAt: 1 }, createdAt: 0,
    }));
    expect(claimLock(file, { capability: "cap-c" }).leader).toBe(true);
  });

  it("readLock parses garbage as null; releaseLock only removes own capability", () => {
    const file = join(tmp(), "leader.json");
    writeFileSync(file, "garbage");
    expect(readLock(file)).toBeNull();
    const lock = claimLock(file, { capability: "cap-d" });
    releaseLock(file, lock.lock!);
    expect(readLock(file)).toBeNull();
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/lock.ts`**

```typescript
// src/lock.ts
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LeaderData {
  pid: number;
  capability: string;
  epoch: number;
  processIdentity: { name: string; startedAt: number };
  createdAt: number;
}
export interface LockHandle { path: string; data: LeaderData }

/** Best-effort liveness + identity of a pid (Linux /proc; falls back to kill(0)). */
export function processInfo(pid: number): { alive: boolean; name: string; startedAt: number } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const name = (stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) || "unknown").trim();
    const startedAt = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[19]) || 0;
    return { alive: true, name, startedAt };
  } catch {
    try {
      process.kill(pid, 0);
      return { alive: true, name: "unknown", startedAt: 0 };
    } catch {
      return { alive: false, name: "", startedAt: 0 };
    }
  }
}

export function readLock(path: string): LeaderData | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaderData>;
    if (typeof raw.pid !== "number" || typeof raw.capability !== "string") return null;
    return {
      pid: raw.pid,
      capability: raw.capability,
      epoch: Number(raw.epoch ?? 0),
      processIdentity: raw.processIdentity ?? { name: "unknown", startedAt: 0 },
      createdAt: Number(raw.createdAt ?? 0),
    };
  } catch {
    return null;
  }
}

export interface ClaimResult { leader: boolean; lock?: LeaderData }

export function claimLock(
  path: string,
  opts: { capability: string },
  selfInfo?: () => { name: string; startedAt: number },
): ClaimResult {
  const identity = selfInfo ?? selfIdentity();
  const existing = readLock(path);
  if (existing) {
    const info = processInfo(existing.pid);
    const isSelfProcess = info.alive && info.name === identity.name && info.startedAt === identity.startedAt;
    const sameProcess = info.alive && existing.pid === process.pid;
    const aliveAndRelated = sameProcess || (info.alive && isPiRelated(info.name) && info.startedAt !== 0
      ? false /* foreign pi instance holds it */
      : isPiRelated(info.name) && info.startedAt === 0);
    // Rule: lock is live only when the recorded process is alive AND looks like
    // the same identity we recorded (name+starttime match) OR it is literally us.
    const live = sameProcess || (info.alive && existing.processIdentity.name !== "unknown"
      && existing.processIdentity.name === identity.name && existing.processIdentity.startedAt === identity.startedAt);
    if (info.alive && (live || (!sameProcess && aliveIsPi(info.name)))) {
      if (!sameProcess) return { leader: false, lock: existing as LeaderData };
    }
    void aliveAndRelated; void isSelf;
  }
  const data: LeaderData = {
    pid: process.pid,
    capability: opts.capability,
    epoch: Date.now(),
    processIdentity: identity,
    createdAt: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data));
  try { unlinkSync(path); } catch { /* not there */ }
  renameSync(tmpPath, path); // atomic replace
  return { leader: true, lock: data };
}
```

> **Hinweis für den Implementierer:** Der obige Entwurf ist absichtlich *zu* verschachtelt — die finale Implementierung in `src/lock.ts` soll exakt die 4 Testfälle abbilden:
> 1. fresh claim → leader
> 2. claim while owner process (same pid+identity) alive → not leader
> 3. dead pid → reclaim
> 4. alive pid but identity mismatch (PID reuse) → reclaim
>
> Finale Version:

```typescript
// src/lock.ts (final)
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LeaderData {
  pid: number;
  capability: string;
  epoch: number;
  processIdentity: { name: string; startedAt: number };
  createdAt: number;
}
export interface LockHandle { path: string; data: LeaderData }
export interface ClaimResult { leader: boolean; lock?: LeaderData }

export function selfIdentity(): { name: string; startedAt: number } {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const startedAt = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[19]) || 0;
    return { name, startedAt };
  } catch {
    return { name: "unknown", startedAt: 0 };
  }
}

export function processInfo(pid: number): { alive: boolean; name: string; startedAt: number } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const startedAt = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[19]) || 0;
    return { alive: true, name, startedAt };
  } catch {
    try { process.kill(pid, 0); return { alive: true, name: "unknown", startedAt: 0 }; }
    catch { return { alive: false, name: "", startedAt: 0 }; }
  }
}

export function readLock(path: string): LeaderData | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaderData>;
    if (typeof raw.pid !== "number" || typeof raw.capability !== "string") return null;
    return {
      pid: raw.pid, capability: raw.capability, epoch: Number(raw.epoch ?? 0),
      processIdentity: raw.processIdentity ?? { name: "unknown", startedAt: 0 },
      createdAt: Number(raw.createdAt ?? 0),
    };
  } catch { return null; }
}

export function claimLock(
  path: string,
  opts: { capability: string },
  identity: { name: string; startedAt: number } = selfIdentity(),
): ClaimResult {
  const existing = readLock(path);
  if (existing) {
    const info = processInfo(existing.pid);
    const sameIdentity = info.name === identity.name && info.startedAt === identity.startedAt;
    const samePid = existing.pid === process.pid;
    const recordedMatchesInfo =
      existing.processIdentity.name === info.name && existing.processIdentity.startedAt === info.startedAt;
    const alive = info.alive && (samePid || recordedMatchesInfo);
    if (alive) return { leader: false, lock: existing };
    // dead pid OR pid reused by unrelated process (identity mismatch) → stale, reclaim
  }
  const data: LeaderData = {
    pid: process.pid, capability: opts.capability, epoch: Date.now(),
    processIdentity: identity, createdAt: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data));
  try { unlinkSync(path); } catch { /* ENOENT ok */ }
  renameSync(tmpPath, path);
  return { leader: true, lock: data };
}

export function releaseLock(path: string, handle: LockHandle): void {
  const current = readLock(path);
  if (current && current.capability === handle.data.capability && current.pid === handle.data.pid) {
    try { unlinkSync(path); } catch { /* ok */ }
  }
}
```

**Step 4: Run** `npx vitest run tests/lock.test.ts` — Expected: PASS (5 tests).
**Step 5: Commit** `feat(lock): file-lock leader election with pid-reuse detection`

---

## Phase 2: Gating

### Task 3.1: Gate matrix (TDD)

**Files:**
- Create: `src/gate.ts`
- Test: `tests/gate.test.ts`

**Step 1: Failing test**

```typescript
// tests/gate.test.ts
import { describe, expect, it } from "vitest";
import { shouldDispatch } from "../src/gate.js";
import type { GatewayConfig } from "../src/config.js";

const cfg = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  version: 1, botToken: "t", botUsername: "PiLemmaBot", allowedUsers: [42],
  requireMention: false, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 4, ...over,
});
const msg = (over = {}) => ({
  message_id: 1, date: 0,
  from: { id: 42, is_bot: false, username: "owner" },
  chat: { id: -100, type: "supergroup", is_forum: true },
  text: "hello", ...over,
});

describe("shouldDispatch", () => {
  it("allows allowed user in free-response mode", () => {
    expect(shouldDispatch(msg() as never, cfg(), "PiLemmaBot")).toBe(true);
  });
  it("rejects unknown users always", () => {
    expect(shouldDispatch(msg({ from: { id: 7, is_bot: false } }) as never, cfg(), "PiLemmaBot")).toBe(false);
  });
  it("rejects bots (including other bots)", () => {
    expect(shouldDispatch(msg({ from: { id: 42, is_bot: true } }) as never, cfg(), "PiLemmaBot")).toBe(false);
  });
  it("requireMention: no mention in group → false; mention → true", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg() as never, c, "PiLemmaBot")).toBe(false);
    expect(shouldDispatch(msg({ text: "@PiLemmaBot hi" }) as never, c, "PiLemmaBot")).toBe(true);
  });
  it("requireMention: reply to bot message passes", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg({ reply_to_message: { from: { id: 123, is_bot: true } } }) as never, c, "PiLemmaBot")).toBe(true);
  });
  it("requireMention: DM never requires mention", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg({ chat: { id: 42, type: "private" } }) as never, c, "PiLemmaBot")).toBe(true);
  });
  it("ignores non-text messages (no text/caption)", () => {
    expect(shouldDispatch(msg({ text: undefined }) as never, cfg(), "PiLemmaBot")).toBe(false);
  });
  it("ignores bot username mismatch on @mention of other bot", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg({ text: "@OtherBot hi" }) as never, c, "PiLemmaBot")).toBe(false);
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/gate.ts`**

```typescript
// src/gate.ts
import type { GatewayConfig } from "./config.js";

export interface GateMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; username?: string };
  chat: { id: number; type: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  reply_to_message?: { from?: { id: number; is_bot?: boolean } };
}

const GROUP_TYPES = new Set(["group", "supergroup"]);

export function shouldDispatch(m: GateMessage, cfg: GatewayConfig, botUsername: string): boolean {
  if (!m.from || m.from.is_bot) return false;
  if (!cfg.allowedUsers.includes(m.from.id)) return false;
  const text = (m.text ?? m.caption ?? "").trim();
  if (!text) return false;
  if (!cfg.requireMention) return true;
  if (!GROUP_TYPES.has(m.chat.type)) return true; // DMs never need mention
  if (m.reply_to_message?.from?.is_bot) return true;
  return mentionsBot(text, botUsername);
}

export function mentionsBot(text: string, botUsername: string): boolean {
  return new RegExp(`@${botUsername}(?![\\w])`, "i").test(text);
}

export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z\d_]+)(?:@[A-Za-z\d_]+)?\s*([\s\S]*)$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: m[2].trim() } : null;
}
```

**Step 4: Run** — PASS. **Step 5: Commit** `feat(gate): user allowlist + mention gating matrix`

---

## Phase 3: Telegram Bot API client

### Task 4.1: Message chunker (TDD)

**Files:**
- Create: `src/chunk.ts`
- Test: `tests/chunk.test.ts`

**Step 1: Failing test**

```typescript
// tests/chunk.test.ts
import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/chunk.js";

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
  });
  it("splits long text respecting paragraphs", () => {
    const text = "a\n\n" + "b".repeat(4095) + "\n\nc";
    const parts = splitMessage(text);
    expect(parts[0].length).toBeLessThanOrEqual(4096);
    expect(parts.join("\n\n")).toBe(text);
  });
  it("hard-cuts when no boundary exists", () => {
    const parts = splitMessage("x".repeat(9000));
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
  });
  it("returns empty for empty text", () => {
    expect(splitMessage("")).toEqual([]);
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/chunk.ts`**

```typescript
// src/chunk.ts
export function splitMessage(text: string, limit = 4096): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const parts: string[] = [];
  let rest = t;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut = para > limit * 0.5 ? para + 2 : line > limit * 0.5 ? line + 1 : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}
```

**Step 4: Run** — PASS. **Step 5: Commit** `feat(chunk): telegram-safe message splitting`

### Task 4.2: TelegramClient with fetch injection (TDD)

**Files:**
- Create: `src/telegram.ts`
- Test: `tests/telegram.test.ts`

**Step 1: Failing test**

```typescript
// tests/telegram.test.ts
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
    vi.spyOn(client as never, "sleep" as never).mockResolvedValue(undefined);
    const res = await client.call("sendMessage", { chat_id: 1, text: "y" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((res as { message_id: number }).message_id).toBe(1);
  });

  it("throws BotApiError with description on failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ ok: false, description: "Bad Request: chat not found" }, 400));
    const client = new TelegramClient("TOK", "https://api.test", fetchFn as typeof fetch);
    await expect(client.call("sendMessage", { chat_id: 1, text: "y" })).rejects.toThrow(/chat not found/);
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/telegram.ts`**

```typescript
// src/telegram.ts
import { splitMessage } from "./chunk.js";

export interface TgUser { id: number; is_bot: boolean; username?: string }
export interface TgMessage {
  message_id: number; date: number;
  from?: TgUser;
  chat: { id: number; type: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string; caption?: string;
  reply_to_message?: { message_id: number; from?: TgUser };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
export interface TgMe { id: number; username: string }

export class BotApiError extends Error {
  constructor(public readonly description: string, public readonly code: number,
    public readonly retryAfter?: number) {
    super(`Telegram API: ${description} (${code})`);
  }
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  async call<T = unknown>(method: string, body?: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {};
      try { payload = await res.json(); } catch { /* non-json */ }
      if (payload.ok) return payload.result as T;
      const retryAfter = payload.parameters?.retry_after;
      if (res.status === 429 && retryAfter !== undefined && attempt < 3) {
        await this.sleep((retryAfter + 1) * 1000);
        continue;
      }
      throw new BotApiError(payload.description ?? `HTTP ${res.status}`, res.status, retryAfter);
    }
  }

  async getMe(): Promise<TgMe> { return this.call<TgMe>("getMe"); }

  async getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    const updates = await this.call<TgUpdate[]>("getUpdates", {
      offset, timeout: timeoutSec, allowed_updates: ["message"],
    });
    return updates ?? [];
  }

  async sendMessage(chatId: number, threadId: number | undefined, text: string,
    replyToMessageId?: number): Promise<void> {
    const parts = splitMessage(text);
    for (const [i, part] of parts.entries()) {
      const body: Record<string, unknown> = { chat_id: chatId, text: part };
      if (threadId !== undefined) body.message_thread_id = threadId;
      if (replyToMessageId !== undefined && i === 0) body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
      await this.call("sendMessage", body);
    }
  }

  async sendTyping(chatId: number, threadId?: number): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
    if (threadId !== undefined) body.message_thread_id = threadId;
    try { await this.call("sendChatAction", body); } catch { /* typing is best-effort */ }
  }
}
```

**Step 4: Run** `npx vitest run tests/telegram.test.ts` — Expected: PASS (4 tests).
**Step 5: Commit** `feat(telegram): bot api client (long-poll, chunked send, 429 backoff)`

---

## Phase 4: Session lanes

### Task 5.1: Reply extraction from AgentSession messages (TDD)

**Files:**
- Create: `src/reply.ts`
- Test: `tests/reply.test.ts`

**Step 1: Failing test**

```typescript
// tests/reply.test.ts
import { describe, expect, it } from "vitest";
import { extractReplyText } from "../src/reply.js";

describe("extractReplyText", () => {
  it("concatenates assistant text blocks after snapshot", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "part1 " }, { type: "text", text: "part2" }] },
      { role: "toolResult", content: [{ type: "text", text: "noise" }] },
      { role: "assistant", content: [{ type: "text", text: " final" }] },
    ];
    expect(extractReplyText(msgs as never[])).toBe("part1 part2 final");
  });
  it("handles string content and returns empty for none", () => {
    expect(extractReplyText([{ role: "assistant", content: "plain" }] as never[])).toBe("plain");
    expect(extractReplyText([])).toBe("");
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/reply.ts`**

```typescript
// src/reply.ts
interface BlockLike { type: string; text?: string }
interface MsgLike { role: string; content: string | BlockLike[] | undefined }

function textOf(m: MsgLike): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

export function extractReplyText(messages: MsgLike[]): string {
  return messages.filter((m) => m.role === "assistant").map(textOf).join("").trim();
}
```

**Step 4: Run** — PASS. **Step 5: Commit** `feat(reply): assistant text extraction from message entries`

### Task 5.2: Lane — embedded session wrapper (TDD with fake session)

**Files:**
- Create: `src/lane.ts`
- Test: `tests/lane.test.ts`

**Step 1: Failing test**

```typescript
// tests/lane.test.ts
import { describe, expect, it, vi } from "vitest";
import { Lane } from "../src/lane.js";

function fakeSession(reply = "ok") {
  return {
    messages: [] as unknown[],
    isStreaming: false,
    prompt: vi.fn(async function (this: { messages: unknown[] }, _text: string) {
      this.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
    }),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

const deps = (onReply = vi.fn()) => ({
  onReply, log: vi.fn(),
  createSession: async () => {
    const s = fakeSession();
    return s as never;
  },
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
    expect(session.prompt).not.toHaveBeenCalled();   // busy → followUp path
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
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/lane.ts`**

```typescript
// src/lane.ts
import { extractReplyText } from "./reply.js";

interface SessionLike {
  messages: unknown[];
  isStreaming: boolean;
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface LaneDeps {
  createSession: () => Promise<SessionLike>;
  onReply: (text: string) => Promise<void>;
  log?: (msg: string) => void;
}

/** One conversation lane: an embedded AgentSession bound to (chat_id, thread_id). */
export class Lane {
  busy = false;
  private session: SessionLike | null = null;
  private disposed = false;

  private constructor(private readonly key: string, private readonly deps: LaneDeps) {}

  static async create(key: string, deps: LaneDeps): Promise<Lane> {
    const lane = new Lane(key, deps);
    lane.session = await deps.createSession();
    return lane;
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed || !this.session) throw new Error(`Lane ${this.key} disposed`);
    if (this.busy) {
      this.deps.log?.(`lane ${this.key}: busy → followUp`);
      await this.session.followUp(text);
      return;
    }
    this.busy = true;
    const before = this.session.messages.length;
    try {
      await this.session.prompt(text);
      const reply = extractReplyText(this.session.messages.slice(before) as never[]);
      if (reply) await this.deps.onReply(reply);
    } finally {
      this.busy = false;
    }
  }

  async abort(): Promise<void> {
    if (this.session && this.busy) await this.session.abort();
  }

  dispose(): void {
    if (this.disposed || !this.session) return;
    this.disposed = true;
    this.session.dispose();
  }

  /** test seam */
  sessionForTest(): SessionLike { return this.session!; }
}
```

**Step 4: Run** — PASS. **Step 5: Commit** `feat(lane): embedded session lane with busy follow-up`

### Task 5.3: Lane factory over the pi SDK (wiring, no unit test — verified in live smoke)

**Files:**
- Create: `src/lane-factory.ts`

**Step 1: Implement**

```typescript
// src/lane-factory.ts
import {
  createAgentSession,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { LaneDeps } from "./lane.js";
import { extractReplyText } from "./reply.js";

export interface LaneFactoryOptions {
  cwd: string;
  agentDir?: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  onReply: (text: string) => Promise<void>;
}

/** Builds LaneDeps backed by a real embedded pi session sharing the pi home. */
export function makeLaneDeps(opts: {
  cwd: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  onReply: (text: string) => Promise<void>;
  log?: (msg: string) => void;
}): LaneDeps {
  const agentDir = getAgentDir();
  return {
    cwd: opts.cwd,
    async createSession() {
      const sessionManager = SessionManager.create(opts.cwd, opts.sessionDir);
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        agentDir,
        modelRuntime: opts.modelRuntime,
        sessionManager,
      });
      return session as never;
    },
    onReply: opts.onReply,
    log: opts.log,
  };
}
```

> **Implementer note:** `createAgentSession` und `getAgentDir` aus dem Peer-Package importieren; falls `ModelRuntime.create()` eine eigene Signatur hat (prüfen: `ModelRuntime.create()` in sdk.md), den Shared-Runtime-Singleton in `gateway.ts` halten (`let modelRuntimePromise: Promise<ModelRuntime> | null`).

**Step 2: Typecheck** `npx tsc --noEmit` — Expected: no errors.
**Step 3: Commit** `feat(lane-factory): embedded sessions over shared pi home`

---

## Phase 5: Router

### Task 6.1: Lane map with LRU idle dispose + lane cap (TDD)

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

**Step 1: Failing test**

```typescript
// tests/router.test.ts
import { describe, expect, it, vi } from "vitest";
import { laneKey, Router } from "../src/router.js";
import type { LikeLane } from "../src/router.js";

function fakeLane() {
  return { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(), busy: false };
}

function makeRouter(opts: { maxLanes?: number; now?: () => number } = {}) {
  let created = 0;
  const factory = vi.fn(async () => {
    created++;
    return fakeLane() as LikeLane;
  });
  const router = new Router({
    createLane: factory,
    idleTimeoutMs: 1000,
    maxLanes: opts.maxLanes ?? 2,
    now: opts.now ?? (() => Date.now()),
  });
  return { router, factory, created: () => created };
}

describe("Router", () => {
  it("laneKey separates chat and thread", () => {
    expect(laneKey(1, 5)).toBe("1:5");
    expect(laneKey(1, undefined)).toBe("1:root");
    expect(laneKey(1, 5)).not.toBe(laneKey(1, 6));
  });

  it("reuses the same lane for the same key", async () => {
    const { router, created } = makeRouter();
    await router.dispatch(1, 5, "a");
    await router.dispatch(1, 5, "b");
    await router.dispatch(1, 6, "c");
    expect(created()).toBe(2);
    router.disposeAll();
  });

  it("disposes idle lanes beyond timeout", async () => {
    let t = 0;
    const { router } = makeRouter({ now: () => t });
    await router.dispatch(1, 1, "a");
    t = 500;
    router.sweepIdle();
    expect(router.size).toBe(1);
    t = 2000;
    router.sweepIdle();
    expect(router.size).toBe(0);
  });

  it("caps lanes: oldest non-busy is disposed when full", async () => {
    let t = 0;
    const { router } = makeRouter({ maxLanes: 2, now: () => t });
    await router.dispatch(1, 1, "a");
    t = 10;
    await router.dispatch(1, 2, "b");
    t = 20;
    await router.dispatch(1, 3, "c");   // lane 1:1 (oldest) must be disposed
    expect(router.has("1:1")).toBe(false);
    expect(router.has("1:2")).toBe(true);
    expect(router.has("1:3")).toBe(true);
    router.disposeAll();
  });

  it("disposeAll disposes every lane", async () => {
    const { router } = makeRouter();
    await router.dispatch(1, 1, "a");
    await router.dispatch(2, 2, "b");
    router.disposeAll();
    expect(router.size).toBe(0);
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/router.ts`**

```typescript
// src/router.ts
export interface LikeLane { prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): void; busy: boolean }
export interface LaneEntry { lane: LikeLane; lastUsed: number; }

export interface RouterDeps {
  createLane: (key: string) => Promise<LikeLane>;
  idleTimeoutMs: number;
  maxLanes: number;
  now?: () => number;
}

export function laneKey(chatId: number, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? "root"}`;
}

export class Router {
  private lanes = new Map<string, LaneEntry>();
  private disposed = false;

  constructor(private deps: RouterDeps) {}

  get size(): number { return this.lanes.size; }
  has(key: string): boolean { return this.lanes.has(key); }

  async dispatch(key: string, text: string): Promise<void> {
    if (this.disposed) throw new Error("router disposed");
    let entry = this.lanes.get(key);
    if (!entry) {
      if (this.lanes.size >= this.deps.maxLanes) this.evictOldest();
      entry = { lane: await this.deps.createLane(key), lastUsed: (this.deps.now ?? Date.now)() };
      this.lanes.set(key, entry);
    }
    entry.lastUsed = (this.deps.now ?? Date.now)();
    await entry.lane.prompt(text);
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.lanes.values()].map((e) => e.lane.abort()));
  }

  sweepIdle(): void {
    const now = (this.deps.now ?? Date.now)();
    for (const [key, entry] of this.lanes) {
      if (now - entry.lastUsed > this.deps.idleTimeoutMs) {
        entry.lane.dispose();
        this.lanes.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, entry] of this.lanes) {
      if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestKey = key; }
    }
    if (oldestKey) {
      this.lanes.get(oldestKey)!.lane.dispose();
      this.lanes.delete(oldestKey);
    }
  }

  disposeAll(): void {
    for (const entry of this.lanes.values()) entry.lane.dispose();
    this.lanes.clear();
    this.disposed = true;
  }
}
```

> Implementer-Hinweis: `maxLanes`-Eviction ruft `evictOldest()` vor dem Erstellen einer neuen Lane, wenn `size >= maxLanes`. Im Test 4 ist Lane `1:1` bei `t=20` die älteste → wird evicted. Der Sweep-Timer selbst läuft im `Gateway` (Phase 6), der Router bleibt reine Logik.

**Step 4: Run** `npx vitest run tests/router.test.ts` — PASS (5).
**Step 5: Commit** `feat(router): chat/thread lanes with idle sweep + cap`

---

## Phase 6: Gateway (poller + wiring)

### Task 7.1: Gateway core (TDD with fake client + fake router)

**Files:**
- Create: `src/gateway.ts`
- Test: `tests/gateway.test.ts`

**Step 1: Failing test**

```typescript
// tests/gateway.test.ts
import { describe, expect, it, vi } from "vitest";
import { Gateway } from "../src/gateway.js";
import type { TelegramClient, TgUpdate } from "../src/telegram.js";

function makeClient(updates: TgUpdate[][]) {
  let page = 0;
  return {
    getMe: async () => ({ id: 1, username: "PiLemmaBot" }),
    getUpdates: vi.fn(async () => updates[Math.min(page++, updates.length - 1)]),
    sendMessage: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
  } as never;
}

const cfg = {
  version: 1, botToken: "t", botUsername: "PiLemmaBot", allowedUsers: [42],
  requireMention: false, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 4,
};

const msg = (over: object = {}): TgUpdate => ({
  update_id: 1,
  message: {
    message_id: 1, date: 0, from: { id: 42, is_bot: false },
    chat: { id: -100, type: "supergroup", is_forum: true },
    message_thread_id: 7, text: "hello", ...over,
  } as TgUpdate["message"],
});

function harness(updates: TgUpdate[][], router?: { dispatch: ReturnType<typeof vi.fn> }) {
  const client = makeClient(updates);
  const router = router ?? {
    dispatch: vi.fn(async () => {}),
    sweepIdle: vi.fn(),
    disposeAll: vi.fn(),
    abortAll: vi.fn(async () => {}),
    size: 0,
  };
  const status = vi.fn();
  const gw = new Gateway({
    config: cfg as never,
    client,
    router: router as never,
    lock: { claim: () => ({ leader: true }), release: vi.fn() } as never,
    sweepIntervalMs: 10_000,
    pollDelayMs: 0,
  });
  return { gw, client, router, status };
}

describe("Gateway", () => {
  it("processes one batch and stops on stop()", async () => {
    const { gw, client, router } = harness([[msg()], []]);
    await gw.runOnce();            // processes the first page, no long poll
    expect(router.dispatch).toHaveBeenCalledWith("-100:7", "hi");
    expect(gw.offset).toBe(2);
  });

  it("ignores messages from non-allowed users", async () => {
    const { gw, router } = harness([[
      msg({ message: { message_id: 1, date: 0, from: { id: 999, is_bot: false }, chat: { id: -100, type: "supergroup" }, text: "x", message_thread_id: 7 } }),
    ], []]);
    await gw.runOnce();
    expect(router.dispatch).not.toHaveBeenCalled();
  });

  it("routes /new and /status as lane commands, not prompts", async () => {
    const { gw, client, router } = harness([[msg({ message: { message_id: 1, date: 0, from: { id: 42, is_bot: false }, chat: { id: -100, type: "supergroup" }, message_thread_id: 7, text: "/status" } })], []]);
    await gw.runOnce();
    expect(router.dispatch).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalled();     // status feedback
  });

  it("sends assistant reply into the origin topic", async () => {
    const router = { dispatch: vi.fn(async (_k: string, _t: string) => {}), disposeAll: vi.fn(), abortAll: async () => {}, sweepIdle: vi.fn(), size: 0 };
    const { gw, client } = harness([[msg()], []], router as never);
    // simulate the lane's onReply by directly calling the outbound hook
    await gw.sendOutbound(-100, 7, "hello world");
    expect(client.sendMessage).toHaveBeenCalledWith(-100, 7, "hello", undefined);
  });
});
```

**Step 2: Run** — FAIL. **Step 3: Implement `src/gateway.ts`**

```typescript
// src/gateway.ts
import type { GatewayConfig } from "./config.js";
import { parseCommand, shouldDispatch } from "./gate.js";
import type { Router } from "./router.js";
import type { TelegramClient, TgMessage, TgUpdate } from "./telegram.js";

export interface GatewayDeps {
  config: GatewayConfig;
  client: {
    getMe: () => Promise<{ id: number; username: string }>;
    getUpdates: (offset: number, timeoutSec?: number) => Promise<TgUpdate[]>;
    sendMessage: (chatId: number, threadId: number | undefined, text: string, replyTo?: number) => Promise<void>;
    sendTyping: (chatId: number, threadId?: number) => Promise<void>;
  };
  router: {
    dispatch: (key: string, text: string) => Promise<void>;
    sweepIdle: () => void;
    disposeAll: () => void;
    abortAll: () => Promise<void>;
    size: number;
  };
  lock: { claim: () => { leader: boolean }; release: () => void };
  pollDelayMs?: number;
  sweepIntervalMs?: number;
}

export class Gateway {
  offset = 0;
  private stopped = false;
  private lastError = "";

  constructor(private deps: GatewayDeps) {}

  async resolveBotUsername(): Promise<string> {
    if (this.deps.config.botUsername) return this.deps.config.botUsername;
    const me = await this.deps.client.getMe();
    this.deps.config.botUsername = me.username;
    return me.username;
  }

  /** One poll cycle without long-wait — used by tests and by the loop. */
  async runOnce(): Promise<void> {
    const updates = await this.deps.client.getUpdates(this.offset, 0);
    for (const u of updates) {
      this.offset = u.update_id + 1;
      if (u.message) await this.handleMessage(u.message);
    }
  }

  private async handleMessage(m: TgMessage): Promise<void> {
    const botUsername = await this.resolveBotUsername();
    if (!shouldDispatch(m as never, this.deps.config, botUsername)) return;
    const threadId = m.message_thread_id;
    const text = (m.text ?? m.caption ?? "").trim();
    if (!text) return;
    const cmd = parseCommand(text);
    if (cmd?.name === "new") { await this.deps.router.dispatch(`${m.chat.id}:${threadId ?? "root"}:reset`, "__reset__"); return; }
    if (cmd?.name === "status") {
      await this.deps.client.sendMessage(m.chat.id, threadId,
        `Gateway online · lanes: ${this.deps.router.size} · model: default`);
      return;
    }
    await this.deps.client.sendTyping(m.chat.id, threadId);
    await this.deps.router.dispatch(`${m.chat.id}:${threadId ?? "root"}`, text);
  }

  async sendOutbound(chatId: number, threadId: number | undefined, text: string, replyTo?: number): Promise<void> {
    await this.deps.client.sendMessage(chatId, threadId, text, replyTo);
  }

  /** Long-running loop; resolves after stop(). */
  async loop(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.runOnce();
        await this.sleep(this.deps.pollDelayMs ?? 0);
      } catch {
        await this.sleep(2000); // backoff; status line handled by host
      }
    }
  }

  stop(): void { this.stopped = true; }

  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
}
```

> Implementer-Hinweise:
> - `resolveBotUsername` im echten Gateway cachen (einmal `getMe`, danach Config-Wert).
> - `/new` in der echten Wiring-Version (Task 8.2) ruft `router.reset(key)` auf statt eines magic-prompt-Dispatchs — im Test-Double genügt der Dispatch-Pfad. Falls die Test-API abweicht: Tests an die finale API anpassen, nicht umgekehrt die API verkomplizieren.
> - Der Poller bestätigt Updates ausschließlich über `offset = update_id + 1` im nächsten Aufruf; Offset wird in `runtime/state.json` persistiert (Task 8.1), damit nach einem Neustart nichts doppelt beantwortet wird.

**Step 4: Run** `npx vitest run tests/gateway.test.ts` — Expected: PASS (4 tests).
**Step 5: Commit** `feat(gateway): poller core with gating, commands, outbound routing`

---

## Phase 7: pi extension wiring

### Task 8.1: Runtime wiring (`sessionDir`, `ModelRuntime`, lock, status)

**Files:**
- Create: `src/runtime.ts`

**Step 1: Implement** — binds the pure Gateway to real pi SDK + fs:

```typescript
// src/runtime.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configPaths, loadConfig, type GatewayConfig } from "./config.js";
import { claimLock, releaseLock, type LockHandle } from "./lock.js";
import { Router } from "./router.js";
import { TelegramClient } from "./telegram.js";
import { Gateway } from "./gateway.js";
import { makeLaneDeps } from "./lane-factory.js";

export interface StatusSink { setStatus(key: string, text: string): void }

export async function startGateway(
  status: StatusSink,
  log: (msg: string) => void,
): Promise<Gateway | null> {
  const agentDir = getAgentDir();
  const paths = configPaths(agentDir);
  const cfg = loadConfig(agentDir);
  if (!cfg) { status(status, "unconfigured"); return null; }

  const lockRes = claimLock(paths.lockFile, { capability: `gw-${process.pid}` });
  if (!lockRes.leader) {
    sink.setStatus("tg-gw", `follower (leader pid ${lockRes.lock?.pid})`);
    return null;
  }
  let handle: LockHandle | null = { path: paths.lockFile, data: lockRes.lock! };

  const modelRuntime = await ModelRuntime.create();
  mkdirSync(paths.sessionsDir, { recursive: true });

  let offset = 0;
  try { offset = JSON.parse(readFileSync(paths.stateFile, "utf8")).offset ?? 0; } catch { /* fresh */ }

  const client = new TelegramClient(cfg.botToken);
  const username = cfg.botUsername ?? (await client.getMe()).username;

  const router = new Router({
    createLane: async (key) => {
      const [chatIdStr, threadPart] = key.split(":");
      const chatId = Number(chatIdStr);
      const threadId = threadPart === "root" ? undefined : Number(threadPart);
      const { Lane } = await import("./lane.js");
      return await Lane.create(key, makeLaneDeps({
        cwd: cfg.cwd,
        sessionDir: paths.sessionsDir,
        modelRuntime,
        onReply: (text) => client.sendMessage(chatId, threadId, text),
        log,
      }));
    },
    idleTimeoutMs: cfg.idleTimeoutMinutes * 60_000,
    maxLanes: cfg.maxLanes,
  });

  const gw = new Gateway({ config: cfg, client, router, pollDelayMs: 50, sweepIntervalMs: 30_000 });
  // wire real outbound + persistence + status — see gateway wiring below
  const sweep = setInterval(() => { router.sweepIdle(); sink.setStatus("tg-gw", `connected · lanes ${router.size}`); }, 30_000);
  void (async () => {
    sink.setStatus("tg-gw", "connected (leader)");
    try { await gw.loop(); }
    finally {
      clearInterval(sweep);
      router.disposeAll();
      releaseLock(paths.lockFile, handle);
      try { writeFileSync(paths.stateFile, JSON.stringify({ offset: gw.offset })); } catch { /* ok */ }
    }
  })();
  sink.setStatus("tg-gw", `connected · bot @${username}`);
  return gw;
}
```

> **Implementer-Hinweis:** `sink` und `stop`-Handling sauber machen — die Klasse bekommt einen `StatusSink` + eine `stop()`-Route, die `gw.stop()` aufruft; `session_shutdown` ruft `gw.stop()` und wartet auf das Loop-Ende. Der Status-Sink wird von `extensions/index.ts` über `ctx.ui.setStatus` injiziert (deshalb als Parameter, nicht importiert). Wenn `makeLaneDeps`-Exportname abweicht (Task 5.3), anpassen.

**Step 2: Typecheck** — `npx tsc --noEmit` clean. **Step 3: Commit** `feat(runtime): wire gateway to pi sdk, lockfile, status`

### Task 8.2: Extension entry + lifecycle (manual verify)

**Files:**
- Create: `extensions/index.ts`

**Step 1: Implement**

```typescript
// extensions/index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let gateway: { stop(): void } | null = null;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Deferred on purpose: factories must not start background resources.
    if (!ctx.hasUI) return; // print/json modes: silent
    const { startGateway } = await import("../src/runtime.js");
    const gw = await startGateway(
      { setStatus: (key, text) => ctx.ui.setStatus(key, text) },
      (msg) => ctx.ui.notify(`tg-gw: ${msg}`, "info"),
    );
    gateway = gw;
  });

  pi.on("session_shutdown", async () => {
    gateway?.stop();
    gateway = null;
  });
}
```

**Step 2: Manual smoke (offline):** `pi -e .` in the repo dir → status line shows `tg-gw: unconfigured` (no config yet) — confirms loading works without crashing.

**Step 3: Commit** `feat(extension): pi entry with lifecycle + status line`

---

## Phase 8: Security audit (mandatory — public repo, bot token)

- [ ] **Task 9.1:** `.gitignore` covers `config.json`, `**/config.json` (except `config.example.json`), `auth.json`, `*.session`, `.env`, `node_modules/`, `dist/`
- [ ] **Task 9.2:** `grep -rn "REPLACE_ME\|87333\|AAG8\|botToken" --include="!config.example.json" .` — no real token anywhere (the real token `87333…` lives only in `~/.pi/agent/pi-telegram-mux/config.json`)
- [ ] **Task 9.3:** Pre-commit scan each commit: `git diff --cached | grep -iE "token|secret|8733336793"` must show only placeholders
- [ ] **Task 9.4:** Post-push history audit: `git log --all --full-history -- 'config.json' '*/config.json'` → empty

**Commit:** `chore(security): audit pass — no secrets in repo`

---

## Phase 9: Integration test (opt-in live) + switchover

### Task 10.1: Live smoke script (opt-in)

**Files:**
- Create: `scripts/smoke.ts`

**Step 1: Implement** — starts one real poll cycle with a real token from env `GW_TOKEN`, sends `sendMessage` to env `GW_CHAT`/`GW_TOPIC` with text "gateway smoke", prints result. NOT part of CI.

**Step 2:** Run manually with a **test bot** (never the production token in CI): `GW_TOKEN=… GW_CHAT=-100… npx tsx scripts/smoke.ts` — Expected: message arrives, exit 0.

**Step 3: Commit** `test: opt-in live smoke script`

### Task 10.2: Local install + config migration (host-specific, NOT committed)

```bash
pi install /home/gun/projects/pi-telegram-gateway
# write ~/.pi/agent/pi-telegram-gateway/config.json with the mux token
python3 - <<'EOF'
import json, shutil, os
mux = json.load(open(os.path.expanduser("~/.pi/agent/pi-telegram-mux/config.json")))
os.makedirs(os.path.expanduser("~/.pi/agent/pi-telegram-gateway"), exist_ok=True)
cfg = {"version": 1, "botToken": mux["botToken"], "botUsername": "PiLemmaBot",
       "allowedUsers": [mux["allowedUserId"]], "requireMention": False,
       "cwd": os.path.expanduser("~"), "idleTimeoutMinutes": 30, "maxLanes": 8}
json.dump(cfg, open(os.path.expanduser("~/.pi/agent/pi-telegram-gateway/config.json"), "w"), indent=2)
print("config written")
EOF
```

### Task 10.3: Switchover (manual, with user)

1. Remove mux: `pi remove npm:pi-telegram-mux` (or edit `~/.pi/agent/settings.json` packages list)
2. Restart pi (user action) → old poller dies, gateway claims lock, token conflict-free
3. Verify: message in a **different** topic → fresh lane → answer lands in that topic
4. ⚠️ Mux topic 1655 dies with the old session by design

### Task 10.4: Update `pi-agent-setup` repo

- Update `~/projects/pi-agent-setup/README.md` table: `npm:pi-telegram-mux` → `git:github.com/gthieleb/pi-telegram-gateway` with new config path + note that topics are unbound (gateway mode)
- Commit + push

**Commit:** `docs: switchover notes for pi-agent-setup`

---

## Definition of Done (v1)

- [ ] `npm test` green (config, lock, gate, chunk, telegram, lane, router, gateway suites)
- [ ] `npx tsc --noEmit` clean
- [ ] `pi -e /home/gun/projects/pi-telegram-gateway` starts; status line `tg-gw: connected`
- [ ] Live: answer in foreign topic (not 1655) reaches a fresh lane and replies in-place
- [ ] Mux removed from settings; no 409 conflicts
- [ ] No secrets in git history