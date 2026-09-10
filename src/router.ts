// src/router.ts
export interface LikeLane {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  busy: boolean;
  /** Transcripts file of the underlying session (for persistent bindings). */
  sessionFile?(): string | undefined;
}
export interface LaneEntry {
  lane: LikeLane;
  lastUsed: number;
}

export interface RouterDeps {
  createLane: (key: string, resumeSessionFile?: string) => Promise<LikeLane>;
  idleTimeoutMs: number;
  maxLanes: number;
  now?: () => number;
  /** Persistent topic→session bindings (survive restarts/idle disposal). */
  loadBinding?: (key: string) => string | undefined;
  saveBinding?: (key: string, sessionFile: string) => void;
  clearBinding?: (key: string) => void;
}

export function laneKey(chatId: number, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? "root"}`;
}

export class Router {
  private lanes = new Map<string, LaneEntry>();
  private disposed = false;

  constructor(private deps: RouterDeps) {}

  get size(): number {
    return this.lanes.size;
  }
  has(key: string): boolean {
    return this.lanes.has(key);
  }

  /** test seam */
  laneForTest(key: string): LikeLane | undefined {
    return this.lanes.get(key)?.lane;
  }

  async dispatch(key: string, text: string): Promise<void> {
    if (this.disposed) throw new Error("router disposed");
    let entry = this.lanes.get(key);
    if (!entry) {
      if (this.lanes.size >= this.deps.maxLanes) this.evictOldest();
      const resumeSessionFile = this.deps.loadBinding?.(key);
      entry = { lane: await this.deps.createLane(key, resumeSessionFile), lastUsed: (this.deps.now ?? Date.now)() };
      this.lanes.set(key, entry);
    }
    entry.lastUsed = (this.deps.now ?? Date.now)();
    await entry.lane.prompt(text);
    const file = entry.lane.sessionFile?.();
    if (file) this.deps.saveBinding?.(key, file);
  }

  abortAll(): Promise<unknown> {
    return Promise.all([...this.lanes.values()].map((e) => e.lane.abort()));
  }

  /** Reset a lane: dispose + drop + clear binding; next dispatch starts fresh. */
  reset(key: string): void {
    const entry = this.lanes.get(key);
    if (entry) {
      entry.lane.dispose();
      this.lanes.delete(key);
    }
    this.deps.clearBinding?.(key);
  }

  /** Attach a session file to a lane: dispose old, set binding, eager-resume. */
  async attachSession(key: string, sessionFile: string): Promise<void> {
    const entry = this.lanes.get(key);
    if (entry) {
      entry.lane.dispose();
      this.lanes.delete(key);
    }
    this.deps.clearBinding?.(key);
    this.deps.saveBinding?.(key, sessionFile);
    const lane = await this.deps.createLane(key, sessionFile);
    this.lanes.set(key, { lane, lastUsed: (this.deps.now ?? Date.now)() });
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
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
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