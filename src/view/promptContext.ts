/**
 * Turns what the user attached to a prompt into ACP content blocks. Files and folders are sent as links (Kiro reads
 * them itself, with its own tools), problems and the git diff as text, images as image blocks. Nothing outside the
 * workspace is linked, and nothing is read here: what needs the file system or git comes in through {@link ContextDeps}.
 */
import { pathToFileURL } from 'node:url';
import type { PromptBlock } from '../acp/prompt';
import type { AttachmentView } from '../shared/chatProtocol';
import { selectionLabel } from '../shared/format';
import { isInsideAny, normalizeAgentPath, type PlatformKind } from '../util/paths';

export interface ContextDeps {
  platform: PlatformKind;
  /** Workspace folders and the session's folder; only paths inside are linked. */
  roots: readonly string[];
  /** Where a relative path starts. */
  base?: string;
  exists(path: string): Promise<boolean>;
  /** The uncommitted changes (see {@link uncommittedChanges}), or undefined when there is no repository. */
  gitDiff(): Promise<GitDiff | undefined>;
  /** The workspace problems, already formatted (see {@link formatProblems}). */
  problems(): Promise<string | undefined>;
  /** Whether the agent accepts images in a prompt (`promptCapabilities.image`). */
  imageSupported: boolean;
}

export interface GitDiff {
  text: string;
  /** The diff was longer than the limit and ends early. */
  truncated: boolean;
  /** New files that git does not track yet; no diff shows them. */
  untracked?: string[];
}

/** What one git command printed. `truncated`: it printed more than the limit and was stopped (that is no failure). */
export interface GitOutput {
  stdout: string;
  failed: boolean;
  truncated: boolean;
}

export type GitCommand = (args: readonly string[]) => Promise<GitOutput>;

const DIFF_OPTIONS = ['--no-color', '--no-ext-diff'];
const MAX_UNTRACKED_LISTED = 100;

/**
 * Everything that is not committed: the staged and the unstaged changes against the last commit, and the new files git
 * does not track yet. A repository without a commit has nothing to compare with, so there the staged changes (against
 * nothing) and the unstaged ones are taken. Undefined when the folder is not in a repository.
 */
export async function uncommittedChanges(git: GitCommand): Promise<GitDiff | undefined> {
  let parts = [await git(['diff', 'HEAD', ...DIFF_OPTIONS])];
  if (parts[0]?.failed) {
    const staged = await git(['diff', '--cached', ...DIFF_OPTIONS]);
    if (staged.failed) return undefined;
    parts = [staged, await git(['diff', ...DIFF_OPTIONS])];
  }
  // NUL-separated, so that names with spaces or other scripts come through as they are.
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = listed.failed ? [] : listed.stdout.split('\0').filter((name) => name !== '');
  return {
    text: parts.map((part) => part.stdout).join(''),
    truncated: parts.some((part) => part.truncated),
    ...(untracked.length === 0 ? {} : { untracked }),
  };
}

export type SkipReason = 'outside' | 'missing' | 'empty' | 'unsupported';

export interface ResolvedContext {
  blocks: PromptBlock[];
  /** Short names for the transcript, one per attachment that was sent. */
  labels: string[];
  skipped: { reason: SkipReason; label: string }[];
}

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A fence longer than any run of backticks in the text, so that the text cannot end the block. */
function codeFence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The file's extension as the language of the block (`ts`, `py`), which Markdown readers understand. */
function languageOf(path: string): string {
  return /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
}

