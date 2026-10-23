import { useEffect, useRef } from 'react';
import type { ItemView, SessionView, ToolView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';

/** Whether the list is scrolled to the bottom (within a few pixels), so that new text follows only then. */
function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

export function Transcript({ session }: { session: SessionView }) {
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const tools = new Map(session.tools.map((tool) => [tool.toolCallId, tool]));

  useEffect(() => {
    const element = container.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <div
      className="transcript"
      ref={container}
      onScroll={(event) => {
        follow.current = atBottom(event.currentTarget);
      }}
    >
      {session.items.map((item) => (
        <Item key={item.id} item={item} tool={item.toolCallId === undefined ? undefined : tools.get(item.toolCallId)} />
      ))}
    </div>
  );
}

function Item({ item, tool }: { item: ItemView; tool: ToolView | undefined }) {
  const t = useT();
  switch (item.kind) {
    case 'user':
      return (
        <div className="message user">
          <div className="author">{t('You')}</div>
          <div className="text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="message assistant">
          <div className="author">{t('Kiro')}</div>
          <div className="text">{item.text}</div>
        </div>
      );
    case 'thought':
      return (
        <div className="message thought">
          <div className="author">{t('Thinking')}</div>
          <div className="text">{item.text}</div>
        </div>
      );
    case 'notice':
      return <div className={`notice ${item.level ?? 'info'}`}>{item.text}</div>;
    case 'tool':
      return tool ? (
        <div className={`tool ${tool.state}`}>
          <span className="tool-title">{tool.title}</span>
        </div>
      ) : null;
  }
}
