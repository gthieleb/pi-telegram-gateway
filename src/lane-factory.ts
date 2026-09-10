// src/lane-factory.ts
import {
  createAgentSession,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { LaneDeps } from "./lane.js";

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
  agentDir?: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  onReply: (text: string) => Promise<void>;
  log?: (msg: string) => void;
}): LaneDeps {
  const agentDir = opts.agentDir ?? getAgentDir();
  return {
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