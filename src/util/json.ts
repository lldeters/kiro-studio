/** Helpers for reading JSON that comes from the agent. Everything the agent sends is untrusted and may be partial. */

export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value as an object, or an empty object. Lets chains like `rec(rec(x.a).b)` never throw. */
export const rec = (value: unknown): JsonObject => (isRecord(value) ? value : {});

export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** `_meta.kiro` of a payload, the namespace Kiro uses for its extensions. */
export const kiroMeta = (payload: unknown): JsonObject => rec(rec(rec(payload)._meta).kiro);

/** `{ [key]: value }`, or `{}` when the value is undefined, so that optional properties stay truly absent. */
export function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
