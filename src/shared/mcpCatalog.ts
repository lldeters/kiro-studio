/**
 * Kiro Studio's own list of MCP servers, and how a proposal from Kiro compares with it.
 *
 * Every entry was checked against a source the vendor controls (its repository, its documentation, or its entry in
 * the MCP Registry under a name the vendor had to prove it owns) on the date in `checked`. The list goes into Kiro's
 * instructions, so that Kiro proposes these addresses in the first place, and every proposal is compared with it:
 * a known address is written exactly as listed here, a known name with a different address is flagged, and anything
 * else is shown as not in the list. Left out on purpose: Slack, Asana, HubSpot, Box, Figma and Vercel (their sign-in
 * needs an OAuth app of the user's own, or only lets in clients they approved), PayPal (its sources disagree), and every
 * deprecated `/sse` endpoint. Pure data and functions, because the webview shows the badges too.
 */
import type { McpProposal, McpSecretSpec } from './mcpProposal';

export const MCP_CATALOG_CHECKED = '2026-10-27';

export interface McpCatalogEntry {
  /** The server name written to mcp.json, unless Kiro chose another. */
  id: string;
  title: string;
  /** Other names people use for it, lowercase. A proposal with one of these names is compared with this entry. */
  aliases: readonly string[];
  url?: string;
  headers?: Readonly<Record<string, string>>;
  oauthScopes?: readonly string[];
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  secrets?: readonly McpSecretSpec[];
  /** How the user gets access: not at all, in the browser after adding, or with a key Kiro Studio asks for. */
  signIn: 'none' | 'browser' | 'key';
  /** The vendor's hosts. A proposal with this entry's name and another host gets the "address differs" warning. */
  hosts: readonly string[];
  /** Where the address was checked. */
  source: string;
  checked: string;
}

