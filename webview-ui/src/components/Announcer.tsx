import type { McpServerView } from '../../../src/shared/chatProtocol';
import { useT, type T } from '../i18n';
import { useChat } from '../store';
import { connectedText } from './McpProposalCard';

/** What became of an MCP server the user is following, with its name first. */
function mcpText(server: McpServerView, t: T): string {
  switch (server.state) {
    case 'connected':
      return `${server.name}: ${connectedText(t, server.toolCount)}`;
    case 'needsSignIn':
      return `${server.name}: ${t('Sign-in required')}`;
    default:
      return `${server.name}: ${server.error === undefined ? t('Failed') : t('Could not start: {0}', server.error)}`;
  }
}

/**
 * Tells a screen reader what it cannot see happen: a question from Kiro and an MCP server that needs the user (at
 * once), the end of a turn and a server that connected (politely). The transcript itself is not a live region, because
 * streaming text would be read out chunk by chunk.
 */
export function Announcer() {
  const t = useT();
  const announcement = useChat((s) => s.announcement);
  // A live region speaks only when its text changes, so the same sentence twice in a row alternates a trailing space.
  const tail = announcement !== undefined && announcement.seq % 2 === 0 ? ' ' : '';
  const server = announcement?.kind === 'mcp' ? announcement.server : undefined;
  const urgent = server !== undefined && server.state !== 'connected';
  const polite =
    announcement?.kind === 'done'
      ? `${t('Kiro')}: ${t('Done')}`
      : server !== undefined && !urgent
        ? mcpText(server, t)
        : '';
  const alert =
    announcement?.kind === 'question'
      ? `${t('Waiting for your answer')}: ${announcement.title ?? ''}`
      : server !== undefined && urgent
        ? mcpText(server, t)
        : '';
  return (
    <>
      <div className="visually-hidden" role="status" aria-atomic="true">
        {polite === '' ? '' : `${polite}${tail}`}
      </div>
      <div className="visually-hidden" role="alert">
        {alert === '' ? '' : `${alert}${tail}`}
      </div>
    </>
  );
}
