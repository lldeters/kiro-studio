/**
 * The list of sessions the panel shows: `session/list` results plus the live `_kiro/sessions/changed` broadcasts.
 * The broadcasts carry partial objects (only what changed), so they are merged by session id.
 */
import { identityTranslate, type Translate } from '../view/statusModel';

export interface SessionEntry {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  /** `idle`, `in_progress` or `waiting_on_user`. */
  status?: string;
  /** `local` or `remote`. */
  source?: string;
  agentMode?: string;
}

export type SessionPatch = Partial<SessionEntry> & { sessionId: string };

export class SessionListModel {
  private readonly entries = new Map<string, SessionEntry>();

  /** Replaces everything with a fresh `session/list` result. */
  replace(list: readonly SessionPatch[]): void {
    this.entries.clear();
    this.upsert(list);
  }

  /** Merges partial entries: a field that is missing in the update keeps its value. */
  upsert(patches: readonly SessionPatch[]): void {
    for (const patch of patches) {
      const merged: SessionEntry = { ...this.entries.get(patch.sessionId), sessionId: patch.sessionId };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
      }
      this.entries.set(patch.sessionId, merged);
    }
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) this.entries.delete(id);
  }

  /** Newest first. Entries without a date go last. */
  list(): SessionEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.sessionId.localeCompare(b.sessionId),
    );
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.entries.get(sessionId);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Entries whose title, folder, agent or id contains every word of the query (any case). */
export function filterSessions(entries: readonly SessionEntry[], query: string): SessionEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = [entry.title, entry.cwd, entry.agentMode, entry.sessionId, entry.source].join('\n').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** "3 min ago", "yesterday", or the date. `now` is a parameter so that tests do not depend on the clock. */
export function relativeTime(
  iso: string | undefined,
  now: number,
  t: Translate = identityTranslate,
): string | undefined {
  if (iso === undefined) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t('just now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('{0} min ago', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('{0} h ago', hours);
  const days = Math.round(hours / 24);
  if (days === 1) return t('yesterday');
  if (days < 7) return t('{0} days ago', days);
  return new Date(then).toISOString().slice(0, 10);
}
