/** Numbers and names as the chat shows them. Shared by the host and the webviews. */

/** A number as the language writes it; an unknown language tag falls back to the default. */
export function formatNumber(value: number, locale?: string, options: Intl.NumberFormatOptions = {}): string {
  try {
    return value.toLocaleString(locale, options);
  } catch {
    return value.toLocaleString(undefined, options);
  }
}

/**
 * How long something took: "4.1 s", "1 min 20 s" (with the words of `t`, which gets the numbers already written).
 * `t` is passed in so that this stays free of the host's and the page's ways of translating.
 */
export function formatDuration(
  ms: number,
  locale: string | undefined,
  t: (message: string, ...args: (string | number)[]) => string,
): string {
  // Rounded first, so that 59.96 s is "1 min 0 s" and not "60 s".
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return t('{0} s', formatNumber(seconds, locale, { maximumFractionDigits: 1 }));
  const whole = Math.round(seconds);
  return t('{0} min {1} s', formatNumber(Math.floor(whole / 60), locale), formatNumber(whole % 60, locale));
}

/** Credits with two decimals: "0.42" in English, "0,42" in German. An unknown language tag falls back to the default. */
export function formatCredits(credits: number, locale?: string): string {
  return formatNumber(credits, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A selection as `a.ts:3` or `a.ts:3-9`, for the transcript and the chips. */
export function selectionLabel(item: { path: string; startLine: number; endLine: number }): string {
  const name = item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.path;
  return `${name}:${item.startLine === item.endLine ? item.startLine : `${item.startLine}-${item.endLine}`}`;
}

/** A command from the terminal as `$ npm test`, shortened for a chip. */
export function terminalLabel(item: { command: string }): string {
  const command = item.command.replace(/\s+/g, ' ').trim() || 'terminal';
  return `$ ${command.length > 40 ? `${command.slice(0, 39)}…` : command}`;
}

/**
 * What a terminal printed, as a reader would see it: without colour and cursor codes, and with each line as it ended up
 * after carriage returns (a progress bar keeps only its last state).
 */
export function cleanTerminalOutput(raw: string): string {
  // The control characters are what is removed here.
  /* eslint-disable no-control-regex */
  const plain = raw
    // OSC sequences (titles, shell integration marks), ended by BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences (colours, cursor moves)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // other two-character escapes
    .replace(/\x1b[@-Z\\-_]/g, '');
  /* eslint-enable no-control-regex */
  return plain
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r$/, '').split('\r');
      return parts[parts.length - 1] ?? '';
    })
    .join('\n');
}
