// src/router.ts
export interface LikeLane {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  busy: boolean;
}
export interface LaneEntry {
  lane: LikeLane;
  lastUsed: number;
}

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
      entry = { lane: await this.deps.createLane(key), lastUsed: (this.deps.now ?? Date.now)() };
      this.lanes.set(key, entry);
    }
    entry.lastUsed = (this.deps.now ?? Date.now)();
    await entry.lane.prompt(text);
  }

  abortAll(): Promise<unknown> {
    return Promise.all([...this.lanes.values()].map((e) => e.lane.abort()));
  }

  /** Reset a lane: dispose + drop; next dispatch re-creates fresh. */
  reset(key: string): void {
    const entry = this.lanes.get(key);
    if (entry) {
      entry.lane.dispose();
      this.lanes.delete(key);
    }
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