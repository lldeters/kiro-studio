import { describe, expect, it } from 'vitest';
import { chatHtml, contentSecurityPolicy } from '../../src/view/chatHtml';

const input = {
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  nonce: 'abc123',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/main.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/main.css',
  lang: 'de',
  title: 'Kiro <Studio>',
};

describe('chat page', () => {
  it('allows scripts only with the nonce or from the extension folder and nothing from the network', () => {
    const policy = contentSecurityPolicy(input.cspSource, input.nonce);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`script-src 'nonce-abc123' ${input.cspSource}`);
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(policy).not.toContain('connect-src');
    expect(policy).not.toMatch(/https?:\/\/(?!file\+)/);
  });

  it('puts the nonce on the one script and escapes what it embeds', () => {
    const html = chatHtml(input);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script type="module" nonce="abc123" src="${input.scriptUri}"></script>`);
    expect(html).toContain('<title>Kiro &lt;Studio&gt;</title>');
    expect(html).toContain('<html lang="de">');
    expect(html).toContain(`href="${input.styleUri}"`);
  });
});
