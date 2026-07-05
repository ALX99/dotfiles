// Cross-platform "open URL in default browser" helper.
//
// macOS:   open <url>
// Linux:   xdg-open <url>
// Windows: cmd /c start "" <url>
// Other:   log a warning; the user opens the URL manually.

import { spawn as defaultSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

type BrowserCommand = (url: string) => { cmd: string; args: string[] };

const BROWSER_COMMANDS: Partial<Record<NodeJS.Platform, BrowserCommand>> = {
  darwin: (url) => ({ cmd: "open", args: [url] }),
  linux: (url) => ({ cmd: "xdg-open", args: [url] }),
  win32: (url) => ({ cmd: "cmd", args: ["/c", "start", "", url] }),
};

export function openBrowser(
  url: string,
  spawn: SpawnFn = defaultSpawn as unknown as SpawnFn,
): void {
  const command = BROWSER_COMMANDS[process.platform]?.(url);
  if (!command) {
    console.warn(
      `[pi-web] Cannot auto-open browser on platform "${process.platform}". Open ${url} manually.`,
    );
    return;
  }

  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    console.warn(
      `[pi-web] Failed to spawn ${command.cmd}: ${(err as Error).message}. Open ${url} manually.`,
    );
  }
}
