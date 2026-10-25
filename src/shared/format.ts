/** Numbers as the window's language writes them. Shared by the host and the webviews. */

/** Credits with two decimals: "0.42" in English, "0,42" in German. An unknown language tag falls back to the default. */
export function formatCredits(credits: number, locale?: string): string {
  const options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return credits.toLocaleString(locale, options);
  } catch {
    return credits.toLocaleString(undefined, options);
  }
}
