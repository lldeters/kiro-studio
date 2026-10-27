/**
 * MCP servers that Kiro proposes in the chat.
 *
 * Kiro is taught (`src/workspace/mcpInstructions.ts`) to answer "add the Linear MCP server" with a fenced code block
 * whose info string is `kiro-mcp` and which holds one JSON object. The webview shows such a block as a card, and the
 * host writes the server only after the user confirmed it in a native dialog. A block is model output, so everything
 * in it is untrusted: this module finds the blocks and checks them strictly, and the host runs the same check again
 * on the text it keeps itself, never on anything the webview sends. Pure, because the host and the webview bundle
 * both use it.
 */

export const PROPOSAL_LANGUAGE = 'kiro-mcp';

const MAX_BLOCK_CHARS = 8_000;
const MAX_URL_CHARS = 2_048;
const MAX_SECRETS = 4;
const MAX_NAME_CHARS = 48;
const MAX_TITLE_CHARS = 60;
const MAX_LABEL_CHARS = 80;
const MAX_LINK_CHARS = 500;
const MAX_COMMAND_CHARS = 200;
const MAX_ARGS = 40;
const MAX_ARG_CHARS = 1_000;
const MAX_MAP_ENTRIES = 10;
const MAX_VALUE_CHARS = 1_000;
const MAX_SCOPES = 20;

/** A value only the user can provide, such as an API key. Kiro declares it; Kiro Studio asks for it. */
export interface McpSecretSpec {
  /** Upper snake case, for example `GITHUB_TOKEN`. The block refers to it as `${GITHUB_TOKEN}`. */
  name: string;
  /** What it is, shown to the user. At most 80 characters. */
  label: string;
  /** An https page where the user creates it. */
  help?: string;
}

export interface McpProposal {
  /** The key in `mcpServers`: lowercase letters, digits and dashes. Made from the title when Kiro gave none. */
  name: string;
  /** At most 60 characters; the name when Kiro gave none. */
  title: string;
  /** Worked out from the fields, as Kiro does: a `url` is a server on the web, a `command` a program. */
  transport: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  oauthScopes?: string[];
  command?: string;
  /** Always present for a program, possibly empty. */
  args?: string[];
  env?: Record<string, string>;
  /** At most four, unique, each one referred to somewhere. */
  secrets: McpSecretSpec[];
  /** An https link to the vendor page that documents the server. Left out when it is not one. */
  source?: string;
}

export type ProposalError =
  | 'json'
  | 'tooLarge'
  | 'name'
  | 'transport'
  | 'insecureUrl'
  | 'urlSecret'
  | 'command'
  | 'literalSecret'
  | 'secretSpec'
  | 'unusedSecret'
  | 'undeclaredReference'
  | 'duplicateName';

export type ProposalResult = { ok: true; proposal: McpProposal } | { ok: false; error: ProposalError };

export interface ExtractedProposal {
  /** The text between the fences, without the indentation of the block. */
  raw: string;
  result: ProposalResult;
}

/**
 * What goes into `mcpServers.<name>` of an mcp.json file. It never holds `disabled`, `autoApprove`, `disabledTools`,
 * `timeout` or `type`: whether a server runs and which tools it may use without asking is not Kiro's to choose.
 */
export type McpConfigEntry =
  | { url: string; headers?: Record<string, string>; oauthScopes?: string[] }
  | { command: string; args: string[]; env?: Record<string, string> };

/** Whether the info word of a code block marks a proposal. The webview and `extractProposals` use the same rule. */
export const isProposalLanguage = (language: string | undefined): boolean =>
  language?.toLowerCase() === PROPOSAL_LANGUAGE;

// ---------------------------------------------------------------------------------------------------------------
// Finding the blocks
// ---------------------------------------------------------------------------------------------------------------

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * The `kiro-mcp` blocks of an answer, in order. Only closed blocks count: an open one is still being streamed, or Kiro
 * stopped in the middle of it. Fences follow CommonMark closely enough to agree with the webview's Markdown renderer:
 * backticks or tildes, three or more, indented by any amount (blocks inside list items count), closed by a fence of the
 * same character that is at least as long. Other code blocks are skipped as a whole, so a `kiro-mcp` example quoted
 * inside one is not a proposal. Blocks that share a name are all marked `duplicateName`: none of them can be added,
 * because the host could not tell which one the user meant.
 */
