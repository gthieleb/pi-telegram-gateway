// src/lane-factory.ts
import {
  createAgentSession,
  getAgentDir,
  type ModelRuntime,
  type ToolDefinition,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LaneDeps } from "./lane.js";

export interface AskUserFn {
  (question: string, options: string[]): Promise<string>;
}

/**
 * Custom tool bridging agent questions into Telegram inline keyboards.
 * Only injected into lane-hosted sessions (see spec: tool call only when
 * the session is attached via Telegram).
 */
const AskUserParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Optional(
    Type.Array(Type.String(), { description: "Answer options shown as buttons (2-6 recommended)" }),
  ),
});

export function buildAskUserTool(onAskUser: AskUserFn): ToolDefinition<typeof AskUserParams> {
  return {
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user a question and wait for their answer. The question and optional answer options " +
      "are presented as Telegram buttons in the current topic. Use it for decisions, clarifications " +
      "and open points instead of ending the turn with an open question.",
    promptSnippet: "ask_user: present a question as Telegram buttons and wait for the user's choice",
    promptGuidelines: [
      "When you need a decision from the user, prefer the ask_user tool with concrete options over ending the turn with an open question.",
    ],
    parameters: AskUserParams,
    async execute(_toolCallId, params) {
      const answer = await onAskUser(params.question, params.options ?? []);
      return { content: [{ type: "text", text: `User answered: ${answer}` }], details: {} };
    },
  };
}

/** Builds LaneDeps backed by a real embedded pi session sharing the pi home. */
export function makeLaneDeps(opts: {
  cwd: string;
  agentDir?: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  onReply: (text: string) => Promise<void>;
  resumeSessionFile?: string;
  onAskUser?: AskUserFn;
  log?: (msg: string) => void;
}): LaneDeps {
  const agentDir = opts.agentDir ?? getAgentDir();
  return {
    async createSession() {
      const sessionManager = opts.resumeSessionFile
        ? SessionManager.open(opts.resumeSessionFile, opts.sessionDir, opts.cwd)
        : SessionManager.create(opts.cwd, opts.sessionDir);
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        agentDir,
        modelRuntime: opts.modelRuntime,
        sessionManager,
        customTools: opts.onAskUser ? [buildAskUserTool(opts.onAskUser)] : [],
      });
      return session as never;
    },
    onReply: opts.onReply,
    log: opts.log,
  };
}