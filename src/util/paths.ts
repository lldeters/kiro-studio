/**
 * Path handling for paths that come from the agent. On Windows Kiro uses three spellings for the same file:
 * `c:\Users\me\x.txt` (lower-case drive letter), `file:///c%3A/Users/me/x.txt`, and `~` inside snapshot URIs.
 * Everything is brought to one form before it is compared. The platform is a parameter so that the Windows
 * rules can be tested on any machine.
 */
import * as nodePath from 'node:path';

export type PlatformKind = 'win32' | 'posix';

export const currentPlatform = (): PlatformKind => (process.platform === 'win32' ? 'win32' : 'posix');

const api = (platform: PlatformKind) => (platform === 'win32' ? nodePath.win32 : nodePath.posix);

/** Converts a `file:` URI to a path in the given platform's spelling. Returns undefined for other schemes. */
export function fileUriToPath(uri: string, platform: PlatformKind): string | undefined {
  if (!/^file:\/\//i.test(uri)) return undefined;
  let url: URL;
  let pathname: string;
  try {
    url = new URL(uri);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const host = url.hostname === 'localhost' ? '' : url.hostname;
  if (platform === 'win32') {
    // /c:/Users/me -> c:\Users\me ; file://server/share/x -> \\server\share\x
    const withoutLeadingSlash = /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
    const unc = host === '' ? '' : `//${host}`;
    return nodePath.win32.normalize(`${unc}${withoutLeadingSlash}`.replace(/\//g, '\\'));
  }
  return nodePath.posix.normalize(pathname);
}

/**
 * Normalises a path or `file:` URI from the agent to an absolute, normalised path. A relative path is resolved
 * against `base`. Returns undefined when the value is not a usable path.
 */
export function normalizeAgentPath(raw: string, platform: PlatformKind, base?: string): string | undefined {
  if (raw.length === 0) return undefined;
  const p = api(platform);
  const fromUri = fileUriToPath(raw, platform);
  if (fromUri !== undefined) return fromUri;
  if (/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(raw)) return undefined; // another scheme, e.g. kiro-snapshot-v2://
  if (p.isAbsolute(raw)) return p.normalize(raw);
  return base === undefined ? undefined : p.resolve(base, raw);
}

/** Key for comparing paths: Windows file systems are case-insensitive by default. */
export function comparisonKey(path: string, platform: PlatformKind): string {
  const normalised = api(platform)
    .normalize(path)
    .replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalised.toLowerCase() : normalised;
}

export function samePath(a: string, b: string, platform: PlatformKind): boolean {
  return comparisonKey(a, platform) === comparisonKey(b, platform);
}

/** True when `target` is `root` or lies below it. */
export function isInside(root: string, target: string, platform: PlatformKind): boolean {
  const p = api(platform);
  const rel = p.relative(comparisonKey(root, platform), comparisonKey(target, platform));
  // `..config` is a name inside the root; only `..` as a whole segment leaves it.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

export function isInsideAny(roots: readonly string[], target: string, platform: PlatformKind): boolean {
  return roots.some((root) => isInside(root, target, platform));
}