const checked = MCP_CATALOG_CHECKED;
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers?search=';

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // On the web, no sign-in
  {
    id: 'microsoft-learn',
    title: 'Microsoft Learn',
    aliases: ['ms-learn', 'microsoft-docs'],
    url: 'https://learn.microsoft.com/api/mcp',
    signIn: 'none',
    hosts: ['learn.microsoft.com'],
    source: 'https://github.com/MicrosoftDocs/mcp',
    checked,
  },
  {
    id: 'aws-knowledge',
    title: 'AWS Knowledge',
    aliases: [],
    url: 'https://knowledge-mcp.global.api.aws',
    signIn: 'none',
    hosts: ['knowledge-mcp.global.api.aws'],
    source: 'https://github.com/awslabs/mcp/tree/main/src/aws-knowledge-mcp-server',
    checked,
  },
  {
    id: 'cloudflare-docs',
    title: 'Cloudflare Docs',
    aliases: ['cloudflare-documentation'],
    url: 'https://docs.mcp.cloudflare.com/mcp',
    signIn: 'none',
    hosts: ['docs.mcp.cloudflare.com'],
    source: 'https://github.com/cloudflare/mcp-server-cloudflare',
    checked,
  },
  {
    // An optional key only raises the rate limit, so none is asked for.
    id: 'context7',
    title: 'Context7',
    aliases: [],
    url: 'https://mcp.context7.com/mcp',
    signIn: 'none',
    hosts: ['mcp.context7.com'],
    source: 'https://github.com/upstash/context7',
    checked,
  },
  // On the web, sign-in in the browser (OAuth with dynamic client registration)
  {
    // `?login` asks for the sign-in; without it the server is anonymous, with fewer tools.
    id: 'huggingface',
    title: 'Hugging Face',
    aliases: ['hugging-face', 'hf'],
    url: 'https://huggingface.co/mcp?login',
    signIn: 'browser',
    hosts: ['huggingface.co'],
    source: 'https://github.com/huggingface/hf-mcp-server',
    checked,
  },
  {
    id: 'notion',
    title: 'Notion',
    aliases: [],
    url: 'https://mcp.notion.com/mcp',
    signIn: 'browser',
    hosts: ['mcp.notion.com'],
    source: 'https://github.com/makenotion/notion-mcp-server',
    checked,
  },
  {
    // The address is in the registry under Linear's verified domain; only an API-key header is undocumented, and
    // none is used.
    id: 'linear',
    title: 'Linear',
    aliases: [],
    url: 'https://mcp.linear.app/mcp',
    signIn: 'browser',
    hosts: ['mcp.linear.app'],
    source: `${REGISTRY}app.linear/linear`,
    checked,
  },
  {
    // An Atlassian admin can limit which OAuth clients may connect (the domain allowlist).
    id: 'atlassian',
    title: 'Jira and Confluence',
    aliases: ['jira', 'confluence', 'rovo', 'atlassian-rovo'],
    url: 'https://mcp.atlassian.com/v2/mcp',
    signIn: 'browser',
    hosts: ['mcp.atlassian.com'],
    source: 'https://github.com/atlassian/atlassian-mcp-server',
    checked,
  },
  {
    id: 'sentry',
    title: 'Sentry',
    aliases: [],
    url: 'https://mcp.sentry.dev/mcp',
    signIn: 'browser',
    hosts: ['mcp.sentry.dev'],
    source: 'https://github.com/getsentry/sentry-mcp',
    checked,
  },
  {
    id: 'supabase',
    title: 'Supabase',
    aliases: [],
    url: 'https://mcp.supabase.com/mcp',
    signIn: 'browser',
    hosts: ['mcp.supabase.com'],
    source: 'https://github.com/supabase-community/supabase-mcp',
    checked,
  },
  {
    id: 'neon',
    title: 'Neon',
    aliases: [],
    url: 'https://mcp.neon.tech/mcp',
    signIn: 'browser',
    hosts: ['mcp.neon.tech'],
    source: 'https://github.com/neondatabase/mcp-server-neon',
    checked,
  },
  {
    id: 'stripe',
    title: 'Stripe',
    aliases: [],
    url: 'https://mcp.stripe.com',
    signIn: 'browser',
    hosts: ['mcp.stripe.com'],
    source: 'https://github.com/stripe/ai',
    checked,
  },
  {
    id: 'zapier',
    title: 'Zapier',
    aliases: [],
    url: 'https://mcp.zapier.com/api/v1/connect',
    signIn: 'browser',
    hosts: ['mcp.zapier.com'],
    source: 'https://github.com/zapier/zapier-mcp',
    checked,
  },
  {
    id: 'monday',
    title: 'monday.com',
    aliases: ['monday-com', 'mondaycom'],
    url: 'https://mcp.monday.com/mcp',
    signIn: 'browser',
    hosts: ['mcp.monday.com'],
    source: 'https://github.com/mondaycom/mcp',
    checked,
  },
  {
    // The whole Cloudflare API; it replaces the per-product servers, which are deprecated.
    id: 'cloudflare',
    title: 'Cloudflare',
    aliases: ['cloudflare-api'],
    url: 'https://mcp.cloudflare.com/mcp',
    signIn: 'browser',
    hosts: ['mcp.cloudflare.com'],
    source: 'https://github.com/cloudflare/mcp',
    checked,
  },
  {
    // gitlab.com only; the top-level group has to allow access to the MCP server.
    id: 'gitlab',
    title: 'GitLab',
    aliases: [],
    url: 'https://gitlab.com/api/v4/mcp',
    oauthScopes: ['mcp'],
    signIn: 'browser',
    hosts: ['gitlab.com'],
    source: 'https://gitlab.com/gitlab-org/gitlab/-/blob/master/doc/user/model_context_protocol/mcp_server.md',
    checked,
  },
  // On the web, with a key: GitHub only signs in clients that bring their own OAuth app, so it takes a personal token.
  {
    id: 'github',
    title: 'GitHub',
    aliases: ['gh'],
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
    secrets: [
      {
        name: 'GITHUB_TOKEN',
        label: 'GitHub fine-grained personal access token',
        help: 'https://github.com/settings/personal-access-tokens/new',
      },
    ],
    signIn: 'key',
    hosts: ['api.githubcopilot.com'],
    source: 'https://github.com/github/github-mcp-server',
    checked,
  },
  // Programs on this computer
  {
    id: 'playwright',
    title: 'Playwright',
    aliases: [],
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    signIn: 'none',
    hosts: [],
    source: 'https://github.com/microsoft/playwright-mcp',
    checked,
  },
  {
    id: 'chrome-devtools',
    title: 'Chrome DevTools',
    aliases: ['chrome-dev-tools'],
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    signIn: 'none',
    hosts: [],
    source: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    checked,
  },
  {
    id: 'fetch',
    title: 'Fetch',
    aliases: [],
    command: 'uvx',
    args: ['mcp-server-fetch'],
    signIn: 'none',
    hosts: [],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    checked,
  },
  {
    id: 'memory',
    title: 'Memory',
    aliases: [],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    signIn: 'none',
    hosts: [],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    checked,
  },
  {
    id: 'aws-docs',
    title: 'AWS Documentation',
    aliases: ['aws-documentation'],
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
    env: { FASTMCP_LOG_LEVEL: 'ERROR' },
    signIn: 'none',
    hosts: [],
    source: 'https://github.com/awslabs/mcp',
    checked,
  },
];

