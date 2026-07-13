/**
 * Caffeinate Extension — Prevents macOS sleep while an agent is running.
 *
 * Spawns `caffeinate` when a user prompt begins processing and kills it when
 * the agent finishes. The assertion is also tied to Pi's PID so abnormal exits
 * cannot leave an orphaned caffeinate process behind.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  let proc: ReturnType<typeof spawn> | null = null;

  function killCaffeinate() {
    const child = proc;
    proc = null;
    child?.kill();
  }

  function startCaffeinate() {
    if (proc) return;

    const child = spawn(
      "/usr/bin/caffeinate",
      ["-i", "-w", String(process.pid)],
      { stdio: "ignore" },
    );
    proc = child;

    const clearProcess = () => {
      if (proc === child) proc = null;
    };
    child.once("error", clearProcess);
    child.once("exit", clearProcess);
  }

  // Start caffeinate when the agent begins processing a user prompt.
  pi.on("agent_start", startCaffeinate);

  // Stop caffeinate when the agent finishes.
  pi.on("agent_end", killCaffeinate);

  // Safety net: clean up on session shutdown (quit, reload, switch, fork).
  pi.on("session_shutdown", killCaffeinate);
}
