/**
 * The pipe to the agent process. Everything above works against {@link Transport}, so tests can connect an
 * in-memory fake agent instead of spawning anything.
 */
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { launchSpec } from '../util/launch';
import { currentPlatform } from '../util/paths';

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface Transport {
  /** Bytes to the agent. */
  readonly stdin: WritableStream<Uint8Array>;
  /** Bytes from the agent. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Registers a listener for lines the agent writes to stderr (diagnostics only). */
  onStderrLine(listener: (line: string) => void): void;
  /** Settles when the process is gone. */
  readonly exited: Promise<ExitInfo>;
  readonly pid?: number;
  /** Closes the pipe to the agent's stdin, which asks a well-behaved agent to finish. */
  endInput(): void;
  /**
   * Ends the process. With `tree` the processes it started are ended too: the Kiro CLI starts a Node-based agent
   * server as a child, and a plain kill of the parent can leave that child running.
   */
  kill(options: { tree: boolean }): Promise<void>;
}

export type TransportFactory = () => Promise<Transport>;

export interface SpawnSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function spawnTransport(spec: SpawnSpec): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const launch = launchSpec(spec.command, spec.args, currentPlatform());
    // On POSIX the child leads its own process group so that the whole tree can be signalled.
    const child: PipedChild = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: posix,
      shell: launch.shell,
    });

    const exited = new Promise<ExitInfo>((done) => {
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    child.once('error', (error) => reject(error));
    child.once('spawn', () => resolve(wrap(child, exited, posix)));
    // A write after the agent died raises EPIPE on stdin; the exit handling reports the real cause.
    child.stdin.on('error', () => undefined);
  });
}

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

function wrap(child: PipedChild, exited: Promise<ExitInfo>, posix: boolean): Transport {
  const stderrListeners: ((line: string) => void)[] = [];
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line) for (const listener of stderrListeners) listener(line);
    }
  });

  let gone = false;
  void exited.then(() => {
    gone = true;
  });

  return {
    stdin: Writable.toWeb(child.stdin),
    stdout: Readable.toWeb(child.stdout),
    onStderrLine: (listener) => void stderrListeners.push(listener),
    exited,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    endInput: () => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    },
    kill: async ({ tree }) => {
      if (gone || child.pid === undefined) return;
      if (process.platform === 'win32') {
        // /T ends the tree, /F forces it. The agent server is a child of kiro-cli.exe.
        await new Promise<void>((done) => {
          execFile('taskkill', ['/pid', String(child.pid), ...(tree ? ['/T'] : []), '/F'], { windowsHide: true }, () =>
            done(),
          );
        });
      } else {
        const target = tree && posix ? -child.pid : child.pid;
        signal(target, 'SIGTERM');
        const timer = setTimeout(() => signal(target, 'SIGKILL'), 3000);
        await exited;
        clearTimeout(timer);
        // Anything in the group that ignored SIGTERM is not waited for by `exited`.
        if (tree && posix) signal(target, 'SIGKILL');
      }
      await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 3000))]);
    },
  };
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
}
