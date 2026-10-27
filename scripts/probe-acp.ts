/**
 * Phase 0 probe for Kiro Studio.
 *
 * Starts `kiro-cli acp --agent-engine=v3 --auth-method=cli` in a throw-away directory,
 * performs `initialize` and `session/new`, optionally sends ONE tiny prompt, and records
 * every JSON-RPC line that crosses the pipe (before any SDK parsing) into
 * `probe-logs/<timestamp>/`. The result feeds docs/protocol-notes.md.
 *
 *   npm run probe                      full run (sends one prompt, costs a few credits)
 *   npm run probe -- --no-prompt       handshake + session only, no credits
 *   npm run probe -- --help
 *
 * The MCP probes P1 to P6 (`--mcp-config`, `--client-steering`, `--mcp-live-reload`, `--mcp-sign-in`,
 * `--secret-storage`, `--env-expansion`) check what docs/protocol-notes.md marks [C], read in the
 * shipped code of a newer CLI but never run.
 *
 * Safety: the probe's working directory is a fresh temp folder. Permission requests are
 * granted once, and only when every path they mention is inside that folder. The MCP probes
 * write mcp.json only in that folder, never open a page, and keep Kiro's secrets in memory.
 * Raw logs are redacted on a best-effort basis (tokens, e-mail addresses, home directory);
 * read them before sharing them. Secret values never reach them.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { catalogProposal, MCP_CATALOG, type McpCatalogEntry } from '../src/shared/mcpCatalog.js';
import { secretEnvName, toConfigEntry, type McpConfigEntry } from '../src/shared/mcpProposal.js';
import { createRedactor } from '../src/util/redact.js';
import { MCP_STEERING_NAME, mcpInstructionText } from '../src/workspace/mcpInstructions.js';

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const rec = (v: unknown): Json => (isRecord(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function describeError(e: unknown): Json {
  if (e instanceof acp.RequestError) return { code: e.code, message: e.message, data: e.data };
  return { message: errorMessage(e) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

interface Options {
  cli?: string;
  acpArgs: string[];
  prompt: string;
  noPrompt: boolean;
  autopilot: 'on' | 'off' | 'keep';
  model?: string;
  mode?: string;
  protocolVersion: number;
  approve: 'safe' | 'none';
  review: 'accept' | 'reject';
  fs: boolean;
  terminal: boolean;
  hooks: boolean;
  extensions: boolean;
  timeoutSec: number;
  exitWaitSec: number;
  keepDir: boolean;
  out?: string;
  redact: boolean;
  kiroDebug: boolean;
  includeKiroLog: boolean;
  mcpConfig: boolean;
  clientSteering: boolean;
  mcpLiveReload: boolean;
  mcpSignIn?: string;
  secretStorage: boolean;
  signInWaitSec: number;
  envExpansion: boolean;
  help: boolean;
}

const HELP = `Usage: npm run probe -- [options]

  --cli <path>            kiro-cli executable (default: $KIRO_CLI_PATH, PATH, ~/.local/bin)
  --acp-args "<args>"     arguments after the executable (default: "acp --agent-engine=v3 --auth-method=cli")
  --prompt <text>         the single prompt to send (default: German hello.txt example)
  --no-prompt             stop after handshake, session/new and read-only calls (no credits)
  --autopilot on|off|keep set Kiro's "autopilot" session option before prompting (default: off = Supervised)
  --model <id>            set the "model" session option (only if advertised)
  --mode <id>             set the "mode" session option, i.e. the agent (only if advertised)
  --protocol-version <n>  protocolVersion sent in initialize (default: ${acp.PROTOCOL_VERSION}, the SDK's stable version)
  --approve safe|none     safe = allow once when all paths are inside the temp dir (default); none = reject all
  --review accept|reject  answer Kiro's end-of-turn "Review changes" request (default: accept); reject shows whether Kiro reverts
  --no-fs                 do not advertise fs/read_text_file and fs/write_text_file
  --terminal              advertise and implement terminal/* (runs agent-requested commands in the temp dir)
  --hooks                 opt in to Kiro hooks (clientCapabilities._meta.kiro.hooks); may run your global hooks
  --no-extensions         skip the read-only _kiro/* calls
  --timeout <seconds>     overall limit for the prompt turn (default: 180)
  --exit-wait <seconds>   how long to wait for the CLI to exit after stdin is closed before killing it (default: 5)
  --kiro-debug            start kiro-cli with KIRO_LOG_LEVEL=debug
  --include-kiro-log      append the last 200 lines of Kiro's own chat log to the output (may contain private data)
  --keep-dir              do not delete the temp working directory
  --out <dir>             output directory (default: probe-logs/<timestamp>)
  --no-redact             keep tokens, e-mail addresses and the home directory in the logs
  --help

MCP probes (docs/protocol-notes.md section 17). mcp.json is written only in the temp dir; nothing is opened.
  --mcp-config            P1: Microsoft Learn in the temp dir's .kiro/settings/mcp.json; records the _kiro/mcp/status entries
  --client-steering       P2: steering documents in _meta.kiro.steering; with a prompt also a hidden resource block,
                          then session/load to see what Kiro replays
  --mcp-live-reload       P3: add a server to mcp.json after session/new and time the status that names it
  --mcp-sign-in <id>      P4: a server of Kiro Studio's list that signs in in the browser (e.g. linear); calls
                          _kiro/mcp/resetServer with startOAuth and answers _kiro/openExternalUrl with an error
  --secret-storage        P5: advertise secretStorage and keep Kiro's secrets in memory (key names are recorded, never
                          values); with --mcp-sign-in the sign-in page is printed for you to open, then the CLI is
                          started again to see whether the sign-in survived
  --sign-in-wait <secs>   how long --secret-storage waits for you to finish the sign-in (default: 180)
  --env-expansion         P6: a 127.0.0.1 server that answers 401 and records whether \${VAR} in a header of mcp.json
                          was filled in from the environment kiro-cli was started with
`;

function parseArgs(argv: string[]): Options {
  const o: Options = {
    acpArgs: ['acp', '--agent-engine=v3', '--auth-method=cli'],
    prompt: 'Lege hello.txt mit dem Inhalt Hallo an',
    noPrompt: false,
    autopilot: 'off',
    protocolVersion: acp.PROTOCOL_VERSION,
    approve: 'safe',
    review: 'accept',
    fs: true,
    terminal: false,
    hooks: false,
    extensions: true,
    timeoutSec: 180,
    exitWaitSec: 5,
    keepDir: false,
    redact: true,
    kiroDebug: false,
    includeKiroLog: false,
    mcpConfig: false,
    clientSteering: false,
    mcpLiveReload: false,
    secretStorage: false,
    signInWaitSec: 180,
    envExpansion: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i] ?? '';
    let inline: string | undefined;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) {
      inline = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const oneOf = <T extends string>(v: string, allowed: readonly T[]): T => {
      if (!(allowed as readonly string[]).includes(v)) throw new Error(`${flag} must be one of: ${allowed.join(', ')}`);
      return v as T;
    };
    switch (flag) {
      case '--cli':
        o.cli = value();
        break;
      case '--acp-args':
        o.acpArgs = value().split(/\s+/).filter(Boolean);
        break;
      case '--prompt':
        o.prompt = value();
        break;
      case '--no-prompt':
        o.noPrompt = true;
        break;
      case '--autopilot':
        o.autopilot = oneOf(value(), ['on', 'off', 'keep'] as const);
        break;
      case '--model':
        o.model = value();
        break;
      case '--mode':
        o.mode = value();
        break;
      case '--protocol-version':
        o.protocolVersion = Number.parseInt(value(), 10);
        break;
      case '--approve':
        o.approve = oneOf(value(), ['safe', 'none'] as const);
        break;
      case '--review':
        o.review = oneOf(value(), ['accept', 'reject'] as const);
        break;
      case '--no-fs':
        o.fs = false;
        break;
      case '--terminal':
        o.terminal = true;
        break;
      case '--hooks':
        o.hooks = true;
        break;
      case '--no-extensions':
        o.extensions = false;
        break;
      case '--timeout':
        o.timeoutSec = Number.parseInt(value(), 10);
        break;
      case '--exit-wait':
        o.exitWaitSec = Number.parseInt(value(), 10);
        break;
      case '--kiro-debug':
        o.kiroDebug = true;
        break;
      case '--include-kiro-log':
        o.includeKiroLog = true;
        break;
      case '--keep-dir':
        o.keepDir = true;
        break;
      case '--out':
        o.out = value();
        break;
      case '--no-redact':
        o.redact = false;
        break;
      case '--mcp-config':
        o.mcpConfig = true;
        break;
      case '--client-steering':
        o.clientSteering = true;
        break;
      case '--mcp-live-reload':
        o.mcpLiveReload = true;
        break;
      case '--mcp-sign-in':
        o.mcpSignIn = value();
        break;
      case '--secret-storage':
        o.secretStorage = true;
        break;
      case '--sign-in-wait':
        o.signInWaitSec = Number.parseInt(value(), 10);
        break;
      case '--env-expansion':
        o.envExpansion = true;
        break;
      case '--help':
      case '-h':
        o.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}\n\n${HELP}`);
    }
  }
  if (!Number.isInteger(o.protocolVersion) || o.timeoutSec <= 0 || Number.isNaN(o.timeoutSec) || !(o.exitWaitSec > 0)) {
    throw new Error('--protocol-version, --timeout and --exit-wait must be positive integers');
  }
  if (!(o.signInWaitSec > 0)) throw new Error('--sign-in-wait must be a positive integer');
  if (o.mcpSignIn !== undefined) signInEntry(o.mcpSignIn);
  return o;
}

// ---------------------------------------------------------------------------------------
// Redaction (best effort)
// ---------------------------------------------------------------------------------------

const { redactText, redactDeep } = createRedactor(os.homedir());

// ---------------------------------------------------------------------------------------
// Recorder: raw wire log, stderr log, observed message inventory
// ---------------------------------------------------------------------------------------

class Recorder {
  readonly t0 = Date.now();
  lastIncoming = Date.now();
  readonly observed = new Map<string, { count: number; firstAtMs: number }>();
  readonly stderrTail: string[] = [];
  stderrLines = 0;
  unparseableLines = 0;
  private readonly clientRequests = new Map<string | number, string>();
  private readonly agentRequests = new Map<string | number, string>();
  private readonly wirePath: string;
  private readonly stderrPath: string;

  constructor(
    readonly dir: string,
    private readonly redact: boolean,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.wirePath = path.join(dir, 'wire.ndjson');
    this.stderrPath = path.join(dir, 'stderr.log');
    fs.writeFileSync(this.wirePath, '');
    fs.writeFileSync(this.stderrPath, '');
  }

  elapsed(): number {
    return Date.now() - this.t0;
  }

  private count(key: string): void {
    const entry = this.observed.get(key);
    if (entry) entry.count++;
    else this.observed.set(key, { count: 1, firstAtMs: this.elapsed() });
  }

  private label(msg: Json, direction: 'out' | 'in'): string {
    const method = str(msg.method);
    const hasId = 'id' in msg && msg.id !== undefined;
    const id = msg.id as string | number | undefined;
    if (method) {
      if (hasId && id !== undefined) (direction === 'out' ? this.clientRequests : this.agentRequests).set(id, method);
      let key = `${hasId ? 'request' : 'notification'} ${method}`;
      if (method === 'session/update') {
        const update = rec(rec(msg.params).update);
        key += `:${str(update.sessionUpdate) ?? '?'}`;
        const kind = str(rec(rec(update._meta).kiro).kind);
        if (kind) key += `[${kind}]`;
      }
      return key;
    }
    // A response travels in the opposite direction of the request it answers.
    const table = direction === 'in' ? this.clientRequests : this.agentRequests;
    const requestMethod = id === undefined ? undefined : table.get(id);
    return `${'error' in msg ? 'error-response' : 'response'} ${requestMethod ?? '?'}`;
  }

  /**
   * The values of Kiro's `_kiro/secret/*` requests and of our answers to `get` are its MCP sign-ins. They never reach
   * the log, not even with --no-redact; `label` has registered the request before its answer is written.
   */
  private hideSecrets(msg: Json, direction: 'out' | 'in'): Json {
    const method = str(msg.method);
    if (method?.startsWith('_kiro/secret/') && typeof rec(msg.params).value === 'string') {
      return { ...msg, params: { ...rec(msg.params), value: '[secret]' } };
    }
    const id = msg.id as string | number | undefined;
    const answersGet =
      direction === 'out' && !method && id !== undefined && this.agentRequests.get(id) === '_kiro/secret/get';
    if (answersGet && typeof rec(msg.result).value === 'string') {
      return { ...msg, result: { ...rec(msg.result), value: '[secret]' } };
    }
    return msg;
  }

  /** `direction` is from the client's point of view: out = client→agent, in = agent→client. */
  wireLine(direction: 'out' | 'in', line: string): void {
    if (direction === 'in') this.lastIncoming = Date.now();
    let entry: Json;
    try {
      const parsed = rec(JSON.parse(line));
      this.count(`${direction === 'out' ? 'client→agent' : 'agent→client'} ${this.label(parsed, direction)}`);
      const msg = this.hideSecrets(parsed, direction);
      entry = {
        t: this.elapsed(),
        dir: direction === 'out' ? 'client→agent' : 'agent→client',
        msg: this.redact ? redactDeep(msg) : msg,
      };
    } catch {
      this.unparseableLines++;
      entry = {
        t: this.elapsed(),
        dir: direction === 'out' ? 'client→agent' : 'agent→client',
        raw: this.redact ? redactText(line) : line,
      };
    }
    fs.appendFileSync(this.wirePath, JSON.stringify(entry) + '\n');
  }

  note(text: string, data?: unknown): void {
    const entry = {
      t: this.elapsed(),
      dir: 'note',
      text,
      ...(data === undefined ? {} : { data: this.redact ? redactDeep(data) : data }),
    };
    fs.appendFileSync(this.wirePath, JSON.stringify(entry) + '\n');
  }

  stderrLine(line: string): void {
    this.stderrLines++;
    const text = this.redact ? redactText(line) : line;
    fs.appendFileSync(this.stderrPath, text + '\n');
    this.stderrTail.push(text);
    if (this.stderrTail.length > 20) this.stderrTail.shift();
  }

  async settle(quietMs: number, maxMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs && Date.now() - this.lastIncoming < quietMs) await sleep(50);
  }

  safe<T>(value: T): T {
    return this.redact ? (redactDeep(value) as T) : value;
  }
}