/** What Kiro is told to propose for an entry, and what a dialog calls the known address: the URL or the command line. */
export const catalogTarget = (entry: McpCatalogEntry): string =>
  entry.url ?? [entry.command ?? '', ...(entry.args ?? [])].join(' ');

/** An entry as a proposal under the given name, which is what is written when Kiro proposed a known server. */
export function catalogProposal(entry: McpCatalogEntry, name = entry.id): McpProposal {
  const secrets = (entry.secrets ?? []).map((secret) => ({ ...secret }));
  if (entry.url !== undefined) {
    return {
      name,
      title: entry.title,
      transport: 'http',
      url: entry.url,
      ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      ...(entry.oauthScopes ? { oauthScopes: [...entry.oauthScopes] } : {}),
      secrets,
      source: entry.source,
    };
  }
  return {
    name,
    title: entry.title,
    transport: 'stdio',
    command: entry.command ?? '',
    args: [...(entry.args ?? [])],
    ...(entry.env ? { env: { ...entry.env } } : {}),
    secrets,
    source: entry.source,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing a proposal with the list
// ---------------------------------------------------------------------------------------------------------------

/**
 * - `known`: the address (or the command line) is one in the list.
 * - `mismatch`: the name is one in the list, but the address points elsewhere. This is what a misled Kiro would
 *   produce, so the user has to choose between the known address and Kiro's.
 * - `unlisted`: a server on the web that the list does not know.
 * - `program`: a program on this computer that the list does not know.
 */
export type McpTrustLevel = 'known' | 'mismatch' | 'unlisted' | 'program';

/**
 * - `punycode`: the host has an international label (`xn--`), which can imitate another name.
 * - `ipHost`: the host is an IP address rather than a name; `loopback`: it is this computer.
 * - `shell`: the program is a shell, which can run anything.
 * - `downloads`: the program fetches a package and runs it (`npx`, `uvx`, `docker run`…).
 */
export type McpRiskFlag = 'punycode' | 'ipHost' | 'loopback' | 'shell' | 'downloads';

export interface McpAssessment {
  level: McpTrustLevel;
  flags: McpRiskFlag[];
  /** For `known` the entry that is written, for `mismatch` the entry whose address Kiro's differs from. */
  entry?: McpCatalogEntry;
}

/**
 * An address in a form that compares equal when only spelling differs: scheme and host in lower case, no default port,
 * no trailing slash and no fragment. Path and query are kept, because they choose the server (`/mcp?login`). Undefined
 * for text that is not an address.
 */
export function normaliseUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return undefined;
  }
}

/** The host of an address in lower case (international names in their `xn--` form), or undefined. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Whether a host has an international label. URL parsing writes such labels as `xn--…`. */
export const hasPunycode = (host: string): boolean =>
  host.split('.').some((label) => label.toLowerCase().startsWith('xn--'));

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'dnx']);
/** Package managers that fetch and run a package with a sub-command: `docker run`, `pnpm dlx`, `npm exec`. */
const RUNNER_COMMANDS: Readonly<Record<string, string>> = {
  docker: 'run',
  podman: 'run',
  pnpm: 'dlx',
  yarn: 'dlx',
  npm: 'exec',
  pipx: 'run',
};

