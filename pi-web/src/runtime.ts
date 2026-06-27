// Real BridgeRuntime implementation backed by the pi SDK.
//
// Uses createAgentSessionRuntime() to get a runtime that supports
// newSession/switchSession/fork, and a DefaultResourceLoader so the
// user's installed extensions/skills/prompts/context files are loaded
// from the same locations the TUI uses.

import {
  createAgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionFromServicesOptions,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import {
  type BridgeRuntime,
  type BridgeSession,
  type SessionListEntry,
} from "./bridge.ts";

export interface RealRuntime extends BridgeRuntime {
  dispose(): Promise<void>;
}

export async function createRealRuntime(opts: {
  cwd: string;
}): Promise<RealRuntime> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.create(opts.cwd, getAgentDir());

  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    settingsManager,
  });
  await loader.reload();

  // Pick a default model: first available, falling back to first known
  // (may lack API key, but setModel would fail later in that case).
  const available = await modelRegistry.getAvailable();
  let model: Model<any> | undefined = available[0];
  if (!model) {
    const all = modelRegistry.getAll();
    model = all.find(
      (m) => m.provider === "anthropic" || m.provider === "openai",
    );
  }
  if (!model) {
    model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
  }

  const sessionManager = SessionManager.create(opts.cwd);

  let currentModel = model;

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager: sm,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd });
    const opts: CreateAgentSessionFromServicesOptions = {
      services,
      sessionManager: sm,
      thinkingLevel: "medium",
      ...(sessionStartEvent !== undefined
        ? { sessionStartEvent }
        : {}),
      ...(currentModel ? { model: currentModel } : {}),
    };
    const result = await createAgentSessionFromServices(opts);
    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    sessionManager,
  });

  return {
    get session() {
      return runtime.session as unknown as BridgeSession;
    },
    setCurrentModel(m: Model<any>): void {
      currentModel = m;
    },
    async newSession() {
      return runtime.newSession();
    },
    async switchSession(path) {
      return runtime.switchSession(path);
    },
    async listSessions() {
      const list = await SessionManager.list(opts.cwd);
      const entries = list.map((entry) => {
        const e: SessionListEntry = { path: entry.path, id: entry.id };
        if (entry.name !== undefined) e.name = entry.name;
        e.firstMessage = entry.firstMessage;
        e.startedAt = entry.modified.getTime();
        return e;
      });
      entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      return entries;
    },
    async getAvailableModels(): Promise<Model<any>[]> {
      const all = await modelRegistry.getAvailable();
      return all;
    },
    async dispose() {
      await runtime.dispose();
    },
  };
}