function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk) => {
    buffer += decoder.write(chunk);
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

// ---------------------------------------------------------------------------------------
// Locating and interrogating the CLI
// ---------------------------------------------------------------------------------------

interface RunResult {
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
  ms: number;
  error?: string;
}

function run(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: env ?? process.env },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code ?? 1) : 0;
        resolve({
          exitCode: code,
          stdout: String(stdout),
          stderr: String(stderr),
          ms: Date.now() - started,
          ...(err ? { error: err.message.split('\n')[0] ?? 'failed' } : {}),
        });
      },
    );
  });
}

function isExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function locateCli(explicit: string | undefined): Promise<{ path?: string; tried: string[]; via?: string }> {
  const tried: string[] = [];
  const check = (p: string | undefined, via: string) => {
    if (!p) return undefined;
    tried.push(`${via}: ${p}`);
    return isExecutable(p) ? { path: p, tried, via } : undefined;
  };
  const fromFlag = check(explicit, '--cli');
  if (fromFlag) return fromFlag;
  const fromEnv = check(process.env.KIRO_CLI_PATH, 'KIRO_CLI_PATH');
  if (fromEnv) return fromEnv;

  const names = process.platform === 'win32' ? ['kiro-cli.exe', 'kiro-cli.cmd', 'kiro-cli.bat'] : ['kiro-cli'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const found = check(path.join(dir, name), 'PATH');
      if (found) return found;
    }
  }
  if (process.platform === 'win32') {
    const where = await run('where.exe', ['kiro-cli'], 10_000);
    tried.push(`where.exe kiro-cli -> exit ${where.exitCode}`);
    const first = where.stdout.split(/\r?\n/).find((l) => l.trim());
    const found = check(first?.trim(), 'where.exe');
    if (found) return found;
  }
  // Locations that editors do not inherit from the shell PATH. Candidates only; see docs/PLAN.md.
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  for (const candidate of [
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli'),
    ...(process.platform === 'win32'
      ? [path.join(localAppData, 'Kiro-Cli', 'kiro-cli.exe')]
      : ['/usr/local/bin/kiro-cli', '/opt/homebrew/bin/kiro-cli']),
  ]) {
    const found = check(candidate, 'candidate');
    if (found) return found;
  }
  return { tried };
}

