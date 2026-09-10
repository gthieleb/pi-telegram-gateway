// src/callbacks.ts
/**
 * In-memory registry for Telegram inline-keyboard menus.
 * Telegram limits callback_data to 64 bytes, so menus get short ids here and
 * the real payload (file paths, pending resolvers, …) lives in this registry.
 * Entries are single-use and expire after a TTL (default 5 min).
 */
export interface RegistryOptions {
  now?: () => number;
  ttlMs?: number;
  idLength?: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class CallbackRegistry<T = unknown> {
  private entries = new Map<string, Entry<T>>();

  constructor(private opts: RegistryOptions = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  register(value: T, ttlMs?: number): string {
    const id = newMenuId();
    const ttl = this.opts.ttlMs ?? ttlMs ?? 300_000;
    this.entries.set(id, { value, expiresAt: this.now() + ttl });
    return id;
  }

  /** Store under a deterministic key (e.g. `att:<id>`); overwrites existing. */
  registerAt(key: string, value: T, ttlMs?: number): void {
    const ttl = this.opts.ttlMs ?? ttlMs ?? 300_000;
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
  }

  peekAt(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt < this.now()) return undefined;
    return entry.value;
  }

  resolve(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id); // single use
    if (entry.expiresAt < this.now()) return undefined;
    return entry.value;
  }

  peek(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt < this.now()) return undefined;
    return entry.value;
  }

  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(id);
    }
  }
}

/** 6-hex-char menu id (fits Telegram's 64-byte callback_data limit comfortably). */
export function newMenuId(): string {
  return Math.random().toString(16).slice(2, 8);
}