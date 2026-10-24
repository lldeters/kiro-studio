/**
 * Turns what the user attached to a prompt into ACP content blocks. Files and folders are sent as links (Kiro reads
 * them itself, with its own tools), problems and the git diff as text, images as image blocks. Nothing outside the
 * workspace is linked, and nothing is read here: what needs the file system or git comes in through {@link ContextDeps}.
 */
import { pathToFileURL } from 'node:url';
import type { PromptBlock } from '../acp/prompt';
import type { AttachmentView } from '../shared/chatProtocol';
import { isInsideAny, normalizeAgentPath, type PlatformKind } from '../util/paths';

export interface ContextDeps {
  platform: PlatformKind;
  /** Workspace folders and the session's folder; only paths inside are linked. */
  roots: readonly string[];
  /** Where a relative path starts. */
  base?: string;
  exists(path: string): Promise<boolean>;
  /** Output of `git diff` (cut off when it is very long), or undefined when there is no repository. */
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
}

export type SkipReason = 'outside' | 'missing' | 'empty' | 'unsupported';

export interface ResolvedContext {
  blocks: PromptBlock[];
  /** Short names for the transcript, one per attachment that was sent. */
  labels: string[];
  skipped: { reason: SkipReason; label: string }[];
}

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

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
        if (diff === undefined || diff.text.trim() === '') result.skipped.push({ reason: 'empty', label: 'git diff' });
        else {
          // Kiro must know that it does not see all of it, or it would take the end of the text for the end of the diff.
          const cut = diff.truncated
            ? '\n(The diff is longer and was cut off here. Run git diff to see all of it.)'
            : '';
          result.blocks.push({
            type: 'text',
            text: `Uncommitted changes (git diff):\n\`\`\`diff\n${diff.text.trimEnd()}\n\`\`\`${cut}`,
          });
          result.labels.push('git diff');
        }
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
