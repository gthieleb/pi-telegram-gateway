#!/usr/bin/env node
// cli.ts — daemon host for pi-telegram-gateway
// Usage: node cli.js [--config <path>]
import { writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { configPaths, loadConfig } from "./src/config.js";
import { startGateway, type StartedGateway } from "./src/runtime.js";

function parseArgs(argv: string[]): { config?: string } {
  const args: { config?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") args.config = argv[i + 1];
  }
  return args;
}

async function main(): Promise<void> {
  const agentDir = getAgentDir();
  const paths = configPaths(agentDir);
  const cfg = loadConfig(agentDir);
  if (!cfg) {
    console.error(
      `No config found at ${paths.configFile}. Copy config.example.json and fill in your bot token.`,
    );
    process.exit(78); // EX_CONFIG
  }

  let started: StartedGateway | null = null;
  const sink = { setStatus: (_key: string, text: string) => console.log(`[status] ${text}`) };
  const gw = await startGateway(
    sink,
    (msg) => console.log(`[gateway] ${msg}`),
    "daemon",
  );
  if (!gw) {
    console.error("[gateway] not started (unconfigured or another host is leader)");
    process.exit(0);
  }
  started = { gateway: gw, release: () => {} };

  const shutdown = (signal: string) => {
    console.log(`[gateway] ${signal} received, shutting down`);
    started.gateway.stop();
    writeFileSync(paths.stateFile, JSON.stringify({ offset: started.gateway.offset }));
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});