import { memo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ItemView, SessionView, ToolView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

/** In tests there is no layout, so the list is told how many items to render. */
const testProps =
  import.meta.env.MODE === 'test' ? ({ initialItemCount: 1000, initialTopMostItemIndex: 0 } as const) : {};

export function Transcript({ session }: { session: SessionView }) {
  const tools = new Map(session.tools.map((tool) => [tool.toolCallId, tool]));
  const busy = session.phase !== 'idle';
  const lastId = session.items[session.items.length - 1]?.id;
  const list = useRef<VirtuosoHandle>(null);
  // Whether the reader is at the bottom. Only the reader's own scrolling changes it, so a diagram or highlighted code
  // that makes the list taller after it was drawn does not lose the position.
  const stick = useRef(true);

  return (
    <div className="transcript">
      <Virtuoso
        key={session.id}
        ref={list}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
        totalListHeightChanged={() => {
          if (stick.current) list.current?.scrollToIndex({ index: 'LAST', align: 'end' });
        }}
        style={{ height: '100%' }}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        data={session.items}
        computeItemKey={(_index, item) => item.id}
        // Follow new text only while the reader is at the bottom; scrolling up stops it.
        followOutput={() => (stick.current ? 'auto' : false)}
        increaseViewportBy={600}
        itemContent={(_index, item) => (
          <div className={`row${item.subtaskId ? ' subtask' : ''}`}>
            <Item
              item={item}
              tool={item.toolCallId === undefined ? undefined : tools.get(item.toolCallId)}
              streaming={busy && item.id === lastId}
              sessionId={session.id}
            />
          </div>
        )}
        {...testProps}
      />
    </div>
  );
}

const Item = memo(function Item({
  item,
  tool,
  streaming,
  sessionId,
}: {
  item: ItemView;
  tool: ToolView | undefined;
  streaming: boolean;
  sessionId: string;
}) {
  const t = useT();
  switch (item.kind) {
    case 'user':
      return (
        <div className="message user">
          <div className="author">{t('You')}</div>
          <div className="text">{item.text}</div>
          {item.attachments && (
            <div className="chips sent">
              {item.attachments.map((label, index) => (
                <span className="chip" key={index}>
                  <span className="chip-label">{label}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="message assistant">
          <div className="author">{t('Kiro')}</div>
          <Markdown text={item.text} streaming={streaming} />
        </div>
      );
    case 'thought':
      return (
        <details className="message thought">
          <summary>
            {streaming && <span className="spinner small" aria-hidden="true" />} {t('Thinking')}
          </summary>
          <Markdown text={item.text} streaming={streaming} />
        </details>
      );
    case 'notice':
      return <div className={`notice ${item.level ?? 'info'}`}>{item.text}</div>;
    case 'tool':
      return tool ? <ToolCard tool={tool} sessionId={sessionId} /> : null;
  }
});