export function extractProposals(markdown: string): ExtractedProposal[] {
  const lines = markdown.split(/\r?\n/);
  const found: ExtractedProposal[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index] ?? '');
    if (!open) continue;
    const [, indent = '', fence = '', info = ''] = open;
    // A backtick fence cannot have a backtick in its info string; such a line is inline code, not a fence.
    if (fence.startsWith('`') && info.includes('`')) continue;
    const close = closingLine(lines, index + 1, fence);
    if (close === undefined) break; // an open block runs to the end of the text
    if (isProposalLanguage(info.trim().split(/\s+/)[0])) {
      const raw = lines
        .slice(index + 1, close)
        .map((line) => dedent(line, indent.length))
        .join('\n');
      found.push({ raw, result: parseProposal(raw) });
    }
    index = close;
  }
  return markDuplicates(found);
}

function closingLine(lines: readonly string[], from: number, fence: string): number | undefined {
  for (let index = from; index < lines.length; index++) {
    const close = FENCE_CLOSE.exec(lines[index] ?? '')?.[1];
    if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) return index;
  }
  return undefined;
}

/** Removes up to `width` characters of leading whitespace, as CommonMark does for the lines of an indented fence. */
function dedent(line: string, width: number): string {
  let cut = 0;
  while (cut < width && cut < line.length && /\s/.test(line.charAt(cut))) cut++;
  return line.slice(cut);
}

function markDuplicates(found: ExtractedProposal[]): ExtractedProposal[] {
  const counts = new Map<string, number>();
  for (const { result } of found) {
    if (result.ok) counts.set(result.proposal.name, (counts.get(result.proposal.name) ?? 0) + 1);
  }
  return found.map((block) =>
    block.result.ok && (counts.get(block.result.proposal.name) ?? 0) > 1
      ? { raw: block.raw, result: { ok: false, error: 'duplicateName' } }
      : block,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Checking one block
// ---------------------------------------------------------------------------------------------------------------

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Names a secret must not have: a declared secret becomes an environment variable of the Kiro process. */
const DENIED_SECRET_NAME =
  /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SHELL|COMSPEC|TEMP|TMP|TMPDIR|NODE_OPTIONS|NODE_PATH|PYTHONPATH|(LD|DYLD|KIRO)_.*)$/;
/** Header, environment and flag names whose value is a secret. Such a value must be a `${NAME}` reference. */
const SECRET_KEY =
  /authorization|token|secret|password|passwd|api[-_]?key|cookie|credential|private|(^|[^a-z])pat([^a-z]|$)/i;
/** Query keys that carry a secret, so that `?api_key=…` is refused while `?project_ref=…&read_only=true` is fine. */
const SECRET_QUERY_KEY = /^(token|key|api[_-]?key|access[_-]?token|auth|secret|password|sig|signature)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** `${NAME}`, the only form of reference Kiro expands. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Control characters, line breaks and the invisible characters that reorder or hide text. None of them belongs in a
 * name, a label, a command or an address, and each could make a dialog line say something other than what is written.
 */
function hasHiddenCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)) return true;
    if ((code >= 0x2066 && code <= 0x2069) || code === 0x2028 || code === 0x2029 || code === 0xfeff) return true;
  }
  return false;
}

/** `${env:X}` is how other clients write a reference; Kiro only expands `${X}`. */
const rewriteEnvReferences = (text: string): string => text.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');

const references = (text: string): string[] => [...text.matchAll(REFERENCE)].map((match) => match[1] ?? '');
const hasReference = (text: string): boolean => references(text).length > 0;

/**
 * A server name from a title: the rule of `slug` in `src/workspace/mcp.ts`, cut to the length a name may have. The
 * webview bundles this file, so it cannot import that module, which pulls in the JSON editor.
 */
function nameFromTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/, '');
}

class Refused extends Error {
  constructor(readonly error: ProposalError) {
    super(error);
  }
}

/** Throws the error code; `parseProposal` turns it into its result. Keeps each rule to one line. */
function refuse(error: ProposalError): never {
  throw new Refused(error);
}

