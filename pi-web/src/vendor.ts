// Resolve the on-disk paths of vendored browser modules.
//
// The server serves preact + htm from `pi-web/node_modules` via
// /vendor/* routes. The preact and htm packages have an `exports`
// field that blocks `require.resolve("preact/dist/preact.module.js")`.
// We work around this by resolving the package root (which is allowed),
// then walking the known layout: preact's browser file is
// `<pkg>/dist/preact.module.js`; htm's browser file is
// `<pkg>/dist/htm.module.js`.
//
// Note: we intentionally do NOT vendor `htm/preact`. That module does
// `import "preact"` (bare specifier), which the browser cannot resolve
// without an import map. Instead, components import htm and bind
// `html` themselves (see src/web/components/htm.js).

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

type VendorName = "preact" | "htm";

function getPkgDir(pkg: string): string {
  // require.resolve on the package root resolves to the entry point,
  // which is in <pkg>/dist/. dirname^2 is the package root.
  const entry = require.resolve(pkg);
  return dirname(dirname(entry));
}

const CANDIDATES: Record<VendorName, string[]> = {
  preact: ["dist/preact.module.js", "dist/preact.mjs", "dist/preact.min.module.js"],
  htm: ["dist/htm.module.js", "dist/htm.mjs"],
};

export function resolveVendorFile(name: VendorName): string {
  const pkgDir = getPkgDir(name);
  const errors: string[] = [];
  for (const rel of CANDIDATES[name]) {
    const p = join(pkgDir, rel);
    if (existsSync(p)) return p;
    errors.push(`not found: ${p}`);
  }
  throw new Error(
    `Cannot resolve vendor file "${name}":\n  ${errors.join("\n  ")}`,
  );
}
