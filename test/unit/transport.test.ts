import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { spawnTransport } from '../../src/acp/transport';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    if (done || text.includes('\n')) break;
  }
  reader.releaseLock();
  return text.split('\n')[0] ?? '';
}

describe.skipIf(process.platform === 'win32')('spawnTransport (POSIX)', () => {
  it('rejects when the program does not exist', async () => {
    await expect(spawnTransport({ command: '/definitely/not/here', args: [], cwd: process.cwd() })).rejects.toThrow();
  });

  it('passes stdout through, reports stderr lines and the exit', async () => {
    const t = await spawnTransport({
      command: process.execPath,
      args: ['-e', "process.stderr.write('warn 1\\nwarn 2\\n'); process.stdout.write('hello\\n')"],
      cwd: process.cwd(),
    });
    const lines: string[] = [];
    t.onStderrLine((line) => lines.push(line));
    expect(await readFirstLine(t.stdout)).toBe('hello');
    expect(await t.exited).toEqual({ code: 0, signal: null });
    expect(lines).toEqual(['warn 1', 'warn 2']);
  });

  it('ends the whole process tree, including a child that ignores SIGTERM', async () => {
    const t = await spawnTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, '../support/tree-parent.mjs')],
      cwd: process.cwd(),
    });
    const { child } = JSON.parse(await readFirstLine(t.stdout)) as { child: number };
    expect(alive(child)).toBe(true);
    await t.kill({ tree: true });
    expect(await waitUntil(() => !alive(child))).toBe(true);
    const exit = await t.exited;
    expect(exit.code !== null || exit.signal !== null).toBe(true);
  });

  it('a plain kill leaves the child running, which is why the tree option exists', async () => {
    const t = await spawnTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, '../support/tree-parent.mjs')],
      cwd: process.cwd(),
    });
    const { child } = JSON.parse(await readFirstLine(t.stdout)) as { child: number };
    await t.kill({ tree: false });
    expect(alive(child)).toBe(true);
    process.kill(child, 'SIGKILL');
  });

  it('kill is harmless when the process is already gone', async () => {
    const t = await spawnTransport({ command: process.execPath, args: ['-e', ''], cwd: process.cwd() });
    await t.exited;
    await expect(t.kill({ tree: true })).resolves.toBeUndefined();
  });
});
