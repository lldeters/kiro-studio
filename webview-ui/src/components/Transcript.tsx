import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { CheckpointView, ItemView, SessionView, ToolView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';
import { formatCredits, formatDuration } from '../../../src/shared/format';
import { waitingForOutput } from '../thinking';
import { CheckpointCard } from './CheckpointCard';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

/** In tests there is no layout, so the list is told how many items to render. */
const testProps =
  import.meta.env.MODE === 'test' ? ({ initialItemCount: 1000, initialTopMostItemIndex: 0 } as const) : {};

/** The last row while Kiro works without showing anything yet. A row of the list, so that the list follows it. */
const THINKING = { id: -1, kind: 'thinking' } as const;
type Row = ItemView | typeof THINKING;

export function Transcript({ session }: { session: SessionView }) {
  const tools = new Map(session.tools.map((tool) => [tool.toolCallId, tool]));
  const checkpoints = new Map((session.checkpoints ?? []).map((checkpoint) => [checkpoint.id, checkpoint]));
  const busy = session.phase !== 'idle';
  const lastId = session.items[session.items.length - 1]?.id;
  const thinking = waitingForOutput(session);
  const rows = useMemo<Row[]>(
    () => (thinking ? [...session.items, THINKING] : session.items),
    [session.items, thinking],
  );
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
        data={rows}
        computeItemKey={(_index, item) => item.id}
        // Follow new text only while the reader is at the bottom; scrolling up stops it.
        followOutput={() => (stick.current ? 'auto' : false)}
        increaseViewportBy={600}
        itemContent={(_index, item) =>
          item.kind === 'thinking' ? (
            <div className="row">
              <Thinking />
            </div>
          ) : (
            <div className={`row${item.subtaskId ? ' subtask' : ''}`}>
              <Item
                item={item}
                tool={item.toolCallId === undefined ? undefined : tools.get(item.toolCallId)}
                streaming={busy && item.id === lastId}
                sessionId={session.id}
                checkpoint={item.checkpointId === undefined ? undefined : checkpoints.get(item.checkpointId)}
              />
            </div>
          )
        }
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
  checkpoint,
}: {
  item: ItemView;
  tool: ToolView | undefined;
  streaming: boolean;
  sessionId: string;
  checkpoint: CheckpointView | undefined;
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
      return <Thought text={item.text} streaming={streaming} />;
    case 'notice':
      return <div className={`notice ${item.level ?? 'info'}`}>{item.text}</div>;
    case 'tool':
      return tool ? <ToolCard tool={tool} sessionId={sessionId} /> : null;
    case 'checkpoint':
      return checkpoint ? <CheckpointCard checkpoint={checkpoint} sessionId={sessionId} /> : null;
    case 'usage':
      return <TurnUsage credits={item.credits} elapsedMs={item.elapsedMs} />;
  }
});

/** What a finished turn cost and how long it took, under its answer. */
function TurnUsage({ credits, elapsedMs }: { credits: number | undefined; elapsedMs: number | undefined }) {
  const t = useT();
  const locale = document.documentElement.lang || undefined;
  const parts = [
    ...(credits === undefined ? [] : [t('{0} credits', formatCredits(credits, locale))]),
    ...(elapsedMs === undefined ? [] : [formatDuration(elapsedMs, locale, t)]),
  ];
  if (parts.length === 0) return null;
  return (
    <div className="turn-usage" title={t('What this answer cost')}>
      <span className="codicon codicon-credit-card" aria-hidden="true" />
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

/** "Kiro is thinking…", shimmering in the accent colour. Not a live region: the end of the turn is announced. */
function Thinking() {
  const t = useT();
  return (
    <div className="thinking">
      <span className="codicon codicon-sparkle thinking-icon" aria-hidden="true" />
      <span className="shimmer">{t('Kiro is thinking…')}</span>
    </div>
  );
}

/**
 * Kiro's reasoning. Open while it streams, so it can be read as it comes, following its end while the reader is there;
 * closed once Kiro has moved on, unless the reader opened or closed it.
 */
function Thought({ text, streaming }: { text: string; streaming: boolean }) {
  const t = useT();
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? streaming;
  const body = useRef<HTMLDivElement>(null);
  // Whether the reader is at the end of the reasoning; scrolling up to read stops the following, as in the list.
  const stick = useRef(true);
  useEffect(() => {
    const element = body.current;
    if (streaming && element && stick.current) element.scrollTop = element.scrollHeight;
  }, [text, streaming]);
  return (
    <details className={`message thought${streaming ? ' streaming' : ''}`} open={open}>
      <summary
        onClick={(event) => {
          // The state decides, so that the end of the streaming can close it.
          event.preventDefault();
          setChosen(!open);
        }}
      >
        {streaming ? (
          <>
            <span className="codicon codicon-sparkle thinking-icon" aria-hidden="true" />
            <span className="shimmer">{t('Thinking…')}</span>
          </>
        ) : (
          t('Thought process')
        )}
      </summary>
      <div
        className="thought-body"
        ref={body}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
        }}
      >
        <Markdown text={text} streaming={streaming} />
      </div>
    </details>
  );
}
