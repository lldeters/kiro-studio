/**
 * What happens when the user clicks Add on the card of a proposed MCP server: the native dialog that asks, the entry
 * that is written, the keys Kiro Studio asks for, and how the entry compares with what the files already hold. Pure, so
 * that the host only shows dialogs and writes files.
 *
 * A known server is written exactly as Kiro Studio's list has it, whatever else Kiro put in the block; only Kiro's name
 * for it is kept. When Kiro's name matches the list but its address does not, the user first chooses between the two
 * ({@link planAddressChoice}). A program that is not in the list goes to the user's settings only, and the dialog
 * offers to add it switched off first.
 */
import type { McpAssessment, McpTrustLevel } from '../shared/mcpCatalog';
import { catalogProposal, downloadedPackage } from '../shared/mcpCatalog';
import {
  commandLine,
  secretEnvName,
  toConfigEntry,
  type McpConfigEntry,
  type McpProposal,
} from '../shared/mcpProposal';
import { identityTranslate, type Translate } from '../util/translate';
import { findServerEntry } from '../workspace/mcp';

export { commandLine };

/** How an entry compares with the server of the same name in a file. */
export type Collision = 'none' | 'same' | 'different';

export interface PlanButton<C> {
  label: string;
  choice: C;
}

/** A native modal dialog: `title` is its message, `detail` its lines. Cancel is added by VS Code. */
export interface PlanModal<C> {
  severity: 'info' | 'warning';
  title: string;
  detail: string[];
  buttons: PlanButton<C>[];
}

/** Where an Add button writes, and whether the server is switched off. */
export interface AddTarget {
  scope: 'user' | 'workspace';
  disabled: boolean;
}

/** A key Kiro Studio asks for after the dialog, and the environment variable it is passed to Kiro as. */
export interface PlannedSecret {
  name: string;
  envName: string;
  label: string;
  help?: string;
}

export interface AddPlanInput {
  proposal: McpProposal;
  assessment: McpAssessment;
  /** The user file (`~/.kiro/settings/mcp.json`), read just now, and how the dialog names it. */
  userText: string;
  userFile: string;
  /** The workspace file, when a folder is open and the file exists. */
  workspaceText?: string;
  hasFolder: boolean;
  trusted: boolean;
  autopilot: boolean;
}

export interface AddPlan {
  name: string;
  title: string;
  /** What is written: the list's entry for a known server, Kiro's proposal otherwise. */
  proposal: McpProposal;
  entry: McpConfigEntry;
  secrets: PlannedSecret[];
  modal: PlanModal<AddTarget>;
  /** The entry against the user file. */
  collision: Collision;
  /** The entry against the workspace file, when there is one. */
  workspaceCollision?: Collision;
  /** The workspace file defines the name too, and its entry wins over the user file's. */
  shadowed: boolean;
  /** A name that neither file uses, for "Add as …". */
  alternativeName: string;
}

const MAX_NAME_CHARS = 48;

/** The entry for a proposal under a name, with each declared `${NAME}` rewritten to its namespaced variable. */
export function planEntry(proposal: McpProposal, name: string): { entry: McpConfigEntry; secrets: PlannedSecret[] } {
  const secrets = proposal.secrets.map((secret) => ({
    name: secret.name,
    envName: secretEnvName(name, secret.name),
    label: secret.label,
    ...(secret.help === undefined ? {} : { help: secret.help }),
  }));
  const entry = toConfigEntry(proposal, Object.fromEntries(secrets.map((secret) => [secret.name, secret.envName])));
  return { entry, secrets };
}

/** The keys that say which server an entry is. `disabled`, `autoApprove` and the like are the user's settings for it. */
function identity(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const map = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && Object.keys(value).length > 0 ? value : undefined;
  return {
    url: entry.url,
    headers: map(entry.headers),
    oauthScopes: entry.oauthScopes,
    command: entry.command,
    args: entry.command === undefined ? undefined : (entry.args ?? []),
    env: map(entry.env),
  };
}

/** JSON with sorted keys and without undefined values, so that two entries compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Whether a file already has the server: `same` when an entry of that name points at the same server with the same
 * headers and environment (switched off or not), `different` when the name is taken by another setup. The raw entry,
 * which can hold secret values, is only compared here and never returned.
 */
export function collisionOf(text: string, name: string, entry: McpConfigEntry): Collision {
  const existing = findServerEntry(text, name);
  if (existing === undefined) return 'none';
  return canonical(identity(existing)) === canonical(identity(entry)) ? 'same' : 'different';
}

/** `name-2`, `name-3`… the first that is not taken, cut so that it stays a valid server name. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  for (let number = 2; ; number++) {
    const suffix = `-${number}`;
    const candidate = `${name.slice(0, MAX_NAME_CHARS - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/** A link without its scheme and trailing slash, for a dialog line. */
