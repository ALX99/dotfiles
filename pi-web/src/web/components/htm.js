// Bound `html` template tag for htm + preact. We bind here (rather than
// importing htm/preact) because htm/preact's published file does
// `import "preact"` (a bare specifier) which the browser can't resolve
// without an import map. This wrapper keeps the binding local and lets
// the components import a relative path.
import { h } from "/vendor/preact.js";
import htm from "/vendor/htm.js";

export const html = htm.bind(h);