export async function resolveAttachments(
  items: readonly AttachmentView[],
  deps: ContextDeps,
): Promise<ResolvedContext> {
  const result: ResolvedContext = { blocks: [], labels: [], skipped: [] };
  const seen = new Set<string>();

  for (const item of items) {
    switch (item.kind) {
      case 'file':
      case 'folder': {
        const path = normalizeAgentPath(item.path, deps.platform, deps.base);
        const label = baseName(item.path) + (item.kind === 'folder' ? '/' : '');
        if (path === undefined || !isInsideAny(deps.roots, path, deps.platform)) {
          result.skipped.push({ reason: 'outside', label });
        } else if (!(await deps.exists(path))) {
          result.skipped.push({ reason: 'missing', label });
        } else if (!seen.has(path)) {
          seen.add(path);
          result.blocks.push({
            type: 'resource_link',
            uri: pathToFileURL(path, { windows: deps.platform === 'win32' }).href,
            name: baseName(path),
          });
          result.labels.push(label);
        }
        break;
      }
      case 'selection': {
        const path = normalizeAgentPath(item.path, deps.platform, deps.base);
        const label = selectionLabel(item);
        if (path === undefined || !isInsideAny(deps.roots, path, deps.platform)) {
          result.skipped.push({ reason: 'outside', label });
        } else if (item.text.trim() === '') {
          result.skipped.push({ reason: 'empty', label });
        } else {
          const lines =
            item.startLine === item.endLine ? `line ${item.startLine}` : `lines ${item.startLine}-${item.endLine}`;
          const fence = codeFence(item.text);
          result.blocks.push({
            type: 'text',
            text: `Selected ${lines} of ${path}:\n${fence}${languageOf(path)}\n${item.text.replace(/\n$/, '')}\n${fence}`,
          });
          result.labels.push(label);
        }
        break;
      }
      case 'problems': {
        const text = await deps.problems();
        if (text === undefined || text.trim() === '') result.skipped.push({ reason: 'empty', label: 'Problems' });
        else {
          result.blocks.push({ type: 'text', text: `Problems reported in the workspace:\n${text}` });
          result.labels.push('Problems');
        }
        break;
      }
      case 'gitDiff': {
        const diff = await deps.gitDiff();
        const untracked = diff?.untracked ?? [];
        if (diff === undefined || (diff.text.trim() === '' && untracked.length === 0)) {
          result.skipped.push({ reason: 'empty', label: 'git diff' });
          break;
        }
        const sections: string[] = [];
        if (diff.text.trim() !== '') {
          // Kiro must know that it does not see all of it, or it would take the end of the text for the end of the diff.
          const cut = diff.truncated
            ? '\n(The diff is longer and was cut off here. Run git diff HEAD to see all of it.)'
            : '';
          sections.push(`Uncommitted changes (git diff HEAD):\n\`\`\`diff\n${diff.text.trimEnd()}\n\`\`\`${cut}`);
        }
        if (untracked.length > 0) {
          const more =
            untracked.length > MAX_UNTRACKED_LISTED ? `\n… and ${untracked.length - MAX_UNTRACKED_LISTED} more` : '';
          const names = untracked.slice(0, MAX_UNTRACKED_LISTED).map((name) => `- ${name}`);
          sections.push(`New files that git does not track yet:\n${names.join('\n')}${more}`);
        }
        result.blocks.push({ type: 'text', text: sections.join('\n\n') });
        result.labels.push('git diff');
        break;
      }
      case 'image':
        if (!deps.imageSupported) result.skipped.push({ reason: 'unsupported', label: item.name });
        else {
          result.blocks.push({ type: 'image', mimeType: item.mimeType, data: item.data });
          result.labels.push(item.name);
        }
        break;
    }
  }
  return result;
}

/**
 * The file `#current` means: the one in the active editor. When the chat is an editor tab and has the focus, VS Code has
 * no active text editor; then it is the file editor used last, as long as it is still open.
 */
export function currentFileOf(
  active: string | undefined,
  last: string | undefined,
  open: readonly string[],
): string | undefined {
  if (active !== undefined) return active;
  return last !== undefined && open.includes(last) ? last : undefined;
}

export interface Problem {
  file: string;
  /** 1-based. */
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  source?: string;
}

/** One line per problem, errors first, shortened to a limit so that a noisy workspace does not fill the context. */
export function formatProblems(problems: readonly Problem[], limit = 100): string {
  const ordered = [...problems].sort(
    (a, b) =>
      Number(b.severity === 'error') - Number(a.severity === 'error') ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  const lines = ordered
    .slice(0, limit)
    .map(
      (p) =>
        `- ${p.severity} ${p.file}:${p.line}:${p.column} ${p.message.replace(/\s+/g, ' ').trim()}${p.source ? ` (${p.source})` : ''}`,
    );
  if (ordered.length > limit) lines.push(`… and ${ordered.length - limit} more`);
  return lines.join('\n');
}
