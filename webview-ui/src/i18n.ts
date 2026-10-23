import { useChat } from './store';

/** Looks a message up by its English text; the host sends the translations. `{0}` is replaced by the first argument. */
export function translate(strings: Record<string, string>, message: string, args: (string | number)[]): string {
  const text = strings[message] ?? message;
  return text.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ''));
}

export type T = (message: string, ...args: (string | number)[]) => string;

export function useT(): T {
  const strings = useChat((state) => state.strings);
  return (message, ...args) => translate(strings, message, args);
}