/** `C:\tools\npx.cmd` → `npx`. */
const programName = (command: string): string =>
  (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

/** `npx -y x` runs the same package as `npx x`; `-y` only skips the question whether to install it. */
function commandKey(command: string, args: readonly string[]): string {
  const program = programName(command);
  const rest = program === 'npx' ? args.filter((arg) => arg !== '-y' && arg !== '--yes') : args;
  return JSON.stringify([program, ...rest]);
}

const downloads = (program: string, args: readonly string[]): boolean =>
  RUNNERS.has(program) || (RUNNER_COMMANDS[program] !== undefined && args[0] === RUNNER_COMMANDS[program]);

/**
 * The package a program fetches and runs, without its version: `npx -y @playwright/mcp@latest` → `@playwright/mcp`.
 * Undefined when the program fetches nothing, or when the package cannot be told from the arguments (`docker run`
 * takes options with values before the image).
 */
export function downloadedPackage(proposal: McpProposal): string | undefined {
  if (proposal.transport !== 'stdio') return undefined;
  const program = programName(proposal.command ?? '');
  let args = proposal.args ?? [];
  if (!downloads(program, args) || program === 'docker' || program === 'podman') return undefined;
  if (RUNNER_COMMANDS[program] !== undefined && args[0] === RUNNER_COMMANDS[program]) args = args.slice(1);
  let found: string | undefined;
  for (let index = 0; index < args.length && found === undefined; index++) {
    const arg = args[index] ?? '';
    const named = /^--(?:package|from)=(.+)$/.exec(arg);
    if (named) found = named[1];
    else if (arg === '-p' || arg === '--package' || arg === '--from') found = args[index + 1];
    else if (!arg.startsWith('-')) found = arg;
  }
  return found === undefined || found === '' ? undefined : withoutVersion(found);
}

/** `@scope/name@1.2.3` → `@scope/name`, `name@latest` → `name`, `name==1.0` → `name`. */
function withoutVersion(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const name = at > 0 ? spec.slice(0, at) : spec;
  return name.split(/[=<>~!]/)[0] ?? name;
}

function riskFlags(proposal: McpProposal): McpRiskFlag[] {
  const flags: McpRiskFlag[] = [];
  if (proposal.transport === 'http') {
    const host = hostOf(proposal.url ?? '') ?? '';
    if (hasPunycode(host)) flags.push('punycode');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) flags.push('ipHost');
    if (LOOPBACK.has(host)) flags.push('loopback');
  } else {
    const program = programName(proposal.command ?? '');
    if (SHELLS.has(program)) flags.push('shell');
    if (downloads(program, proposal.args ?? [])) flags.push('downloads');
  }
  return flags;
}

/** The names a proposal goes by: its name and its title as a name, with and without a trailing `-mcp` or `-server`. */
function namesOf(proposal: McpProposal): Set<string> {
  const names = new Set<string>();
  const title = proposal.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  for (const name of [proposal.name, title]) {
    if (name === '') continue;
    names.add(name);
    names.add(name.replace(/(-mcp)?(-server)?$/, ''));
  }
  return names;
}

/**
 * The entry a proposal matches: `address` when its URL (after {@link normaliseUrl}) or its command line is one in the
 * list, whatever Kiro named it; otherwise `name` when its name, title or an alias is.
 */
export function matchCatalog(
  proposal: McpProposal,
  catalog: readonly McpCatalogEntry[] = MCP_CATALOG,
): { entry: McpCatalogEntry; by: 'address' | 'name' } | undefined {
  const byAddress = catalog.find((entry) => {
    if (proposal.transport === 'http') {
      return entry.url !== undefined && normaliseUrl(entry.url) === normaliseUrl(proposal.url ?? '');
    }
    return (
      entry.command !== undefined &&
      commandKey(entry.command, entry.args ?? []) === commandKey(proposal.command ?? '', proposal.args ?? [])
    );
  });
  if (byAddress) return { entry: byAddress, by: 'address' };
  const names = namesOf(proposal);
  const byName = catalog.find((entry) => names.has(entry.id) || entry.aliases.some((alias) => names.has(alias)));
  return byName ? { entry: byName, by: 'name' } : undefined;
}

/**
 * How far a proposal can be trusted, for the card's badge and the host's dialog. A known name on the vendor's own host
 * with another path or query (`/mcp/readonly`, `?project_ref=…`) is `unlisted`, not `mismatch`: the address is not in
 * the list, but it does not point away from the vendor either.
 */
export function assessProposal(
  proposal: McpProposal,
  catalog: readonly McpCatalogEntry[] = MCP_CATALOG,
): McpAssessment {
  const flags = riskFlags(proposal);
  const match = matchCatalog(proposal, catalog);
  if (match?.by === 'address') return { level: 'known', flags, entry: match.entry };
  if (match?.by === 'name') {
    const host = proposal.transport === 'http' ? hostOf(proposal.url ?? '') : undefined;
    const vendorHost = host !== undefined && match.entry.url !== undefined && match.entry.hosts.includes(host);
    if (!vendorHost) return { level: 'mismatch', flags, entry: match.entry };
  }
  return { level: proposal.transport === 'stdio' ? 'program' : 'unlisted', flags };
}
