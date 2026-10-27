import { describe, expect, it } from 'vitest';
import { assessProposal, MCP_CATALOG } from '../../src/shared/mcpCatalog';
import { extractProposals } from '../../src/shared/mcpProposal';
import {
  looksLikeMcpRequest,
  MCP_STEERING_NAME,
  mcpInstructionText,
  stripContext,
  wrapContext,
} from '../../src/workspace/mcpInstructions';

describe('the instructions for Kiro', () => {
  const text = mcpInstructionText();

  it('stays under 3,600 characters, which Kiro reads with every answer', () => {
    expect(text.length).toBeLessThan(3_600);
  });

  it('shows an example that Kiro Studio accepts as a known server', () => {
    const [example, ...rest] = extractProposals(text);
    expect(rest).toEqual([]);
    if (!example?.result.ok) throw new Error('the example is not a valid proposal');
    expect(example.result.proposal.name).toBe('linear');
    expect(assessProposal(example.result.proposal).level).toBe('known');
  });

  it('lists every server of the catalog once, with the address to propose', () => {
    for (const entry of MCP_CATALOG) {
      const lines = text
        .split('\n')
        .filter((line) => line.startsWith(`- ${entry.id} `) || line.startsWith(`- ${entry.id}:`));
      expect(lines, entry.id).toHaveLength(1);
      expect(lines[0], entry.id).toContain(entry.url ?? `${entry.command} ${(entry.args ?? []).join(' ')}`);
    }
    expect(text).toContain('- linear: https://mcp.linear.app/mcp');
    expect(text).toContain('- playwright: npx @playwright/mcp@latest');
    expect(text).toContain('- atlassian (Jira and Confluence): https://mcp.atlassian.com/v2/mcp');
  });

  it('holds nothing that looks like a secret, only the placeholder', () => {
    expect(text).not.toMatch(/ghp_|github_pat_|sk_live_|sk-[A-Za-z0-9]{10}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9]/);
    expect(text).toContain('${NAME}');
    expect(text).not.toContain('${GITHUB_TOKEN}');
  });

  it('is named so that Kiro lists it as a client document', () => {
    expect(MCP_STEERING_NAME).toBe('kiro-studio-mcp');
  });
});

describe('the hidden block', () => {
  it('wraps the instructions in a marked block and strips it from a user message again', () => {
    const block = wrapContext('instructions');
    expect(block).toBe('<kiro-studio-context name="mcp">\ninstructions\n</kiro-studio-context>');
    expect(stripContext(`Add Linear, please.\n\n${block}`)).toBe('Add Linear, please.');
    expect(stripContext(`${block}\nAdd Linear, please.`)).toBe('Add Linear, please.');
  });

  it('strips a block merged into the middle of a message, leaving a paragraph break', () => {
    const merged = `First part.${wrapContext(mcpInstructionText())}Second part.`;
    expect(stripContext(merged)).toBe('First part.\n\nSecond part.');
  });

  it('leaves a message without a block exactly as it is', () => {
    expect(stripContext('  keep my spacing \n')).toBe('  keep my spacing \n');
  });
});

describe('recognising a request for an MCP server', () => {
  it.each([
    'Bitte füge mir den Linear MCP Server hinzu',
    'füge mir den Notion MCP Server hinzu',
    'Kannst du mir Jira anbinden?',
    'add the Linear connector',
    'Connect GitHub please',
    'set up aws docs',
    'Verbinde mich mit Hugging Face',
    'Ich möchte eine Integration mit Sentry',
  ])('says yes to "%s"', (message) => {
    expect(looksLikeMcpRequest(message)).toBe(true);
  });

  it.each([
    'fix the server bug in app.ts',
    'write a test',
    'What does this function return?',
    'Linear algebra is hard',
  ])('says no to "%s"', (message) => {
    expect(looksLikeMcpRequest(message)).toBe(false);
  });
});
