/**
 * Prints a session's transcript as plain text, incrementally, for the debug output channel: text that streams in is
 * appended as it grows, a tool call gets a new line whenever its status changes. The chat view of Phase 2 replaces
 * this; until then it makes the connection testable without a UI.
 */
import type { Session, ToolCallState } from '../acp/sessions';

export interface TextOutput {
  append(text: string): void;
}

export class TranscriptPrinter {
  /** How many characters of each message were printed. */
  private readonly printed = new Map<number, number>();
  private readonly toolStatus = new Map<string, string>();
  private lastItemId = 0;
  private lineOpen = false;

  constructor(private readonly out: TextOutput) {}

  /** Prints what is new since the last call. */
  sync(session: Session): void {
    for (const item of session.transcript) {
      switch (item.kind) {
        case 'user':
        case 'assistant':
        case 'thought':
          this.text(item.id, item.kind, item.text, item.replay);
          break;
        case 'notice':
          if (!this.printed.has(item.id)) {
            this.printed.set(item.id, item.text.length);
            this.line(`[${item.level}] ${item.text}`);
          }
          break;
        case 'tool':
          this.tool(item.toolCallId, session.tools.get(item.toolCallId));
          break;
      }
    }
    for (const approval of session.approvals) {
      const key = `approval:${approval.id}`;
      if (!this.toolStatus.has(key)) {
        this.toolStatus.set(key, 'open');
        this.line(`? waiting for you: ${approval.title}${approval.resource ? ` (${approval.resource})` : ''}`);
      }
    }
  }

  private text(id: number, kind: 'user' | 'assistant' | 'thought', text: string, replay: boolean): void {
    const done = this.printed.get(id) ?? 0;
    if (text.length <= done) return; // nothing new
    if (done === 0) {
      this.closeLine();
      const label = kind === 'user' ? '>' : kind === 'thought' ? '(thinking)' : 'Kiro:';
      this.out.append(`${replay ? '[replay] ' : ''}${label} `);
    } else if (this.lastItemId !== id) {
      // Something else was printed in between; continue on a fresh line.
      this.closeLine();
      this.out.append('… ');
    }
    this.out.append(text.slice(done));
    this.printed.set(id, text.length);
    this.lastItemId = id;
    this.lineOpen = !text.endsWith('\n');
    if (kind === 'user') this.closeLine();
  }

  private tool(toolCallId: string, tool: ToolCallState | undefined): void {
    if (!tool) return;
    const status = tool.status ?? 'new';
    if (this.toolStatus.get(toolCallId) === status) return;
    this.toolStatus.set(toolCallId, status);
    const where = tool.locations[0]?.path;
    this.line(`* ${tool.title}${tool.kind ? ` [${tool.kind}]` : ''}: ${status}${where ? ` ${where}` : ''}`);
  }

  private line(text: string): void {
    this.closeLine();
    this.out.append(`${text}\n`);
    this.lastItemId = 0;
  }

  private closeLine(): void {
    if (this.lineOpen) {
      this.out.append('\n');
      this.lineOpen = false;
    }
  }
}
