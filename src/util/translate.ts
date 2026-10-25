/** Translates and formats a message. `{0}` placeholders are filled from the arguments. */
export type Translate = (message: string, ...args: (string | number)[]) => string;

/** English, as written: for tests and for code that runs without VS Code. */
export const identityTranslate: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (_m, index: string) => String(args[Number(index)] ?? ''));
