/**
 * `_kiro/secret/get`, `store` and `delete`: Kiro keeps the sign-ins of MCP servers (OAuth client registrations, tokens)
 * through the client when the client offers `secretStorage`. Without it Kiro keeps them in memory only, and every
 * restart of the Kiro CLI or reload of the window would mean signing in again.
 *
 * The values go to a {@link SecretPort} (VS Code's secret storage in the extension, a map in tests) under
 * `kiroStudio.kiroSecret.<key>`, so that they cannot collide with Kiro Studio's own secrets. An index of the keys is
 * kept next to them, because VS Code 1.93 cannot list what it stores.
 */
import { RequestError } from '@agentclientprotocol/sdk';
import { errorMessage, rec, str } from '../../util/json';
import type { ProtocolLog } from '../../util/log';

/** The part of VS Code's `SecretStorage` the bridge needs. */
export interface SecretPort {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Kiro's keys look like `kiro.mcp.<sha256>.tokens`. */
const KEY = /^[\w.:-]{1,512}$/;
/** Far more than a client registration or a set of tokens needs. */
const MAX_VALUE_BYTES = 64 * 1024;
const PREFIX = 'kiroStudio.kiroSecret.';
const INDEX = 'kiroStudio.kiroSecretKeys';

export class SecretBridge {
  /** Changes of the index, one after another, so that two stores at once do not lose a key. */
  private indexQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: SecretPort,
    private readonly log?: ProtocolLog,
  ) {}

  async get(params: unknown): Promise<{ value?: string }> {
    const key = this.key(params);
    const value = await this.port.get(PREFIX + key);
    return value === undefined ? {} : { value };
  }

  async store(params: unknown): Promise<Record<string, never>> {
    const key = this.key(params);
    const value = str(rec(params).value);
    if (value === undefined) throw RequestError.invalidParams({ field: 'value' }, 'value must be a string');
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES)
      throw RequestError.invalidParams({ field: 'value' }, `value is larger than ${MAX_VALUE_BYTES} bytes`);
    await this.port.store(PREFIX + key, value);
    await this.changeIndex((keys) => keys.add(key));
    return {};
  }

  async delete(params: unknown): Promise<Record<string, never>> {
    const key = this.key(params);
    await this.port.delete(PREFIX + key);
    await this.changeIndex((keys) => keys.delete(key));
    return {};
  }

  /** The keys Kiro stored, for removing them all later (for example when the user signs out everywhere). */
  async keys(): Promise<string[]> {
    await this.indexQueue;
    return [...(await this.readIndex())];
  }

  private key(params: unknown): string {
    const key = str(rec(params).key);
    if (key === undefined || !KEY.test(key))
      throw RequestError.invalidParams({ field: 'key' }, 'key must be 1 to 512 letters, digits, ".", ":", "-" or "_"');
    return key;
  }

  private async readIndex(): Promise<Set<string>> {
    try {
      const parsed: unknown = JSON.parse((await this.port.get(INDEX)) ?? '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
    } catch {
      return new Set();
    }
  }

  /**
   * The index is bookkeeping: when it cannot be written, the secret itself is still stored or deleted, and Kiro is not
   * told about a failure that does not concern it.
   */
  private changeIndex(change: (keys: Set<string>) => void): Promise<void> {
    this.indexQueue = this.indexQueue.then(async () => {
      try {
        const keys = await this.readIndex();
        change(keys);
        await this.port.store(INDEX, JSON.stringify([...keys]));
      } catch (error) {
        this.log?.info(`could not update the index of Kiro's stored secrets: ${errorMessage(error)}`);
      }
    });
    return this.indexQueue;
  }
}
