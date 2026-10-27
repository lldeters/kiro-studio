import { describe, expect, it } from 'vitest';
import {
  comparisonKey,
  fileUriToPath,
  isInside,
  isInsideAny,
  normalizeAgentPath,
  samePath,
} from '../../src/util/paths';

describe('fileUriToPath', () => {
  it('reads the percent-encoded drive colon Kiro sends on Windows', () => {
    expect(fileUriToPath('file:///c%3A/Users/me/AppData/Local/Temp/x/hello.txt', 'win32')).toBe(
      'c:\\Users\\me\\AppData\\Local\\Temp\\x\\hello.txt',
    );
  });
  it('reads a plain drive URI and decodes spaces', () => {
    expect(fileUriToPath('file:///C:/My%20Docs/a.md', 'win32')).toBe('C:\\My Docs\\a.md');
  });
  it('keeps the host of a UNC URI', () => {
    expect(fileUriToPath('file://server/share/dir/a.txt', 'win32')).toBe('\\\\server\\share\\dir\\a.txt');
  });
  it('reads POSIX URIs', () => {
    expect(fileUriToPath('file:///home/me/a%20b.txt', 'posix')).toBe('/home/me/a b.txt');
  });
  it('returns undefined for other schemes and broken input', () => {
    expect(fileUriToPath('kiro-snapshot-v2://s:1/?originalPath=x', 'posix')).toBeUndefined();
    expect(fileUriToPath('/plain/path', 'posix')).toBeUndefined();
    expect(fileUriToPath('file:///c%ZZ/x', 'win32')).toBeUndefined();
  });
});

describe('normalizeAgentPath', () => {
  it('accepts native Windows paths with a lower-case drive letter', () => {
    expect(normalizeAgentPath('c:\\Users\\me\\a.txt', 'win32')).toBe('c:\\Users\\me\\a.txt');
  });
  it('resolves relative paths against the base', () => {
    expect(normalizeAgentPath('hello.txt', 'win32', 'C:\\Work')).toBe('C:\\Work\\hello.txt');
    expect(normalizeAgentPath('src/a.ts', 'posix', '/ws')).toBe('/ws/src/a.ts');
  });
  it('rejects a relative path without a base and foreign schemes', () => {
    expect(normalizeAgentPath('hello.txt', 'posix')).toBeUndefined();
    expect(normalizeAgentPath('', 'posix')).toBeUndefined();
    expect(normalizeAgentPath('kiro-snapshot-v2://x', 'posix', '/ws')).toBeUndefined();
  });
  it('collapses dot segments', () => {
    expect(normalizeAgentPath('/ws/a/../b.txt', 'posix')).toBe('/ws/b.txt');
  });
});

describe('comparison', () => {
  it('ignores case and trailing separators on Windows only', () => {
    expect(samePath('C:\\Users\\Me\\', 'c:\\users\\me', 'win32')).toBe(true);
    expect(samePath('/Users/Me', '/users/me', 'posix')).toBe(false);
    expect(comparisonKey('C:\\A\\', 'win32')).toBe('c:\\a');
  });
  it('knows what is inside a root', () => {
    expect(isInside('C:\\Work', 'c:\\work\\src\\a.ts', 'win32')).toBe(true);
    expect(isInside('C:\\Work', 'C:\\Work', 'win32')).toBe(true);
    expect(isInside('C:\\Work', 'C:\\Workshop\\a.ts', 'win32')).toBe(false);
    expect(isInside('C:\\Work', 'D:\\Work\\a.ts', 'win32')).toBe(false);
    expect(isInside('/ws', '/ws/../etc/passwd', 'posix')).toBe(false);
    expect(isInside('/ws', '/ws/a/b', 'posix')).toBe(true);
  });
  it('takes a name that starts with two dots for a name, not for a way up', () => {
    expect(isInside('/ws', '/ws/..config/x', 'posix')).toBe(true);
    expect(isInside('/ws', '/ws/..', 'posix')).toBe(false);
    expect(isInside('C:\\Work', 'C:\\Work\\..cache\\a.ts', 'win32')).toBe(true);
    expect(isInside('C:\\Work', 'C:\\Work\\..\\a.ts', 'win32')).toBe(false);
  });
  it('checks several roots', () => {
    expect(isInsideAny(['/a', '/b'], '/b/c', 'posix')).toBe(true);
    expect(isInsideAny([], '/b/c', 'posix')).toBe(false);
  });
});
