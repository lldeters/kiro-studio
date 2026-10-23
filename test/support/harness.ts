import { KiroAgent, type AgentDeps, type AgentSettings } from '../../src/acp/agent';
import type { FileSystemPort, WriteGate } from '../../src/acp/handlers/fs';
import type { OptionKind } from '../../src/acp/handlers/permissions';
import { ProtocolLog, type LogLevel } from '../../src/util/log';
import { createRedactor } from '../../src/util/redact';
import { sleep } from '../../src/util/async';
import type { TransportFactory } from '../../src/acp/transport';
import { FakeAgent, type FakeAgentOptions } from './fakeAgent';

export interface HarnessOptions {
  fake?: FakeAgentOptions;
  settings?: Partial<MutableSettings>;
  backoffMs?: number[];
  cancelHoldMs?: number;
  logLevel?: LogLevel;
  workspace?: string;
  shutdownGraceMs?: number;
  files?: Record<string, string>;
  /** Replaces the transport, for example to make starting fail. Receives the fake. */
  transport?: (fake: FakeAgent) => TransportFactory;
  writeGate?: WriteGate;
  turnHooks?: AgentDeps['turnHooks'];
}

export interface MutableSettings {
  autonomy: 'supervised' | 'autopilot';
  autoAllow: boolean;
  hooks: boolean;
  mode: string;
  model: string;
  effort: string;
}

export function createHarness(options: HarnessOptions = {}) {
  const workspace = options.workspace ?? '/ws';
  const fake = new FakeAgent(options.fake);
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const writes: { path: string; content: string }[] = [];
  const fsPort: FileSystemPort = {
    readText: (path) => Promise.resolve(files.get(path)),
    writeText: (path, content) => {
      files.set(path, content);
      writes.push({ path, content });
      return Promise.resolve();
    },
  };
  const lines: string[] = [];
  const log = new ProtocolLog(
    { appendLine: (l) => lines.push(l) },
    () => options.logLevel ?? 'verbose',
    createRedactor('/home/me'),
  );
  const settings: MutableSettings = {
    autonomy: 'supervised',
    autoAllow: true,
    hooks: false,
    mode: '',
    model: '',
    effort: '',
    ...options.settings,
  };
  const agentSettings: AgentSettings = {
    autonomy: () => settings.autonomy,
    autoAllowInAutopilot: () => settings.autoAllow,
    hooksEnabled: () => settings.hooks,
    defaultMode: () => settings.mode,
    defaultModel: () => settings.model,
    defaultEffort: () => settings.effort,
  };
  const opened: string[] = [];
  const agent = new KiroAgent({
    transport: options.transport ? options.transport(fake) : fake.factory,
    log,
    settings: agentSettings,
    fs: fsPort,
    workspaceRoots: () => [workspace],
    openUrl: (url) => void opened.push(url),
    clientInfo: { name: 'kiro-studio-test', version: '0.0.0' },
    platform: 'posix',
    ...(options.writeGate === undefined ? {} : { writeGate: options.writeGate }),
    ...(options.turnHooks === undefined ? {} : { turnHooks: options.turnHooks }),
    backoffMs: options.backoffMs ?? [5, 5, 5],
    stableAfterMs: 1000,
    cancelHoldMs: options.cancelHoldMs ?? 300,
    connection: {
      timeouts: { transport: 2000, initialize: 2000, session: 2000, extension: 2000 },
      shutdownGraceMs: options.shutdownGraceMs ?? 50,
    },
  });

  /** Answers every request that needs the user with the given kind, like a user who always clicks the same button. */
  const autoAnswer = (kind: OptionKind) =>
    agent.permissions.requested.on(({ session, approval }) => {
      queueMicrotask(() => agent.permissions.answer(session.id, approval.id, kind));
    });

  return { agent, fake, files, writes, lines, log, settings, opened, autoAnswer, workspace };
}

export type Harness = ReturnType<typeof createHarness>;

export async function until(condition: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return;
    await sleep(5);
  }
  if (!condition()) throw new Error(`Timed out waiting for ${label}`);
}

/** Config writes the fake received, as `configId=value`. */
export function configWrites(fake: FakeAgent): string[] {
  return fake.requestsOf('session/set_config_option').map((m) => {
    const p = m.params as { configId: string; value: string };
    return `${p.configId}=${p.value}`;
  });
}
