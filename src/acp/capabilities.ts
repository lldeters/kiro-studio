/**
 * What the agent said it can do in the `initialize` result. Optional behaviour is switched on from this and
 * never from version numbers. Parsing is lenient: a missing or odd field means "not offered".
 */
import { arr, kiroMeta, num, rec, str, type JsonObject } from '../util/json';

export interface AuthMethod {
  id: string;
  name: string;
}

export interface KiroLogChannel {
  name: string;
  filePath: string;
}

export interface Capabilities {
  protocolVersion: number;
  loadSession: boolean;
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcp: { http: boolean; sse: boolean };
  session: {
    list: boolean;
    close: boolean;
    delete: boolean;
    fork: boolean;
    /** `_meta.kiro.messageId` on the fork capability: a session can be forked at a given message. */
    forkAtMessage: boolean;
    resume: boolean;
  };
  /** Methods named in `_meta.kiro.extensionMethods`. */
  extensionMethods: ReadonlySet<string>;
  kiro: {
    checkpoints: boolean;
    replayMarking: boolean;
    sessionSources: string[];
    sessionListScopes: string[];
    executionTargets: string[];
    autoCompactionThreshold?: { min?: number; max?: number; default?: number };
    logDir?: string;
    logChannels: KiroLogChannel[];
    raw: JsonObject;
  };
  authMethods: AuthMethod[];
}

const strings = (value: unknown): string[] => arr(value).filter((v): v is string => typeof v === 'string');

/** A capability object (`{}`) counts as offered; `null`, `false` and absence do not. */
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

export function parseInitializeResult(result: unknown): Capabilities {
  const body = rec(result);
  const agent = rec(body.agentCapabilities);
  const sessionCaps = rec(agent.sessionCapabilities);
  const kiro = kiroMeta(agent);
  const threshold = rec(kiro.autoCompactionThreshold);
  const logging = rec(kiro.logging);
  const min = num(threshold.min);
  const max = num(threshold.max);
  const def = num(threshold.default);
  const logDir = str(logging.logDir);

  return {
    protocolVersion: num(body.protocolVersion) ?? 1,
    loadSession: agent.loadSession === true,
    prompt: {
      image: rec(agent.promptCapabilities).image === true,
      audio: rec(agent.promptCapabilities).audio === true,
      embeddedContext: rec(agent.promptCapabilities).embeddedContext === true,
    },
    mcp: { http: rec(agent.mcpCapabilities).http === true, sse: rec(agent.mcpCapabilities).sse === true },
    session: {
      list: present(sessionCaps.list),
      close: present(sessionCaps.close),
      delete: present(sessionCaps.delete),
      fork: present(sessionCaps.fork),
      forkAtMessage: kiroMeta(sessionCaps.fork).messageId === true,
      resume: present(sessionCaps.resume),
    },
    extensionMethods: new Set(strings(kiro.extensionMethods)),
    kiro: {
      checkpoints: kiro.checkpoints === true,
      replayMarking: kiro.replayMarking === true,
      sessionSources: strings(kiro.sessionSources),
      sessionListScopes: strings(kiro.sessionListScopes),
      executionTargets: strings(kiro.executionTargets),
      ...(min === undefined && max === undefined && def === undefined
        ? {}
        : {
            autoCompactionThreshold: {
              ...(min === undefined ? {} : { min }),
              ...(max === undefined ? {} : { max }),
              ...(def === undefined ? {} : { default: def }),
            },
          }),
      ...(logDir === undefined ? {} : { logDir }),
      logChannels: arr(logging.channels).flatMap((c) => {
        const name = str(rec(c).name);
        const filePath = str(rec(c).filePath);
        return name === undefined || filePath === undefined ? [] : [{ name, filePath }];
      }),
      raw: kiro,
    },
    authMethods: arr(body.authMethods).flatMap((m) => {
      const id = str(rec(m).id);
      return id === undefined ? [] : [{ id, name: str(rec(m).name) ?? id }];
    }),
  };
}

export function hasExtension(capabilities: Capabilities | undefined, method: string): boolean {
  return capabilities?.extensionMethods.has(method) === true;
}

/** True when the agent advertised the extension namespace at all, which is how the V3 engine shows itself. */
export function looksLikeKiroV3(capabilities: Capabilities): boolean {
  return capabilities.extensionMethods.size > 0;
}