/** kiro-cli starts a Node-based agent server as a child; on Windows `kill()` alone would leave that child running. */
async function killTree(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') await run('taskkill', ['/pid', String(proc.pid), '/T', '/F'], 10_000);
  else proc.kill();
}

function kiroLogCandidates(): string[] {
  switch (process.platform) {
    case 'win32':
      return [path.join(os.tmpdir(), 'kiro-log', 'logs', 'kiro-chat.log')];
    case 'darwin':
      return [path.join(process.env.TMPDIR ?? os.tmpdir(), 'kiro-log', 'kiro-chat.log')];
    default:
      return [path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'kiro-log', 'kiro-chat.log')];
  }
}

// ---------------------------------------------------------------------------------------
// Permission policy
// ---------------------------------------------------------------------------------------

function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toFsPath(raw: string, root: string): string {
  if (raw.startsWith('file://')) return fileURLToPath(raw);
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

interface Decision {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
  summary: Json;
}

function decidePermission(
  params: Json,
  workDir: string,
  mode: Options['approve'],
  review: Options['review'],
): Decision {
  const options = arr(params.options).map(rec);
  const meta = rec(rec(params._meta).kiro);
  const consent = rec(meta.consent);
  const root = str(consent.workspaceRoot) ?? workDir;

  const raw: string[] = [];
  for (const l of arr(rec(params.toolCall).locations)) raw.push(str(rec(l).path) ?? '');
  raw.push(str(consent.resource) ?? '');
  for (const f of arr(meta.files)) raw.push(str(rec(f).path) ?? '');
  const paths = raw.filter(Boolean).map((p) => toFsPath(p, root));

  const capability = str(consent.capability);
  const type = str(meta.type);
  const knownSafeKind = type === 'turn_approval' || capability === 'fs_write' || capability === 'fs_read';
  const allow = mode === 'safe' && knownSafeKind && paths.length > 0 && paths.every((p) => isInside(workDir, p));

  const wanted = allow && !(type === 'turn_approval' && review === 'reject') ? 'allow_once' : 'reject_once';
  const option = options.find((o) => o.kind === wanted);
  const optionId = str(option?.optionId);
  return {
    outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    summary: {
      title: str(rec(params.toolCall).title),
      toolCallId: str(rec(params.toolCall).toolCallId),
      capability,
      type,
      paths,
      offered: options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
      decision: optionId ? wanted : 'cancelled (no matching option offered)',
      chosenOptionId: optionId,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Wiring a kiro-cli process
// ---------------------------------------------------------------------------------------

/** Records every line both ways and returns the stream the SDK writes to (it is piped into the CLI's stdin). */
function wireProcess(proc: ChildProcess, recorder: Recorder): PassThrough {
  const toChild = new PassThrough();
  if (proc.stdin) toChild.pipe(proc.stdin);
  toChild.on(
    'data',
    lineSplitter((line) => recorder.wireLine('out', line)),
  );
  proc.stdout?.on(
    'data',
    lineSplitter((line) => recorder.wireLine('in', line)),
  );
  proc.stderr?.on(
    'data',
    lineSplitter((line) => recorder.stderrLine(line)),
  );
  proc.stdin?.on('error', () => {
    /* the exit handler reports the crash */
  });
  return toChild;
}

/**
 * The SDK would strictly validate every session/update and silently drop the ones it does not know
 * (see docs/protocol-notes.md). So notifications never reach it: they are diverted to `onNotification`,
 * while the SDK keeps handling responses and agent->client requests. `$/` methods stay with the SDK.
 */
function divertedStream(
  toChild: PassThrough,
  stdout: Readable,
  onNotification: (msg: acp.AnyNotification) => void,
  recorder: Recorder,
): acp.Stream {
  // The scripts project uses the DOM stream types; Node's differ slightly.
  const rawStream = acp.ndJsonStream(
    Writable.toWeb(toChild),
    Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
  );
  return {
    writable: rawStream.writable,
    readable: rawStream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform(message, controller) {
          const isNotification = 'method' in message && !('id' in message);
          const divert = isNotification && (message.method === 'session/update' || message.method.startsWith('_'));
          if (!divert) {
            controller.enqueue(message);
            return;
          }
          try {
            onNotification(message);
          } catch (e) {
            recorder.note('notification handler failed', describeError(e));
          }
        },
      }),
    ),
  };
}

// ---------------------------------------------------------------------------------------
// MCP probes (P1 to P6, see docs/protocol-notes.md section 17)
// ---------------------------------------------------------------------------------------

/** P1: a server that needs no sign-in. The entries come from Kiro Studio's own list, as the extension writes them. */
const P1_SERVER = 'microsoft-learn';
/** P3: the server added after `session/new`. */
const P3_SERVER = 'aws-knowledge';
/** P6: the local server, and the variable its header refers to, named the way Kiro Studio names the keys it stores. */
const P6_SERVER = 'probe-env';
const P6_VARIABLE = secretEnvName(P6_SERVER, 'TOKEN');
/** P2: words the steering document and the hidden block ask for, so the answer shows which of them reached Kiro. */
const P2_STEERING_WORD = 'COCONUT';
const P2_RESOURCE_WORD = 'PINEAPPLE';

function catalogEntry(id: string): McpConfigEntry {
  const entry = MCP_CATALOG.find((e) => e.id === id);
  if (!entry) throw new Error(`${id} is not in Kiro Studio's list of MCP servers`);
  return toConfigEntry(catalogProposal(entry));
}

/** `--mcp-sign-in` takes only servers of the list that sign in in the browser: they need no key from the user. */
function signInEntry(id: string): McpCatalogEntry {
  const allowed = MCP_CATALOG.filter((e) => e.signIn === 'browser' && e.url !== undefined);
  const entry = allowed.find((e) => e.id === id);
  if (!entry) throw new Error(`--mcp-sign-in must be one of: ${allowed.map((e) => e.id).join(', ')}`);
  return entry;
}

/** The steering documents of P2: Kiro Studio's real one, and one whose effect shows in the answer. */
function probeSteering(): Json[] {
  return [
    { name: MCP_STEERING_NAME, inclusion: 'always', content: mcpInstructionText() },
    {
      name: 'kiro-studio-probe',
      inclusion: 'always',
      content: `End every answer with the word ${P2_STEERING_WORD}.`,
    },
  ];
}

/** The temp workspace's `.kiro/settings/mcp.json`. The probe never touches the user's own file. */
class ProbeMcpFile {
  private readonly servers: Record<string, unknown> = {};

  constructor(private readonly workDir: string) {}

  get file(): string {
    return path.join(this.workDir, '.kiro', 'settings', 'mcp.json');
  }

  get names(): string[] {
    return Object.keys(this.servers);
  }

  /** Writes the file with `name` added; without a name it writes what is there, an empty list at first. */
  write(name?: string, entry?: unknown): void {
    if (name !== undefined) this.servers[name] = entry;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ mcpServers: this.servers }, null, 2) + '\n');
  }
}

