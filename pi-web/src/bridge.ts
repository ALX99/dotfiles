// Bridge: AgentSessionRuntime <-> WebSocket fan-out.
//
// On construction: subscribes to runtime.session events; pushes them
// (JSON-serialized) to every connected client sender.
//
// On handleCommand: parses a raw client message, dispatches to the SDK,
// sends a { type: "response", id, ok, error? } back to the originating
// client. The originating client is the one whose send closure is passed
// alongside the raw message (server.ts threads these together).
//
// Session replacement (newSession/switchSession) goes through runtime,
// which mutates runtime.session. The bridge then calls rebind() to
// re-subscribe to the new session.

import { parseClientCommand, type ClientCommand, type ServerResponse } from "./protocol.ts";
import type { ModelThinkingLevel, Model } from "@earendil-works/pi-ai";

/** Subset of AgentSession the bridge depends on. */
export interface BridgeSession {
  subscribe(cb: (event: unknown) => void): () => void;
  prompt(text: string, opts?: { images?: unknown[] }): Promise<void>;
  abort(): Promise<void>;
  setModel(model: Model<any>): Promise<boolean>;
  setThinkingLevel(level: ModelThinkingLevel): void;
  readonly messages: unknown[];
  readonly sessionFile: string | undefined;
  readonly agent: {
    readonly state: {
      readonly model: Model<any> | undefined;
      readonly thinkingLevel: ModelThinkingLevel;
      readonly isStreaming: boolean;
      readonly messageCount: number;
    };
  };
}

export interface SessionListEntry {
  path: string;
  id: string;
  name?: string;
  firstMessage?: string;
  startedAt?: number;
}

export interface BridgeRuntime {
  readonly session: BridgeSession;
  newSession(): Promise<{ cancelled: boolean }>;
  switchSession(path: string): Promise<{ cancelled: boolean }>;
  /** List available session files. */
  listSessions(): Promise<SessionListEntry[]>;
  /** List models the registry can use. */
  getAvailableModels(): Promise<Model<any>[]>;
  /** Track the user's model choice so new sessions inherit it. */
  setCurrentModel?(model: Model<any>): void;
}

export type ClientSender = (data: string) => void;
export type RemoveClient = () => void;

export interface BridgeOptions {
  runtime: BridgeRuntime;
  onClientCountChange?: (count: number) => void;
}

export class Bridge {
  private readonly runtime: BridgeRuntime;
  private readonly onClientCountChange: ((count: number) => void) | undefined;
  private unsubscribe: (() => void) | null = null;
  private clients = new Map<ClientSender, true>();
  private disposed = false;

  constructor(opts: BridgeOptions) {
    this.runtime = opts.runtime;
    if (opts.onClientCountChange !== undefined) {
      this.onClientCountChange = opts.onClientCountChange;
    }
    this.subscribeCurrent();
  }

  private subscribeCurrent(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.unsubscribe = this.runtime.session.subscribe((event) => {
      this.broadcastEvent(event);
    });
  }

  rebind(): void {
    if (this.disposed) return;
    this.subscribeCurrent();
  }

