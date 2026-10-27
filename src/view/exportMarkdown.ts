/** A session as a Markdown document, for saving or sharing. Built from the same view the chat shows. */
import type { SessionView, ToolView } from '../shared/chatProtocol';
import { stripContext } from '../workspace/mcpInstructions';

export interface ExportLabels {
  you: string;
  kiro: string;
  thinking: string;
  filesChanged: (count: number) => string;
}

export const ENGLISH_LABELS: ExportLabels = {
  you: 'You',
  kiro: 'Kiro',
  thinking: 'Thinking',
  filesChanged: (count) => `Kiro changed ${count} ${count === 1 ? 'file' : 'files'}`,
};

function toolLine(tool: ToolView): string {
  const target = tool.locations[0];
  const counts = tool.added === undefined ? '' : ` (+${tool.added} −${tool.removed ?? 0})`;
  const state = tool.state === 'failed' ? ' — failed' : '';
  return `- **${tool.title}**${target ? ` \`${target.path}\`` : ''}${counts}${state}`;
}

export function exportMarkdown(session: SessionView, labels: ExportLabels = ENGLISH_LABELS): string {
  const tools = new Map(session.tools.map((tool) => [tool.toolCallId, tool]));
  const checkpoints = new Map((session.checkpoints ?? []).map((c) => [c.id, c]));
  const out: string[] = [`# ${session.title?.trim() || 'Kiro session'}`];
  let toolRun: string[] = [];
  const flushTools = () => {
    if (toolRun.length > 0) out.push(toolRun.join('\n'));
    toolRun = [];
  };

  for (const item of session.items) {
    if (item.kind === 'tool') {
      const tool = item.toolCallId === undefined ? undefined : tools.get(item.toolCallId);
      if (tool) toolRun.push(toolLine(tool));
      continue;
    }
    flushTools();
    switch (item.kind) {
      case 'user':
        // Kiro Studio's hidden instructions are no part of what the user wrote.
        out.push(`## ${labels.you}`, stripContext(item.text));
        if (item.attachments?.length) out.push(item.attachments.map((a) => `\`${a}\``).join(', '));
        break;
      case 'assistant':
        out.push(`## ${labels.kiro}`, item.text);
        break;
      case 'thought':
        out.push(`<details><summary>${labels.thinking}</summary>\n\n${item.text}\n\n</details>`);
        break;
      case 'notice':
        out.push(`> ${item.text.replace(/\n/g, '\n> ')}`);
        break;
      case 'usage':
        // The cost of a turn is shown in the chat, not part of the conversation.
        break;
      case 'checkpoint': {
        const checkpoint = item.checkpointId === undefined ? undefined : checkpoints.get(item.checkpointId);
        if (checkpoint) {
          out.push(
            `> ${labels.filesChanged(checkpoint.files.length)}: ${checkpoint.files.map((f) => `\`${f.path}\``).join(', ')}`,
          );
        }
        break;
      }
    }
  }
  flushTools();
  return `${out.map((block) => block.trimEnd()).join('\n\n')}\n`;
}
