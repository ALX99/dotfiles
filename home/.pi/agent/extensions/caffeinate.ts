/**
 * Caffeinate Extension — Prevents macOS sleep while an agent is running.
 *
 * Spawns `caffeinate` when a user prompt begins processing, kills it when
 * the agent finishes. Includes a session_shutdown safety net and guards
 * against orphaned processes from rapid successive prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  let proc: ReturnType<typeof spawn> | null = null;

  function killCaffeinate() {
    if (proc) {
      proc.kill();
      proc = null;
    }
  }

  function startCaffeinate() {
    // Kill any existing instance before starting a new one.
    killCaffeinate();
    proc = spawn("/usr/bin/caffeinate", ["-i"], {
      stdio: "ignore",
      detached: false,
    });
    proc.on("error", () => {
      proc = null;
    });
    proc.on("exit", () => {
      proc = null;
    });
  }

  // Start caffeinate when the agent begins processing a user prompt.
  pi.on("agent_start", startCaffeinate);

  // Stop caffeinate when the agent finishes.
  pi.on("agent_end", killCaffeinate);

  // Safety net: clean up on session shutdown (quit, reload, switch, fork).
  pi.on("session_shutdown", killCaffeinate);

  process.on("exit", killCaffeinate);
}