  private broadcastEvent(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const send of this.clients.keys()) {
      try {
        send(payload);
      } catch {
        // best-effort
      }
    }
  }

  private respond(send: ClientSender, response: ServerResponse): void {
    try {
      send(JSON.stringify(response));
    } catch {
      // best-effort
    }
  }

  addClient(send: ClientSender): RemoveClient {
    this.clients.set(send, true);
    if (this.onClientCountChange !== undefined) {
      this.onClientCountChange(this.clients.size);
    }
    return () => {
      if (this.clients.delete(send)) {
        if (this.onClientCountChange !== undefined) {
          this.onClientCountChange(this.clients.size);
        }
      }
    };
  }

  async handleCommand(raw: unknown, replyTo: ClientSender): Promise<void> {
    if (this.disposed) return;
    const cmd = parseClientCommand(raw);
    if (!cmd) {
      const id = (raw as { id?: unknown })?.id;
      this.respond(replyTo, {
        type: "response",
        id: typeof id === "string" ? id : "unknown",
        ok: false,
        error: "invalid command",
      });
      return;
    }
    try {
      await this.dispatch(cmd, replyTo);
    } catch (err) {
      this.respond(replyTo, {
        type: "response",
        id: cmd.id,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  private async dispatch(
    cmd: ClientCommand,
    replyTo: ClientSender,
  ): Promise<void> {
    const session = this.runtime.session;
    switch (cmd.type) {
      case "prompt": {
        const opts: { images?: unknown[] } = {};
        if (cmd.images) opts.images = cmd.images;
        await session.prompt(cmd.text, cmd.images ? opts : undefined);
        this.respond(replyTo, { type: "response", id: cmd.id, ok: true });
        return;
      }
      case "abort": {
        await session.abort();
        this.respond(replyTo, { type: "response", id: cmd.id, ok: true });
        return;
      }
      case "set_model": {
        const models = await this.runtime.getAvailableModels();
        const target = models.find(
          (m) => m.provider === cmd.provider && m.id === cmd.modelId,
        );
        if (!target) {
          this.respond(replyTo, {
            type: "response",
            id: cmd.id,
            ok: false,
            error: `unknown model: ${cmd.provider}/${cmd.modelId}`,
          });
          return;
        }
        await session.setModel(target);
        this.runtime.setCurrentModel?.(target);
        this.respond(replyTo, { type: "response", id: cmd.id, ok: true });
        return;
      }
      case "set_thinking_level": {
        // SDK's setThinkingLevel type is `ThinkingLevel` (no "off"), but
        // the runtime accepts "off". Cast at the call site.
        session.setThinkingLevel(cmd.level as never);
        this.respond(replyTo, { type: "response", id: cmd.id, ok: true });
        return;
      }
      case "get_state": {
        const s = session.agent.state;
        this.respond(replyTo, {
          type: "response",
          id: cmd.id,
          ok: true,
          data: {
            model: s.model
              ? { provider: s.model.provider, id: s.model.id, name: s.model.name }
              : null,
            thinkingLevel: s.thinkingLevel,
            isStreaming: s.isStreaming,
            messageCount: s.messageCount,
            messages: session.messages,
            sessionFile: session.sessionFile,
          },
        });
        return;
      }
      case "list_sessions": {
        const sessions = await this.runtime.listSessions();
        this.respond(replyTo, {
          type: "response",
          id: cmd.id,
          ok: true,
          data: { sessions },
        });
        return;
      }
      case "list_models": {
        const models = await this.runtime.getAvailableModels();
        const slim = models.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
        }));
        this.respond(replyTo, {
          type: "response",
          id: cmd.id,
          ok: true,
          data: { models: slim },
        });
        return;
      }
      case "new_session":
      case "switch_session": {
        // Handled by handleSessionCommand, which has access to rebind().
        await this.handleSessionCommand(cmd, replyTo);
        return;
      }
      default: {
        // Exhaustiveness check.
        const _exhaustive: never = cmd;
        this.respond(replyTo, {
          type: "response",
          id: (_exhaustive as { id: string }).id,
          ok: false,
          error: "unhandled command",
        });
      }
    }
  }

  private async handleSessionCommand(
    cmd: Extract<ClientCommand, { type: "new_session" | "switch_session" }>,
    replyTo: ClientSender,
  ): Promise<void> {
    const result =
      cmd.type === "new_session"
        ? await this.runtime.newSession()
        : await this.runtime.switchSession(cmd.path);
    if (result.cancelled) {
      this.respond(replyTo, {
        type: "response",
        id: cmd.id,
        ok: false,
        error: "cancelled by extension",
      });
      return;
    }
    this.rebind();
    this.respond(replyTo, { type: "response", id: cmd.id, ok: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.clients.clear();
    if (this.onClientCountChange !== undefined) {
      this.onClientCountChange(0);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
