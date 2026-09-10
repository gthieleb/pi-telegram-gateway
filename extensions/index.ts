// extensions/index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let gateway: { stop(): void } | null = null;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Deferred on purpose: factories must not start background resources.
    if (!ctx.hasUI) return; // print/json modes: silent
    const { configPaths, loadConfig } = await import("../src/config.js");
    const { startGateway, readRuntimeStatus } = await import("../src/runtime.js");
    const paths = configPaths(getAgentDir());
    const cfg = loadConfig(getAgentDir());

    // daemon mode: never claim; pure status client
    if (cfg?.mode === "daemon") {
      const status = readRuntimeStatus(paths.statusFile);
      ctx.ui.setStatus(
        "tg-gw",
        status ? `daemon (pid ${status.pid}, lanes ${status.lanes})` : "daemon not running",
      );
      return;
    }

    const gw = await startGateway(
      { setStatus: (key, text) => ctx.ui.setStatus(key, text) },
      (msg) => ctx.ui.notify(`tg-gw: ${msg}`, "info"),
      "extension",
    );
    gateway = gw;
  });

  pi.on("session_shutdown", async () => {
    gateway?.stop();
    gateway = null;
  });
}