const shortLink = (url: string): string => url.replace(/^https:\/\//, '').replace(/\/$/, '');

/**
 * The level the dialog treats a proposal as. A `mismatch` that reaches the Add dialog means the user chose Kiro's
 * address over the known one, so it is treated as not in the list.
 */
const dialogLevel = (proposal: McpProposal, assessment: McpAssessment): Exclude<McpTrustLevel, 'mismatch'> =>
  assessment.level === 'mismatch' ? (proposal.transport === 'stdio' ? 'program' : 'unlisted') : assessment.level;

export function planAdd(input: AddPlanInput, t: Translate = identityTranslate): AddPlan {
  const { assessment, userText, workspaceText } = input;
  const level = dialogLevel(input.proposal, assessment);
  const name = input.proposal.name;
  const known = level === 'known' ? assessment.entry : undefined;
  const proposal = known ? catalogProposal(known, name) : input.proposal;
  const { entry, secrets } = planEntry(proposal, name);

  const collision = collisionOf(userText, name, entry);
  const workspaceCollision = workspaceText === undefined ? undefined : collisionOf(workspaceText, name, entry);
  const shadowed = workspaceCollision !== undefined && workspaceCollision !== 'none';
  const taken = (candidate: string): boolean =>
    findServerEntry(userText, candidate) !== undefined ||
    (workspaceText !== undefined && findServerEntry(workspaceText, candidate) !== undefined);

  const detail: string[] = [];
  if (proposal.transport === 'http') detail.push(t('Address: {0}', proposal.url ?? ''));
  else detail.push(t('Command: {0}', commandLine(proposal.command ?? '', proposal.args ?? [])));
  detail.push(t('Saved in: {0}', input.userFile), t('Used in all workspaces, also by the Kiro IDE and kiro-cli.'));
  if (shadowed) detail.push(t('The workspace file also defines "{0}" and wins over your user settings.', name));
  if (known) detail.push(t('Known server, checked against {0}.', shortLink(known.source)));
  else detail.push(t("Not in Kiro Studio's list. Kiro suggested it and can be wrong or misled by what it read."));
  if (proposal.transport === 'stdio') {
    detail.push(t('This runs the program on your computer with your permissions whenever Kiro starts.'));
    const pkg = downloadedPackage(proposal);
    if (pkg !== undefined) detail.push(t('It downloads and runs the package "{0}".', pkg));
  }
  if (secrets.length > 0) {
    detail.push(
      t(
        "Kiro Studio asks for {0} next and keeps it in VS Code's secret storage. Kiro restarts to use it; your chats stay open.",
        secrets.map((secret) => secret.label).join(', '),
      ),
    );
  } else if (proposal.transport === 'http' && known?.signIn !== 'none') {
    detail.push(t('If the server asks you to sign in, your browser opens.'));
  }
  detail.push(
    input.autopilot
      ? t('In Autopilot, Kiro uses its tools without asking.')
      : t('Kiro can use its tools right away. In Supervised mode each tool call asks you first.'),
  );

  const buttons: PlanButton<AddTarget>[] = [];
  if (level === 'program') {
    buttons.push(
      { label: t('Add switched off'), choice: { scope: 'user', disabled: true } },
      { label: t('Add and turn on'), choice: { scope: 'user', disabled: false } },
    );
  } else {
    buttons.push({ label: t('Add'), choice: { scope: 'user', disabled: false } });
    if (input.hasFolder && input.trusted)
      buttons.push({ label: t('Add to this workspace only'), choice: { scope: 'workspace', disabled: false } });
  }

  return {
    name,
    title: proposal.title,
    proposal,
    entry,
    secrets,
    modal: {
      severity: level === 'known' && proposal.transport === 'http' ? 'info' : 'warning',
      title: t('Add the MCP server "{0}"?', proposal.title),
      detail,
      buttons,
    },
    collision,
    ...(workspaceCollision === undefined ? {} : { workspaceCollision }),
    shadowed,
    alternativeName: freeName(name, taken),
  };
}

/**
 * The question before the Add dialog when Kiro's address for a known name differs from the list's: the list's address
 * is offered first. Only for a `mismatch` assessment, which carries the entry.
 */
export function planAddressChoice(
  proposal: McpProposal,
  assessment: McpAssessment,
  t: Translate = identityTranslate,
): PlanModal<'known' | 'kiro'> {
  const entry = assessment.entry;
  const known = entry ? (entry.url ?? commandLine(entry.command ?? '', entry.args ?? [])) : '';
  const kiro = proposal.url ?? commandLine(proposal.command ?? '', proposal.args ?? []);
  return {
    severity: 'warning',
    title: t('Kiro\'s address for "{0}" differs from the known one.', proposal.title),
    detail: [t('Known: {0}', known), t('Kiro: {0}', kiro)],
    buttons: [
      { label: t('Use the known address'), choice: 'known' },
      { label: t("Use Kiro's address"), choice: 'kiro' },
    ],
  };
}

/** The question when the name is taken by another setup in the file the user chose. */
export function planCollision(
  name: string,
  file: string,
  alternativeName: string,
  t: Translate = identityTranslate,
): PlanModal<'replace' | 'rename'> {
  return {
    severity: 'warning',
    title: t('"{0}" already exists in {1} with a different setup.', name, file),
    detail: [],
    buttons: [
      { label: t('Replace'), choice: 'replace' },
      { label: t('Add as "{0}"', alternativeName), choice: 'rename' },
    ],
  };
}
