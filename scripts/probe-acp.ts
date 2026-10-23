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
 * Safety: the probe's working directory is a fresh temp folder. Permission requests are
 * granted once, and only when every path they mention is inside that folder.
 * Raw logs are redacted on a best-effort basis (tokens, e-mail addresses, home directory);
 * read them before sharing them.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { createRedactor } from '../src/util/redact.js';

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

  /** `direction` is from the client's point of view: out = client→agent, in = agent→client. */
  wireLine(direction: 'out' | 'in', line: string): void {
    if (direction === 'in') this.lastIncoming = Date.now();
    let entry: Json;
    try {
      const msg = rec(JSON.parse(line));
      this.count(`${direction === 'out' ? 'client→agent' : 'agent→client'} ${this.label(msg, direction)}`);
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

    // 2. Spawn the ACP server ------------------------------------------------------------
    const env = { ...process.env, ...(opts.kiroDebug ? { KIRO_LOG_LEVEL: 'debug' } : {}) };
    const proc = spawn(cli, opts.acpArgs, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    child = proc;
    const toChild = new PassThrough();
    toChild.pipe(proc.stdin);
    toChild.on(
      'data',
      lineSplitter((line) => recorder.wireLine('out', line)),
    );
    proc.stdout.on(
      'data',
      lineSplitter((line) => recorder.wireLine('in', line)),
    );
    proc.stderr.on(
      'data',
      lineSplitter((line) => recorder.stderrLine(line)),
    );
    proc.stdin.on('error', () => {
      /* the exit handler reports the crash */
    });

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

    // 3. State fed by the notification dispatcher ----------------------------------------
    let sessionId = '';
    let configOptions: unknown[] = [];
    let commands: unknown[] = [];
    const toolCalls = new Map<string, { title?: string; kind?: string; statuses: string[]; hasDiff: boolean }>();
    const unknownUpdates = new Set<string>();
    const kiroKinds = new Set<string>();
    const extraNotifications = new Set<string>();
    let latestContextUsage: unknown;
    let replayFlagSeen = false;

    const onNotification = (msg: acp.AnyNotification): void => {
      const params = rec(msg.params);
      if (msg.method !== 'session/update') {
        extraNotifications.add(msg.method);
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

    // The SDK would strictly validate every session/update and silently drop the ones it does not know
    // (see docs/protocol-notes.md). So notifications never reach it: they are diverted here, while the
    // SDK keeps handling responses and agent->client requests. `$/` methods stay with the SDK.
    const rawStream = acp.ndJsonStream(
      Writable.toWeb(toChild) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const stream: acp.Stream = {
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
              onNotification(message as acp.AnyNotification);
            } catch (e) {
              recorder.note('notification handler failed', describeError(e));
            }
          },
        }),
      ),
    };

    // 4. Client handlers (agent -> client requests) --------------------------------------
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
          return {};
        },
      );

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

    // 5. The conversation -----------------------------------------------------------------
    const clientCapabilities = {
      ...(opts.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
      ...(opts.terminal ? { terminal: true } : {}),
      _meta: { kiro: { openExternalUrl: true, ...(opts.hooks ? { hooks: { enabled: true, v2: true } } : {}) } },
    };

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
        cx.request(acp.methods.agent.session.new, { cwd: workDir, mcpServers: [] }),
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

      // 5a. One prompt
      if (!opts.noPrompt && loggedIn) {
        log(`  -> session/prompt "${opts.prompt}"`);
        const started = Date.now();
        const turn = cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: opts.prompt }],
        });
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
      }

      // 5b. Read-only calls, strictly limited to what the agent advertised
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

    // 6. Shut down ------------------------------------------------------------------------
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

    // 7. What actually happened on disk and through the client capabilities -----------------
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
