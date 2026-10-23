/** The page of the chat webview. Pure, so that the policy it sets can be tested. */

export interface ChatHtmlInput {
  /** `webview.cspSource` */
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  /** Language tag of the window, for the `lang` attribute. */
  lang: string;
  title: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Scripts run only with the nonce or from the extension's own folder (the lazily loaded chunks for highlighting
 * and diagrams). Styles may be inline because rendered code and diagrams carry inline styles. Nothing is loaded
 * from the network and the page cannot send anything anywhere.
 */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join('; ');
}

export function chatHtml(input: ChatHtmlInput): string {
  const { cspSource, nonce, scriptUri, styleUri, lang, title } = input;
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(contentSecurityPolicy(cspSource, nonce))}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${escapeHtml(styleUri)}" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${escapeHtml(nonce)}" src="${escapeHtml(scriptUri)}"></script>
  </body>
</html>
`;
}
