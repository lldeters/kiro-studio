/** Numbers as the window's language writes them. Shared by the host and the webviews. */

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