/** One `_kiro/mcp/status` entry: its keys and the fields Kiro Studio reads. The authorization URL is never kept. */
function describeStatusEntry(raw: unknown): Json {
  const e = rec(raw);
  const tools = Array.isArray(e.tools) ? e.tools : undefined;
  return {
    name: str(e.name),
    status: str(e.status),
    keys: Object.keys(e).sort(),
    ...(str(e.authType) ? { authType: str(e.authType) } : {}),
    ...(typeof e.failedAuthorization === 'boolean' ? { failedAuthorization: e.failedAuthorization } : {}),
    ...('authorizationUrl' in e ? { hasAuthorizationUrl: true } : {}),
    ...(str(e.errorCode) ? { errorCode: str(e.errorCode) } : {}),
    ...(str(e.errorMessage) ? { errorMessage: str(e.errorMessage)?.slice(0, 300) } : {}),
    ...(tools ? { tools: tools.length, toolKeys: Object.keys(rec(tools[0])).sort() } : {}),
  };
}

/** What Kiro reports about MCP in one process: status snapshots, client steering documents and pages it asks for. */
class McpObserver {
  readonly snapshots: Json[] = [];
  readonly clientDocuments: Json[] = [];
  readonly externalUrls: Json[] = [];
  private readonly latestByName = new Map<string, Json>();

  constructor(private readonly recorder: Recorder) {}

  /** Takes the notifications that concern MCP; everything else is ignored. */
  notification(msg: acp.AnyNotification): void {
    const params = rec(msg.params);
    if (msg.method === '_kiro/mcp/status') this.status(params);
    else if (msg.method === '_kiro/steering/documents_changed') this.steering(params);
    else if (msg.method === '_kiro/openExternalUrl') this.externalUrl('notification', params, 'none (a notification)');
  }

  private status(params: Json): void {
    const servers = arr(params.servers).map(describeStatusEntry);
    for (const server of servers) {
      const name = str(server.name);
      if (name) this.latestByName.set(name, server);
    }
    if (this.snapshots.length >= 50) return;
    this.snapshots.push({
      t: this.recorder.elapsed(),
      envelope: Object.keys(params).sort(),
      ...(str(params.accessMode) ? { accessMode: str(params.accessMode) } : {}),
      servers,
    });
  }

  private steering(params: Json): void {
    for (const doc of arr(params.documents).map(rec)) {
      const uri = str(doc.uri) ?? '';
      if (!uri.startsWith('client:') || this.clientDocuments.some((d) => d.uri === uri)) continue;
      this.clientDocuments.push({ t: this.recorder.elapsed(), name: str(doc.name), uri, inclusion: doc.inclusion });
    }
  }

  /** Records how a page was asked for: the parameter names, the host and the query keys, not the address itself. */
  externalUrl(via: 'request' | 'notification', params: Json, answer: string): void {
    let host: string | undefined;
    let queryKeys: string[] = [];
    try {
      const url = new URL(str(params.url) ?? '');
      host = url.host;
      queryKeys = [...new Set(url.searchParams.keys())].sort();
    } catch {
      /* not a URL: the parameter names still tell */
    }
    this.externalUrls.push({
      t: this.recorder.elapsed(),
      via,
      paramKeys: Object.keys(params).sort(),
      host,
      queryKeys,
      answer,
    });
  }

  latest(name: string): Json | undefined {
    return this.latestByName.get(name);
  }

  /** The latest entry for `name` once `accept` takes it, or undefined after `ms`. */
  async waitFor(name: string, accept: (entry: Json) => boolean, ms: number): Promise<Json | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const entry = this.latest(name);
      if (entry && accept(entry)) return entry;
      if (Date.now() >= end) return undefined;
      await sleep(100);
    }
  }
}

/** Kiro's `_kiro/secret/*` (P5), kept in this process's memory only. The summary gets key names and sizes. */
class ProbeSecrets {
  readonly operations: Json[] = [];
  private readonly values = new Map<string, string>();

  constructor(private readonly recorder: Recorder) {}

  /** `round` tells the first process from the one started again. */
  register(app: acp.ClientApp, round: number): void {
    app
      .onRequest(
        '_kiro/secret/get',
        (p: unknown) => rec(p),
        (ctx) => {
          const key = str(ctx.params.key) ?? '';
          const value = this.values.get(key);
          this.note(round, 'get', key, { found: value !== undefined });
          return value === undefined ? {} : { value };
        },
      )
      .onRequest(
        '_kiro/secret/store',
        (p: unknown) => rec(p),
        (ctx) => {
          const key = str(ctx.params.key) ?? '';
          const value = str(ctx.params.value);
          if (value === undefined) throw new acp.RequestError(-32602, 'value must be a string');
          this.values.set(key, value);
          this.note(round, 'store', key, { bytes: Buffer.byteLength(value) });
          return {};
        },
      )
      .onRequest(
        '_kiro/secret/delete',
        (p: unknown) => rec(p),
        (ctx) => {
          const key = str(ctx.params.key) ?? '';
          this.values.delete(key);
          this.note(round, 'delete', key, {});
          return {};
        },
      );
  }

  get keys(): string[] {
    return [...this.values.keys()].sort();
  }

  private note(round: number, op: string, key: string, extra: Json): void {
    this.operations.push({ round, t: this.recorder.elapsed(), op, key, ...extra });
  }
}