/** A string map with at most ten entries, keys matching `key` and values free of hidden characters. */
function stringMap(value: unknown, key: RegExp, error: ProposalError): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) refuse(error);
  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) refuse(error);
  const result: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (!key.test(name) || typeof text !== 'string' || text.length > MAX_VALUE_CHARS || hasHiddenCharacters(text))
      refuse(error);
    result[name] = rewriteEnvReferences(text);
  }
  return result;
}

/** An https link of at most 500 characters, or undefined. */
function httpsLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_LINK_CHARS || /\s/.test(value) || hasHiddenCharacters(value))
    return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function checkUrl(url: string): void {
  if (url.length > MAX_URL_CHARS) refuse('tooLarge');
  if (/\s/.test(url) || hasHiddenCharacters(url)) refuse('insecureUrl');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse('insecureUrl');
  }
  if (parsed.hostname === '') refuse('insecureUrl');
  // Kiro's own rule: https, or plain http to this computer only.
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)))
    refuse('insecureUrl');
  if (parsed.username !== '' || parsed.password !== '') refuse('urlSecret');
  for (const key of parsed.searchParams.keys()) if (SECRET_QUERY_KEY.test(key)) refuse('urlSecret');
}

function checkSecrets(value: unknown): McpSecretSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SECRETS) refuse('secretSpec');
  const seen = new Set<string>();
  return value.map((spec: unknown): McpSecretSpec => {
    if (!isObject(spec)) refuse('secretSpec');
    const { name, label, help } = spec;
    if (typeof name !== 'string' || !SECRET_NAME.test(name) || DENIED_SECRET_NAME.test(name) || seen.has(name))
      refuse('secretSpec');
    seen.add(name);
    if (typeof label !== 'string' || hasHiddenCharacters(label)) refuse('secretSpec');
    const text = label.trim();
    if (text === '' || text.length > MAX_LABEL_CHARS) refuse('secretSpec');
    if (help !== undefined && httpsLink(help) === undefined) refuse('secretSpec');
    return { name, label: text, ...(typeof help === 'string' ? { help } : {}) };
  });
}

/**
 * Checks one block and turns it into a proposal. Unknown keys are dropped, and so are the keys that are never taken
 * from Kiro (`autoApprove`, `disabledTools`, `disabled`, `type`, `timeout`, `oauth`); `type: "registry"` is refused
 * because such an entry has no address of its own. The rules keep secrets out of the chat and out of mcp.json: a
 * header, environment variable or flag that holds a secret must say `${NAME}`, every `${NAME}` must be declared in
 * `secrets`, so that no proposal can send one of the user's own environment variables to a server, and every declared
 * secret must be used.
 */
export function parseProposal(raw: string): ProposalResult {
  try {
    return { ok: true, proposal: checkProposal(raw) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.error };
    throw error;
  }
}

