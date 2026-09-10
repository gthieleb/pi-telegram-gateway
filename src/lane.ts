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
    if (this.busy || this.session.isStreaming) {
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
  sessionForTest(): SessionLike {
    return this.session!;
  }
}