/** P6: a local server that answers every request with 401 and records how the Authorization header arrived. */
async function startEchoServer(
  token: string,
  recorder: Recorder,
): Promise<{ url: string; seen: Json[]; close: () => Promise<void> }> {
  const seen: Json[] = [];
  const server = http.createServer((req, res) => {
    const header = req.headers.authorization;
    // Not called "authorization" in the summary: the redactor would hide the verdict.
    const sent =
      header === undefined
        ? 'missing'
        : header === `Bearer ${token}`
          ? 'expanded'
          : header.includes('${')
            ? 'literal'
            : 'other';
    if (seen.length < 50) {
      seen.push({ t: recorder.elapsed(), method: req.method, path: (req.url ?? '').split('?')[0], header: sent });
    }
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end('{"error":"unauthorized"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** What the local server of P6 saw, in one word. */
function expansionVerdict(seen: readonly Json[]): string {
  if (seen.length === 0) return 'no request reached the local server';
  if (seen.some((s) => s.header === 'expanded')) return 'expanded from the environment of kiro-cli';
  if (seen.some((s) => s.header === 'literal')) return 'sent as written (not expanded)';
  if (seen.every((s) => s.header === 'missing')) return 'no Authorization header';
  return 'something else';
}

interface RestartCheck {
  cli: string;
  opts: Options;
  workDir: string;
  env: NodeJS.ProcessEnv;
  recorder: Recorder;
  secrets: ProbeSecrets;
  server: string;
}

/**
 * P5: starts the CLI a second time with the secrets the first one stored, opens a session and waits for the signed-in
 * server. Connected without a new sign-in page means the sign-in survived the restart.
 */
async function restartCheck(p: RestartCheck): Promise<Json> {
  const { cli, opts, workDir, env, recorder, secrets, server } = p;
  recorder.note('P5: starting kiro-cli again with the same secrets');
  const proc = spawn(cli, opts.acpArgs, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
  const exited = new Promise<boolean>((resolve) => {
    proc.once('exit', () => resolve(true));
    proc.once('error', () => resolve(true));
  });
  const toChild = wireProcess(proc, recorder);
  const observer = new McpObserver(recorder);
  const app = acp.client({ name: 'kiro-studio-probe' }).onRequest(
    '_kiro/openExternalUrl',
    (q: unknown) => rec(q),
    (ctx) => {
      observer.externalUrl('request', ctx.params, 'error -32603');
      throw new acp.RequestError(-32603, 'The Kiro Studio probe does not open pages');
    },
  );
  secrets.register(app, 2);
  const result: Json = { server };
  try {
    await app.connectWith(
      divertedStream(toChild, proc.stdout, (msg) => observer.notification(msg), recorder),
      async (cx) => {
        const initParams: acp.InitializeRequest = {
          protocolVersion: opts.protocolVersion,
          clientCapabilities: { _meta: { kiro: { openExternalUrl: true, secretStorage: true } } },
          clientInfo: { name: 'kiro-studio-probe', title: 'Kiro Studio probe', version: '0.0.0' },
        };
        await withTimeout(cx.request(acp.methods.agent.initialize, initParams), 60_000, 'initialize');
        const created = await withTimeout(
          cx.request(acp.methods.agent.session.new, { cwd: workDir, mcpServers: [] }),
          120_000,
          'session/new',
        );
        const entry = await observer.waitFor(server, (e) => e.status === 'connected' || e.status === 'failed', 60_000);
        result.status = entry ?? null;
        result.survived = entry?.status === 'connected' && observer.externalUrls.length === 0;
        result.signInPagesRequested = observer.externalUrls;
        try {
          await withTimeout(
            cx.request(acp.methods.agent.session.close, { sessionId: created.sessionId }),
            15_000,
            'session/close',
          );
        } catch {
          /* the process is ended below either way */
        }
      },
    );
  } catch (e) {
    result.error = describeError(e);
  }
  proc.stdin.end();
  const exitedInTime = await Promise.race([exited, sleep(opts.exitWaitSec * 1000).then(() => false)]);
  if (!exitedInTime) await killTree(proc);
  return result;
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const KNOWN_UPDATES = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

/** Read-only `_kiro/*` methods the probe may call, and only if the agent advertised them. */
const READ_ONLY_EXTENSIONS = [
  '_kiro/session/context',
  '_kiro/account/getUsage',
  '_kiro/mcp/status',
  '_kiro/hooks/list',
  '_kiro/config/template',
  '_kiro/memory/list',
];

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const outDir = path.resolve(opts.out ?? path.join(repoRoot, 'probe-logs', stamp));
  const recorder = new Recorder(outDir, opts.redact);
  const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-studio-probe-')));
  const log = (s: string) => process.stdout.write(`${s}\n`);

  const summary: Json = {
    probe: {
      startedAt: new Date().toISOString(),
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      node: process.version,
      options: { ...opts, cli: undefined },
    },
    workDir: opts.redact ? '<temp dir>' : workDir,
    findings: [] as string[],
  };
  const findings = summary.findings as string[];
  const finding = (s: string) => {
    findings.push(s);
    log(`  ! ${s}`);
  };
  let child: ChildProcess | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null; atMs: number } | undefined;
  let exitCode = 0;
  let echo: Awaited<ReturnType<typeof startEchoServer>> | undefined;

  const finish = () => {
    summary.observedMessages = Object.fromEntries([...recorder.observed.entries()].sort().map(([k, v]) => [k, v]));
    summary.stderr = { lines: recorder.stderrLines, tail: recorder.stderrTail };
    summary.unparseableLines = recorder.unparseableLines;
    summary.elapsedMs = recorder.elapsed();
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(recorder.safe(summary), null, 2) + '\n');
  };
  process.once('SIGINT', () => {
    if (child) void killTree(child);
    finding('interrupted by SIGINT');
    finish();
    process.exit(130);
  });

  try {
    log(`Kiro Studio ACP probe -> ${path.relative(process.cwd(), outDir) || outDir}`);

    // 1. Locate and interrogate the CLI ------------------------------------------------
    const located = await locateCli(opts.cli);
    summary.cliLookup = recorder.safe({
      via: located.via,
      found: located.path,
      triedCount: located.tried.length,
      lastTried: located.tried.slice(-4),
    });
    if (!located.path) {
      finding('kiro-cli not found. Pass --cli <path> or set KIRO_CLI_PATH. Install: https://kiro.dev/docs/cli/');
      finish();
      return 2;
    }
    const cli = located.path;
    log(`  cli: ${recorder.safe(cli)} (via ${located.via})`);

    const [version, whoami, acpHelp] = await Promise.all([
      run(cli, ['--version'], 20_000),
      run(cli, ['whoami', '--format', 'json'], 30_000),
      run(cli, [...opts.acpArgs.slice(0, 1), '--help'], 20_000),
    ]);
    // `whoami` may print a "Profile:" block after the JSON line (Identity Center); decode the first line only.
    let whoamiParsed: unknown = null;
    try {
      whoamiParsed = JSON.parse(whoami.stdout.split(/\r?\n/)[0] ?? '');
    } catch {
      /* keep null */
    }
    summary.cli = recorder.safe({
      version: { ...version, stdout: version.stdout.trim() },
      whoami: {
        exitCode: whoami.exitCode,
        parsedFirstLine: whoamiParsed,
        rawStdout: whoami.stdout,
        stderr: whoami.stderr.trim(),
      },
      acpHelp: { exitCode: acpHelp.exitCode, stdout: acpHelp.stdout, stderr: acpHelp.stderr },
    });
    log(`  version: ${version.stdout.trim() || `(exit ${version.exitCode})`}`);
    const loggedIn = whoami.exitCode === 0;
    log(`  whoami: ${loggedIn ? 'logged in' : `NOT logged in (exit ${whoami.exitCode}) - run "kiro-cli login"`}`);
    if (!loggedIn)
      finding(
        'whoami failed; the prompt step is skipped. Handshake/session behaviour while logged out is still recorded.',
      );

    // 2. MCP probes that Kiro must see when it starts: the temp workspace's mcp.json and the local server of P6
    const mcpFile = new ProbeMcpFile(workDir);
    const signIn = opts.mcpSignIn === undefined ? undefined : signInEntry(opts.mcpSignIn);
    const secrets = opts.secretStorage ? new ProbeSecrets(recorder) : undefined;
    const mcpObserver = new McpObserver(recorder);
    const mcpProbe =
      opts.mcpConfig ||
      opts.clientSteering ||
      opts.mcpLiveReload ||
      !!signIn ||
      opts.secretStorage ||
      opts.envExpansion;
    const mcpSummary: Json = {};
    if (mcpProbe) summary.mcp = mcpSummary;
    const probeToken = randomBytes(16).toString('hex');
    if (opts.mcpConfig) mcpFile.write(P1_SERVER, catalogEntry(P1_SERVER));
    if (signIn) mcpFile.write(signIn.id, catalogEntry(signIn.id));
    if (opts.envExpansion) {
      echo = await startEchoServer(probeToken, recorder);
      mcpFile.write(P6_SERVER, { url: echo.url, headers: { Authorization: 'Bearer ${' + P6_VARIABLE + '}' } });
    }
    // P3 adds to a file that exists from the start, as the user's own file usually does.
    if (opts.mcpLiveReload && mcpFile.names.length === 0) mcpFile.write();
    if (mcpProbe) recorder.note('wrote the temp workspace mcp.json', { servers: mcpFile.names });

    // 3. Spawn the ACP server ------------------------------------------------------------
    const env = {
      ...process.env,
      ...(opts.kiroDebug ? { KIRO_LOG_LEVEL: 'debug' } : {}),
      ...(opts.envExpansion ? { [P6_VARIABLE]: probeToken } : {}),
    };
    const proc = spawn(cli, opts.acpArgs, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    child = proc;
    const toChild = wireProcess(proc, recorder);

    const exitPromise = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        exited = { code, signal, atMs: recorder.elapsed() };
        resolve();
      });
      proc.once('error', (err) => {
        finding(`spawn failed: ${err.message}`);
        resolve();
      });
    });
    recorder.note('spawned', { command: cli, args: opts.acpArgs, cwd: workDir });

    // 4. State fed by the notification dispatcher ----------------------------------------
    let sessionId = '';
    let configOptions: unknown[] = [];
    let commands: unknown[] = [];
    const toolCalls = new Map<string, { title?: string; kind?: string; statuses: string[]; hasDiff: boolean }>();
    const unknownUpdates = new Set<string>();
    const kiroKinds = new Set<string>();
    const extraNotifications = new Set<string>();
    let latestContextUsage: unknown;
    let replayFlagSeen = false;
    let answerText = '';
    const replayedUserContent: Json[] = [];

    const onNotification = (msg: acp.AnyNotification): void => {
      const params = rec(msg.params);
      if (msg.method !== 'session/update') {
        extraNotifications.add(msg.method);
        mcpObserver.notification(msg);
        return;
      }
      const update = rec(params.update);
      const type = str(update.sessionUpdate) ?? '?';
      const kiro = rec(rec(update._meta).kiro);
      if (!KNOWN_UPDATES.has(type)) unknownUpdates.add(type);
      const kind = str(kiro.kind);
      if (kind) kiroKinds.add(kind);
      if (kiro.replay === true) replayFlagSeen = true;
      if (type === 'config_option_update') configOptions = arr(update.configOptions);
      if (type === 'available_commands_update') commands = arr(update.availableCommands);
      if (kind === 'context_usage') latestContextUsage = kiro.contextUsage ?? kiro.usagePercentage;
      if (type === 'agent_message_chunk' && kiro.replay !== true) answerText += str(rec(update.content).text) ?? '';
      if (type === 'user_message_chunk' && kiro.replay === true && replayedUserContent.length < 50) {
        // P2: does Kiro replay the hidden block, as a resource or as text?
        const content = rec(update.content);
        replayedUserContent.push({
          type: str(content.type),
          hasHiddenWord: JSON.stringify(content).includes(P2_RESOURCE_WORD),
        });
      }
      if (type === 'tool_call' || type === 'tool_call_update') {
        const id = str(update.toolCallId) ?? '?';
        const entry = toolCalls.get(id) ?? { statuses: [], hasDiff: false };
        entry.title = str(update.title) ?? entry.title;
        entry.kind = str(update.kind) ?? entry.kind;
        const status = str(update.status);
        if (status) entry.statuses.push(status);
        if (arr(update.content).some((c) => rec(c).type === 'diff')) entry.hasDiff = true;
        toolCalls.set(id, entry);
      }
    };

    const stream = divertedStream(toChild, proc.stdout, onNotification, recorder);

    // 5. Client handlers (agent -> client requests) --------------------------------------
    const permissions: Json[] = [];
    const terminals = new Map<
      string,
      {
        proc: ChildProcess;
        output: string;
        truncated: boolean;
        limit: number;
        done: Promise<{ exitCode: number | null; signal: string | null }>;
      }
    >();
    const guard = (p: string): string => {
      const abs = toFsPath(p, workDir);
      if (!isInside(workDir, abs))
        throw new acp.RequestError(-32602, 'Path is outside the probe workspace', { path: p });
      return abs;
    };

    const app = acp
      .client({ name: 'kiro-studio-probe' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const decision = decidePermission(rec(ctx.params), workDir, opts.approve, opts.review);
        permissions.push(decision.summary);
        recorder.note('permission decision', decision.summary);
        return { outcome: decision.outcome };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const file = guard(ctx.params.path);
        const text = await fs.promises.readFile(file, 'utf8').catch((e: unknown) => {
          // ACP reserves -32002 for a missing resource; Kiro reads a file before creating it.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw acp.RequestError.resourceNotFound(file);
          throw e;
        });
        const lines = text.split('\n');
        const from = Math.max((ctx.params.line ?? 1) - 1, 0);
        const content =
          ctx.params.line || ctx.params.limit
            ? lines.slice(from, ctx.params.limit ? from + ctx.params.limit : undefined).join('\n')
            : text;
        return { content };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        const file = guard(ctx.params.path);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, ctx.params.content, 'utf8');
        return {};
      })
      .onRequest(
        '_kiro/openExternalUrl',
        (p: unknown) => rec(p),
        (ctx) => {
          recorder.note('_kiro/openExternalUrl requested (not opened by the probe)', ctx.params);
          if (signIn && secrets) {
            // P5 needs a finished sign-in: the user opens the page, the probe does not.
            mcpObserver.externalUrl('request', ctx.params, '{} (printed for you to open)');
            log(`  Open this page yourself to sign in (the probe opens nothing):\n  ${str(ctx.params.url) ?? '?'}`);
            return {};
          }
          if (signIn) {
            // P4: what Kiro does when the client refuses the page.
            mcpObserver.externalUrl('request', ctx.params, 'error -32603');
            throw new acp.RequestError(-32603, 'The Kiro Studio probe does not open pages');
          }
          mcpObserver.externalUrl('request', ctx.params, '{}');
          return {};
        },
      );
    secrets?.register(app, 1);

    if (opts.terminal) {
      app
        .onRequest(acp.methods.client.terminal.create, (ctx) => {
          const p = ctx.params;
          const cwd = p.cwd ? guard(p.cwd) : workDir;
          const limit = p.outputByteLimit ?? 1_000_000;
          const child2 = spawn(p.command, p.args ?? [], {
            cwd,
            windowsHide: true,
            env: { ...process.env, ...Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])) },
          });
          const entry = {
            proc: child2,
            output: '',
            truncated: false,
            limit,
            done: undefined as unknown as Promise<{ exitCode: number | null; signal: string | null }>,
          };
          const append = (b: Buffer) => {
            entry.output += b.toString('utf8');
            if (Buffer.byteLength(entry.output) > limit) {
              entry.output = entry.output.slice(-limit);
              entry.truncated = true;
            }
          };
          child2.stdout?.on('data', append);
          child2.stderr?.on('data', append);
          entry.done = new Promise((resolve) => {
            child2.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
            child2.once('error', (err) => {
              append(Buffer.from(String(err.message)));
              resolve({ exitCode: 127, signal: null });
            });
          });
          const terminalId = `probe-term-${terminals.size + 1}`;
          terminals.set(terminalId, entry);
          return { terminalId };
        })
        .onRequest(acp.methods.client.terminal.output, async (ctx) => {
          const t = terminals.get(ctx.params.terminalId);
          if (!t) throw new acp.RequestError(-32602, 'Unknown terminal');
          const state = await Promise.race([t.done, Promise.resolve(undefined)]);
          return {
            output: t.output,
            truncated: t.truncated,
            ...(state ? { exitStatus: { exitCode: state.exitCode, signal: state.signal } } : {}),
          };
        })
        .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
          const t = terminals.get(ctx.params.terminalId);
          if (!t) throw new acp.RequestError(-32602, 'Unknown terminal');
          const { exitCode, signal } = await t.done;
          return { exitCode, signal };
        })
        .onRequest(acp.methods.client.terminal.kill, (ctx) => {
          terminals.get(ctx.params.terminalId)?.proc.kill();
          return {};
        })
        .onRequest(acp.methods.client.terminal.release, (ctx) => {
          terminals.get(ctx.params.terminalId)?.proc.kill();
          terminals.delete(ctx.params.terminalId);
          return {};
        });
    }

    // 6. The conversation -----------------------------------------------------------------
    const clientCapabilities = {
      ...(opts.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
      ...(opts.terminal ? { terminal: true } : {}),
      _meta: {
        kiro: {
          openExternalUrl: true,
          ...(opts.secretStorage ? { secretStorage: true } : {}),
          ...(opts.hooks ? { hooks: { enabled: true, v2: true } } : {}),
        },
      },
    };
    const steeringMeta = opts.clientSteering ? { kiro: { steering: probeSteering() } } : undefined;
    let signedIn = false;

    await app.connectWith(stream, async (cx) => {
      log('  -> initialize');
      const initParams: acp.InitializeRequest = {
        protocolVersion: opts.protocolVersion,
        clientCapabilities,
        clientInfo: { name: 'kiro-studio-probe', title: 'Kiro Studio probe', version: '0.0.0' },
      };
      const timings: Record<string, number> = {};
      summary.timingsMs = timings;
      const initStarted = Date.now();
      const init = await withTimeout(cx.request(acp.methods.agent.initialize, initParams), 60_000, 'initialize');
      timings.initialize = Date.now() - initStarted;
      summary.initialize = { sentCapabilities: clientCapabilities, result: recorder.safe(init) };
      const caps = rec(init.agentCapabilities);
      const kiroCaps = rec(rec(caps._meta).kiro);
      const extensionMethods = arr(kiroCaps.extensionMethods).filter((m): m is string => typeof m === 'string');
      const sessionCaps = rec(caps.sessionCapabilities);
      log(
        `     protocolVersion ${init.protocolVersion}, extensionMethods: ${extensionMethods.length}, loadSession: ${String(caps.loadSession)}`,
      );
      if (init.protocolVersion !== opts.protocolVersion)
        finding(`agent answered protocolVersion ${init.protocolVersion} to our ${opts.protocolVersion}`);
      if (extensionMethods.length === 0)
        finding(
          'no _meta.kiro.extensionMethods advertised; this may not be the V3 engine (check "kiro-cli --version" and the acp --help output).',
        );

      log('  -> session/new');
      const newStarted = Date.now();
      const created = await withTimeout(
        cx.request(acp.methods.agent.session.new, {
          cwd: workDir,
          mcpServers: [],
          ...(steeringMeta ? { _meta: steeringMeta } : {}),
        }),
        120_000,
        'session/new',
      );
      timings.sessionNew = Date.now() - newStarted;
      sessionId = created.sessionId;
      if (Array.isArray(created.configOptions)) configOptions = created.configOptions;
      summary.sessionNew = recorder.safe(created);
      // Kiro advertises `model`/`effortLevel` late (see docs/protocol-notes.md section 3). Wait for silence so
      // the report can say whether the advertisement ever comes without being asked for.
      await recorder.settle(1500, 8000);
      const modelAdvertised = arr(configOptions)
        .map(rec)
        .some((o) => o.id === 'model');
      summary.modelAdvertisedWithoutWrite = modelAdvertised;
      if (!modelAdvertised) finding('no "model" config option appeared within 1.5 s of silence after session/new');

      const optionById = (id: string) =>
        arr(configOptions)
          .map(rec)
          .find((o) => o.id === id);
      const hasValue = (id: string, value: string) =>
        arr(optionById(id)?.options)
          .map(rec)
          .some((o) => o.value === value);
      const setOption = async (configId: string, value: string) => {
        if (!optionById(configId)) {
          finding(`config option "${configId}" is not advertised; not set`);
          return;
        }
        if (!hasValue(configId, value)) {
          finding(`config option "${configId}" has no value "${value}"; not set`);
          return;
        }
        log(`  -> session/set_config_option ${configId}=${value}`);
        try {
          const r = await withTimeout(
            cx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value }),
            30_000,
            'set_config_option',
          );
          if (Array.isArray(r.configOptions)) configOptions = r.configOptions;
        } catch (e) {
          finding(`set_config_option ${configId}=${value} failed: ${errorMessage(e)}`);
        }
        await recorder.settle(400);
      };
      if (opts.mode) await setOption('mode', opts.mode);
      if (opts.model) await setOption('model', opts.model);
      if (opts.autopilot !== 'keep') await setOption('autopilot', opts.autopilot);

      // 6a. MCP probes that need the session but no prompt
      if (opts.clientSteering) {
        await recorder.settle(800, 5000);
        mcpSummary.clientSteering = { sent: probeSteering().map((d) => d.name), listed: mcpObserver.clientDocuments };
        if (!mcpObserver.clientDocuments.some((d) => str(d.uri)?.endsWith(`:${MCP_STEERING_NAME}`)))
          finding(`P2: no _kiro/steering/documents_changed listed ${MCP_STEERING_NAME} with a client: uri`);
      }
      if (opts.mcpConfig) {
        log(`  P1: waiting for the status of ${P1_SERVER}`);
        const entry = await mcpObserver.waitFor(P1_SERVER, (e) => e.status !== 'connecting', 60_000);
        if (!entry) finding(`P1: no settled _kiro/mcp/status entry for ${P1_SERVER} within 60 s`);
      }
      if (opts.mcpLiveReload) {
        log(`  P3: adding ${P3_SERVER} to mcp.json`);
        const added = Date.now();
        mcpFile.write(P3_SERVER, catalogEntry(P3_SERVER));
        recorder.note(`P3: added ${P3_SERVER} to the temp workspace mcp.json`);
        const entry = await mcpObserver.waitFor(P3_SERVER, () => true, 30_000);
        mcpSummary.liveReload = { server: P3_SERVER, firstStatusAfterMs: entry ? Date.now() - added : null, entry };
        if (!entry) finding(`P3: no _kiro/mcp/status named ${P3_SERVER} within 30 s of adding it (no live reload?)`);
      }
      if (signIn) {
        // P4 and P5: the server reports that it needs a sign-in, then Kiro Studio's Sign-in button is played.
        const name = signIn.id;
        log(`  P4: waiting for the status of ${name}`);
        const before = await mcpObserver.waitFor(
          name,
          (e) => e.status === 'failed' || e.status === 'connected',
          60_000,
        );
        if (!before) finding(`P4: no failed or connected status for ${name} within 60 s`);
        if (before?.status === 'connected') finding(`P4: ${name} was already connected; startOAuth signs in again`);
        const reset = async (params: Json): Promise<Json> => {
          const started = Date.now();
          try {
            const result = await withTimeout(
              cx.request<unknown, Json>('_kiro/mcp/resetServer', params),
              75_000,
              'reset',
            );
            return { params, ms: Date.now() - started, result };
          } catch (e) {
            return { params, ms: Date.now() - started, error: describeError(e) };
          }
        };
        log(`  -> _kiro/mcp/resetServer ${name} startOAuth (not advertised)`);
        const resets = [await reset({ sessionId, serverName: name, startOAuth: true })];
        // Kiro Studio retries once without the session (not after "method not found" or the governance error). The
        // probe retries after any error but "method not found", so that both answers are recorded.
        const firstError = rec(resets[0]?.error);
        if (resets[0]?.error !== undefined && firstError.code !== -32601) {
          resets.push(await reset({ serverName: name, startOAuth: true }));
        }
        if (secrets) {
          log(`  P5: waiting up to ${opts.signInWaitSec} s for you to finish the sign-in`);
          signedIn =
            (await mcpObserver.waitFor(name, (e) => e.status === 'connected', opts.signInWaitSec * 1000)) !== undefined;
          if (!signedIn)
            finding(`P5: ${name} did not connect within ${opts.signInWaitSec} s; the restart check is skipped`);
        } else {
          await recorder.settle(1000, 10_000);
        }
        mcpSummary.signIn = {
          server: name,
          before: before ?? null,
          resets,
          pagesRequested: mcpObserver.externalUrls,
          after: mcpObserver.latest(name) ?? null,
        };
        if (mcpObserver.externalUrls.length === 0) finding(`P4: Kiro did not ask to open a sign-in page for ${name}`);
      }
      if (echo) {
        log(`  P6: waiting for the status of ${P6_SERVER}`);
        const entry = await mcpObserver.waitFor(P6_SERVER, (e) => e.status !== 'connecting', 30_000);
        mcpSummary.envExpansion = {
          variable: P6_VARIABLE,
          verdict: expansionVerdict(echo.seen),
          requests: echo.seen,
          status: entry ?? null,
        };
      }

      // 6b. One prompt
      if (!opts.noPrompt && loggedIn) {
        log(`  -> session/prompt "${opts.prompt}"`);
        const started = Date.now();
        const prompt: acp.ContentBlock[] = [{ type: 'text', text: opts.prompt }];
        if (opts.clientSteering) {
          // P2: the hidden block Kiro Studio falls back to while its steering document is not confirmed.
          prompt.push({
            type: 'resource',
            resource: {
              uri: 'kiro-studio://instructions/probe',
              mimeType: 'text/markdown',
              text: `Whatever else you do, also write the word ${P2_RESOURCE_WORD} once in your answer.`,
            },
          });
        }
        const turn = cx.request(acp.methods.agent.session.prompt, { sessionId, prompt });
        try {
          const result = await withTimeout(turn, opts.timeoutSec * 1000, 'session/prompt');
          summary.prompt = { stopReason: result.stopReason, ms: Date.now() - started, response: recorder.safe(result) };
          log(`     stopReason: ${result.stopReason} after ${Date.now() - started} ms`);
        } catch (e) {
          summary.prompt = { error: describeError(e), ms: Date.now() - started };
          finding(`prompt did not complete cleanly: ${errorMessage(e)}`);
          if (String(errorMessage(e)).includes('timed out')) {
            await cx.notify(acp.methods.agent.session.cancel, { sessionId });
            await withTimeout(
              turn.catch(() => undefined),
              10_000,
              'cancel',
            ).catch(() => finding('turn did not end within 10 s of session/cancel'));
          }
        }
        await recorder.settle(600);
        if (opts.clientSteering) {
          mcpSummary.answerHas = {
            [`${P2_STEERING_WORD} (steering document)`]: answerText.includes(P2_STEERING_WORD),
            [`${P2_RESOURCE_WORD} (hidden resource block)`]: answerText.includes(P2_RESOURCE_WORD),
          };
        }
      }

      // 6c. P2: what Kiro replays of that prompt when the session is loaded again
      if (opts.clientSteering && summary.prompt !== undefined && caps.loadSession === true) {
        if (sessionCaps.close) {
          await withTimeout(cx.request(acp.methods.agent.session.close, { sessionId }), 15_000, 'session/close').catch(
            (e: unknown) => finding(`P2: session/close before the load failed: ${errorMessage(e)}`),
          );
        }
        log('  -> session/load (P2: is the hidden block replayed?)');
        try {
          await withTimeout(
            cx.request(acp.methods.agent.session.load, {
              sessionId,
              cwd: workDir,
              mcpServers: [],
              ...(steeringMeta ? { _meta: steeringMeta } : {}),
            }),
            120_000,
            'session/load',
          );
          await recorder.settle(600);
          mcpSummary.replayedUserContent = replayedUserContent;
          // Kiro Studio drops replayed resource blocks and strips its marker from text; which one applies matters.
          const replayedAs = replayedUserContent.filter((c) => c.hasHiddenWord === true).map((c) => String(c.type));
          if (replayedAs.length > 0)
            finding(`P2: Kiro replays the hidden block after session/load, as ${[...new Set(replayedAs)].join(', ')}`);
        } catch (e) {
          finding(`P2: session/load failed: ${errorMessage(e)}`);
        }
      }

      // 6d. Read-only calls, strictly limited to what the agent advertised
      if (sessionCaps.list) {
        try {
          log('  -> session/list');
          summary.sessionList = recorder.safe(
            await withTimeout(cx.request(acp.methods.agent.session.list, { cwd: workDir }), 20_000, 'session/list'),
          );
        } catch (e) {
          summary.sessionList = { error: describeError(e) };
        }
      }
      if (opts.extensions) {
        const results: Json = {};
        for (const method of READ_ONLY_EXTENSIONS) {
          if (!extensionMethods.includes(method)) continue;
          for (const params of [{ sessionId }, {}]) {
            try {
              log(`  -> ${method} ${JSON.stringify(params).slice(0, 40)}`);
              results[method] = {
                params,
                result: recorder.safe(await withTimeout(cx.request<unknown, Json>(method, params), 20_000, method)),
              };
              break;
            } catch (e) {
              results[method] = { params, error: describeError(e) };
            }
          }
        }
        summary.extensionCalls = results;
        summary.extensionMethodsNotCalled = extensionMethods.filter((m) => !READ_ONLY_EXTENSIONS.includes(m));
      }
      await recorder.settle(300);

      summary.sessionState = recorder.safe({
        configOptions: arr(configOptions)
          .map(rec)
          .map((o) => ({
            id: o.id,
            category: o.category,
            type: o.type,
            currentValue: o.currentValue,
            values: arr(o.options)
              .map(rec)
              .map((v) => v.value),
          })),
        commands: arr(commands)
          .map(rec)
          .map((c) => ({ name: c.name, type: str(rec(rec(c._meta).kiro).type), hint: str(rec(c.input).hint) })),
        kiroUpdateKinds: [...kiroKinds].sort(),
        unknownUpdateTypes: [...unknownUpdates],
        otherNotificationMethods: [...extraNotifications].sort(),
        toolCalls: Object.fromEntries(toolCalls),
        latestContextUsage,
        replayFlagSeen,
      });
      summary.permissions = recorder.safe(permissions);

      if (sessionCaps.close) {
        try {
          await withTimeout(cx.request(acp.methods.agent.session.close, { sessionId }), 15_000, 'session/close');
        } catch (e) {
          finding(`session/close failed: ${errorMessage(e)}`);
        }
      }
    });

    // 7. Shut down ------------------------------------------------------------------------
    proc.stdin.end();
    const stdinClosedAt = recorder.elapsed();
    await Promise.race([exitPromise, sleep(opts.exitWaitSec * 1000)]);
    const exitedOnStdinClose = exited !== undefined;
    if (!exited) {
      finding(`process did not exit within ${opts.exitWaitSec} s after stdin closed; killing the process tree`);
      await killTree(proc);
      await Promise.race([exitPromise, sleep(3000)]);
    }
    summary.process = { exitedOnStdinClose, stdinClosedAtMs: stdinClosedAt, exit: exited ?? null };

    // 7b. P5: start the CLI again with the same secrets; is the server still signed in?
    if (secrets && signIn && signedIn) {
      log('  P5: starting kiro-cli again to see whether the sign-in survived');
      const restart = await restartCheck({ cli, opts, workDir, env, recorder, secrets, server: signIn.id });
      mcpSummary.restart = restart;
      if (restart.survived !== true) finding(`P5: ${signIn.id} was not signed in after the restart`);
    }
    if (secrets) mcpSummary.secrets = { keys: secrets.keys, operations: secrets.operations };
    if (mcpProbe) {
      mcpSummary.statusSnapshots = mcpObserver.snapshots;
      mcpSummary.mcpJson = { servers: mcpFile.names };
    }

    // 8. What actually happened on disk and through the client capabilities -----------------
    summary.workDirContents = recorder.safe(
      fs.readdirSync(workDir).map((name) => {
        const full = path.join(workDir, name);
        const stat = fs.statSync(full);
        return {
          name,
          bytes: stat.size,
          ...(stat.isFile() && stat.size <= 2048 ? { content: fs.readFileSync(full, 'utf8') } : {}),
        };
      }),
    );
    const usedByAgent = (m: string) => [...recorder.observed.keys()].some((k) => k === `agent→client request ${m}`);
    summary.clientCapabilityUsage = {
      'fs/read_text_file': usedByAgent('fs/read_text_file'),
      'fs/write_text_file': usedByAgent('fs/write_text_file'),
      'terminal/create': usedByAgent('terminal/create'),
      advertised: clientCapabilities,
    };
    log(
      `  kiro used fs/write_text_file: ${String(usedByAgent('fs/write_text_file'))}, fs/read_text_file: ${String(usedByAgent('fs/read_text_file'))}, terminal/create: ${String(usedByAgent('terminal/create'))}`,
    );

    if (opts.includeKiroLog) {
      for (const candidate of kiroLogCandidates()) {
        if (!fs.existsSync(candidate)) continue;
        const tail = fs.readFileSync(candidate, 'utf8').split(/\r?\n/).slice(-200).join('\n');
        fs.writeFileSync(path.join(outDir, 'kiro-chat.tail.log'), opts.redact ? redactText(tail) : tail);
      }
    }
    summary.kiroLogCandidates = recorder.safe(kiroLogCandidates().map((p) => ({ path: p, exists: fs.existsSync(p) })));
  } catch (e) {
    exitCode = 1;
    finding(`probe failed: ${errorMessage(e)}`);
    summary.fatal = describeError(e);
    if (child) await killTree(child);
  } finally {
    await echo?.close();
    if (summary.process === undefined) {
      await sleep(300); // give a crashed child a moment to report its exit status
      summary.process = { exit: exited ?? null };
    }
    if (!opts.keepDir) fs.rmSync(workDir, { recursive: true, force: true });
    finish();
    log(`\nWrote ${path.join(outDir, 'summary.json')} and wire.ndjson`);
    if (findings.length) log(`${findings.length} finding(s); see summary.json`);
    log('Review the logs before sharing them: redaction is best effort.');
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${errorMessage(e)}\n`);
    process.exit(1);
  },
);