function checkProposal(raw: string): McpProposal {
  if (raw.length > MAX_BLOCK_CHARS) refuse('tooLarge');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    refuse('json');
  }
  if (!isObject(value)) refuse('json');
  if (value.type === 'registry') refuse('transport');

  if (value.title !== undefined && (typeof value.title !== 'string' || hasHiddenCharacters(value.title)))
    refuse('name');
  const givenTitle = typeof value.title === 'string' ? value.title.trim() : '';
  let name: string;
  if (value.name === undefined) name = nameFromTitle(givenTitle);
  else if (typeof value.name === 'string') name = value.name;
  else refuse('name');
  if (!NAME.test(name)) refuse('name');
  const title = (givenTitle === '' ? name : givenTitle).slice(0, MAX_TITLE_CHARS);

  const hasUrl = value.url !== undefined;
  const hasCommand = value.command !== undefined;
  if (hasUrl === hasCommand) refuse('transport');

  const strings: string[] = [];
  const base = { name, title };
  let proposal: Omit<McpProposal, 'secrets' | 'source'>;
  if (hasUrl) {
    if (typeof value.url !== 'string') refuse('transport');
    const url = rewriteEnvReferences(value.url);
    checkUrl(url);
    const headers = stringMap(value.headers, HEADER_NAME, 'transport');
    const oauthScopes = checkScopes(value.oauthScopes);
    for (const [key, text] of Object.entries(headers ?? {})) {
      if (SECRET_KEY.test(key) && !hasReference(text)) refuse('literalSecret');
    }
    strings.push(url, ...Object.values(headers ?? {}));
    proposal = {
      ...base,
      transport: 'http',
      url,
      ...(headers ? { headers } : {}),
      ...(oauthScopes ? { oauthScopes } : {}),
    };
  } else {
    const { command, args } = checkCommand(value.command, value.args);
    const env = stringMap(value.env, ENV_NAME, 'command');
    for (const [key, text] of Object.entries(env ?? {})) {
      if (SECRET_KEY.test(key) && !hasReference(text)) refuse('literalSecret');
    }
    for (const arg of args) {
      const flag = /^--?([A-Za-z][\w.-]*)=(.*)$/s.exec(arg);
      if (flag && SECRET_KEY.test(flag[1] ?? '') && !hasReference(flag[2] ?? '')) refuse('literalSecret');
    }
    strings.push(command, ...args, ...Object.values(env ?? {}));
    proposal = { ...base, transport: 'stdio', command, args, ...(env ? { env } : {}) };
  }

  const secrets = checkSecrets(value.secrets);
  const declared = new Set(secrets.map((secret) => secret.name));
  const used = new Set(strings.flatMap(references));
  for (const reference of used) if (!declared.has(reference)) refuse('undeclaredReference');
  for (const secret of declared) if (!used.has(secret)) refuse('unusedSecret');

  const source = httpsLink(value.source);
  return { ...proposal, secrets, ...(source === undefined ? {} : { source }) };
}

function checkCommand(command: unknown, args: unknown): { command: string; args: string[] } {
  if (typeof command !== 'string') refuse('command');
  const program = rewriteEnvReferences(command);
  if (program.trim() === '' || program.length > MAX_COMMAND_CHARS || hasHiddenCharacters(program)) refuse('command');
  if (args === undefined) return { command: program, args: [] };
  if (!Array.isArray(args) || args.length > MAX_ARGS) refuse('command');
  return {
    command: program,
    args: args.map((arg: unknown) => {
      if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || hasHiddenCharacters(arg)) refuse('command');
      return rewriteEnvReferences(arg);
    }),
  };
}

function checkScopes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SCOPES) refuse('transport');
  return value.map((scope: unknown) => {
    if (typeof scope !== 'string' || !/^[\x21-\x7e]{1,100}$/.test(scope)) refuse('transport');
    return scope;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

/**
 * A command line as the user would type it, with arguments that contain spaces or quotes in double quotes. The card
 * and the Add dialog show a program this way.
 */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ');
}

/**
 * The environment variable a declared secret is written as: `KIRO_STUDIO_MCP_<SERVER>_<NAME>`. Kiro keeps the value
 * of `GITHUB_TOKEN` in VS Code's secret storage and passes it to the Kiro process under this name, so that it never
 * overrides the user's own `GITHUB_TOKEN` for Kiro and for every program Kiro starts.
 */
export const secretEnvName = (server: string, name: string): string =>
  `KIRO_STUDIO_MCP_${server.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${name}`;

/**
 * The mcp.json entry for a proposal. Each `${NAME}` that `envNames` maps is rewritten to the variable it is written as
 * (see {@link secretEnvName}); without a map the references stay as Kiro wrote them.
 */
export function toConfigEntry(proposal: McpProposal, envNames: Readonly<Record<string, string>> = {}): McpConfigEntry {
  const rename = (text: string): string =>
    text.replace(REFERENCE, (match, name: string) => {
      const target = envNames[name];
      return target === undefined ? match : `\${${target}}`;
    });
  const renameValues = (map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([key, text]) => [key, rename(text)]));
  if (proposal.transport === 'http') {
    return {
      url: rename(proposal.url ?? ''),
      ...(proposal.headers ? { headers: renameValues(proposal.headers) } : {}),
      ...(proposal.oauthScopes ? { oauthScopes: [...proposal.oauthScopes] } : {}),
    };
  }
  return {
    command: rename(proposal.command ?? ''),
    args: (proposal.args ?? []).map(rename),
    ...(proposal.env ? { env: renameValues(proposal.env) } : {}),
  };
}
