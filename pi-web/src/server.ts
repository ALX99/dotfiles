// HTTP + WebSocket server.
//
// Static files: GET /<path> from webRoot (default pi-web/dist, the
//                Vite build output).
// WebSocket:    WS  /ws   forwards raw frames to the bridge.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Bridge, type BridgeRuntime, type ClientSender } from "./bridge.ts";
import { createRealRuntime, type RealRuntime } from "./runtime.ts";
import { openBrowser } from "./open-browser.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_WEB_ROOT = resolve(__dirname, "..", "dist");

export interface ServerDeps {
  runtime: BridgeRuntime;
  webRoot: string;
}

export interface ServerHandle {
  server: HttpServer;
  bridge: Bridge;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function isLoopback(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "::"
  );
}

export function startServer(opts: {
  port: number;
  host: string;
  ctx: ServerDeps;
}): ServerHandle {
  if (!isLoopback(opts.host)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${opts.host}". Use 127.0.0.1 or ::1.`,
    );
  }
  const { runtime, webRoot } = opts.ctx;

  const bridge = new Bridge({ runtime });
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, webRoot);
    } catch (err) {
      res.statusCode = 500;
      res.end(`Internal error: ${(err as Error).message}`);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const send: ClientSender = (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    };
    const remove = bridge.addClient(send);
    ws.on("close", remove);
    ws.on("error", remove);
    ws.on("message", (data) => {
      const raw = data.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      void bridge.handleCommand(parsed, send);
    });
  });

  server.listen(opts.port, opts.host);

  return {
    server,
    bridge,
    stop: () =>
      new Promise<void>((resolve) => {
        bridge.dispose();
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        server.close(() => resolve());
        // Failsafe: resolve after 500ms even if close() hangs on a
        // stubborn connection. Better to leak briefly than to hang the
        // test runner.
        setTimeout(() => resolve(), 500).unref();
      }),
  };
}

function isInsideRoot(path: string, root: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(rootWithSep);
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  const rel = pathname === "/" ? "/index.html" : pathname;
  const root = resolve(webRoot);
  const full = normalize(join(root, rel));
  if (!isInsideRoot(full, root)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const s = await stat(full);
    if (!s.isFile()) throw new Error("not a file");
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const buf = await readFile(full);
  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
  );
  res.end(buf);
}

/* ----- CLI entry point ----- */

function parseArgs(argv: string[]): { cwd: string } {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cwd") {
      const v = argv[++i];
      if (!v) throw new Error("--cwd requires a value");
      cwd = resolve(v);
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: pi-web [--cwd <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { cwd };
}

export async function runFromCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const { cwd } = parseArgs(argv);
  const port = Number(process.env.PI_WEB_PORT ?? 7878);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PI_WEB_PORT: ${process.env.PI_WEB_PORT}`);
  }
  const autoOpen = process.env.PI_WEB !== "0";

  const runtime: RealRuntime = await createRealRuntime({ cwd });
  const ctx: ServerDeps = {
    runtime,
    webRoot: DEFAULT_WEB_ROOT,
  };
  const handle = startServer({ port, host: "127.0.0.1", ctx });

  await new Promise<void>((resolve) =>
    handle.server.once("listening", () => resolve()),
  );
  const addr = handle.server.address();
  const portActual =
    typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${portActual}/`;

  console.log(`[pi-web] cwd: ${cwd}`);
  console.log(`[pi-web] listening on ${url}`);

  if (autoOpen) {
    setTimeout(() => openBrowser(url), 50);
  }

  const shutdown = async () => {
    console.log("\n[pi-web] shutting down");
    await handle.stop();
    await runtime.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(__filename);
if (isMain) {
  runFromCli().catch((err) => {
    console.error(`[pi-web] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
