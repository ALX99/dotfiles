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

export function openBrowser(
  url: string,
  spawn: SpawnFn = defaultSpawn as unknown as SpawnFn,
): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "linux") {
    cmd = "xdg-open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    console.warn(
      `[pi-web] Cannot auto-open browser on platform "${platform}". Open ${url} manually.`,
    );
    return;
  }

  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    console.warn(
      `[pi-web] Failed to spawn ${cmd}: ${(err as Error).message}. Open ${url} manually.`,
    );
  }
}
