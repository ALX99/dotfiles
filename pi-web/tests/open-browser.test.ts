import { test } from "node:test";
import assert from "node:assert/strict";
import { openBrowser, type SpawnFn } from "../src/open-browser.ts";

function makeFakeSpawn(): {
  fn: SpawnFn;
  calls: Array<{ cmd: string; args: readonly string[]; opts: unknown }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
  const fn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref: () => {} };
  };
  return { fn, calls };
}

test("openBrowser: spawns 'open' on darwin with detached/ignore", () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const { fn, calls } = makeFakeSpawn();
    openBrowser("http://127.0.0.1:7878/", fn);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "open");
    assert.deepEqual([...calls[0]!.args], ["http://127.0.0.1:7878/"]);
    const opts = calls[0]!.opts as { detached: boolean; stdio: string };
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio, "ignore");
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("openBrowser: spawns 'xdg-open' on linux", () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const { fn, calls } = makeFakeSpawn();
    openBrowser("http://127.0.0.1:7878/", fn);
    assert.equal(calls[0]!.cmd, "xdg-open");
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("openBrowser: logs warning on unknown platform, no spawn", () => {
  const original = process.platform;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  Object.defineProperty(process, "platform", { value: "aix" });
  console.warn = (msg: string) => {
    warnings.push(msg);
  };
  try {
    const { fn, calls } = makeFakeSpawn();
    openBrowser("http://127.0.0.1:7878/", fn);
    assert.equal(calls.length, 0);
    assert.ok(
      warnings.some((w) => w.includes("Cannot auto-open browser")),
      `expected warning, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: original });
    console.warn = originalWarn;
  }
});
