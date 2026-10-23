import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type { AttachmentView, SessionView } from '../../../src/shared/chatProtocol';
import { MAX_ATTACHMENTS } from '../../../src/shared/chatProtocol';
import { attachmentLabel, droppedPaths, isImageType, readImage } from '../attachments';
import { computeMenu, type MenuItem } from '../composerMenu';
import { useT } from '../i18n';
import { EMPTY_DRAFT, useChat } from '../store';
import { post } from '../vscode';
import { SuggestMenu } from './SuggestMenu';

export function Composer({ session }: { session: SessionView }) {
  const t = useT();
  const menuId = useId();
  const draft = useChat((s) => s.drafts[session.id]) ?? EMPTY_DRAFT;
  const setDraft = useChat((s) => s.setDraft);
  const takePicked = useChat((s) => s.takePicked);
  const picked = useChat((s) => s.picked);
  const imagesAccepted = useChat((s) => s.capabilities.image);
  const { text, attachments } = draft;

  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(text.length);
  const [selected, setSelected] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string>();

  const busy = session.phase !== 'idle';
  const canSend = session.status === 'ready' && !busy && (text.trim() !== '' || attachments.length > 0);

  const menu = useMemo(() => computeMenu(text, caret, session.commands, t), [text, caret, session.commands, t]);
  const menuOpen = menu !== undefined && dismissedAt !== `${text}|${caret}` && session.status === 'ready';

  const update = (next: Partial<typeof draft>) => setDraft(session.id, { ...draft, ...next });
  const addAttachments = (added: AttachmentView[]) => {
    if (added.length === 0) return;
    const known = new Set(attachments.map((a) => JSON.stringify(a)));
    const fresh = added.filter((a) => !known.has(JSON.stringify(a)));
    update({ attachments: [...attachments, ...fresh].slice(0, MAX_ATTACHMENTS) });
  };

  // What the host picked (files, folders...) joins the draft of the session on screen.
  useEffect(() => {
    if (picked.length > 0) {
      const taken = takePicked();
      const known = new Set(attachments.map((a) => JSON.stringify(a)));
      update({
        attachments: [...attachments, ...taken.filter((a) => !known.has(JSON.stringify(a)))].slice(0, MAX_ATTACHMENTS),
      });
    }
    // `update` and `attachments` change with every keystroke; only a new pick matters here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  // The box grows with its content, up to a limit.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  const send = () => {
    if (!canSend) return;
    post({ type: 'send', sessionId: session.id, text, attachments });
    setDraft(session.id, EMPTY_DRAFT);
    setCaret(0);
  };
  const cancel = () => post({ type: 'cancel', sessionId: session.id });

  const choose = (item: MenuItem) => {
    if (!menu) return;
    const rest = text.slice(0, menu.start) + (item.insert ?? '') + text.slice(menu.end);
    const position = menu.start + (item.insert?.length ?? 0);
    if (item.action?.type === 'attach') {
      update({
        text: rest,
        attachments: [...attachments.filter((a) => a.kind !== item.action?.kind), { kind: item.action.kind }],
      });
    } else {
      update({ text: rest });
      if (item.action?.type === 'pick') post({ type: 'pickContext', kind: item.action.kind });
    }
    setSelected(0);
    setCaret(position);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && menu) {
      const count = menu.items.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((index) => (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        const item = menu.items[Math.min(selected, count - 1)];
        if (item) choose(item);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedAt(`${text}|${caret}`);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && busy) {
      event.preventDefault();
      cancel();
    }
  };

  const addFiles = async (files: Iterable<File>) => {
    if (!imagesAccepted) return;
    const images = await Promise.all([...files].filter((f) => isImageType(f.type)).map(readImage));
    addAttachments(images.filter((image): image is AttachmentView => image !== undefined));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((f) => isImageType(f.type));
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
    addAttachments(droppedPaths(event.dataTransfer).map((path) => ({ kind: 'file', path })));
  };

  return (
    <div className="composer-wrap" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {menuOpen && menu && (
        <SuggestMenu
          id={menuId}
          items={menu.items}
          selected={Math.min(selected, menu.items.length - 1)}
          onChoose={choose}
        />
      )}
      {attachments.length > 0 && (
        <div className="chips">
          {attachments.map((attachment, index) => (
            <span className="chip" key={index} title={'path' in attachment ? attachment.path : undefined}>
              {attachment.kind === 'image' ? (
                <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" className="chip-thumb" />
              ) : (
                <span className={`codicon codicon-${chipIcon(attachment)}`} aria-hidden="true" />
              )}
              <span className="chip-label">{attachmentLabel(attachment)}</span>
              <button
                className="icon-button"
                aria-label={t('Remove {0}', attachmentLabel(attachment))}
                title={t('Remove {0}', attachmentLabel(attachment))}
                onClick={() => update({ attachments: attachments.filter((_, i) => i !== index) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <button
          className="icon-button attach"
          title={t('Add context (#)')}
          aria-label={t('Add context (#)')}
          disabled={session.status !== 'ready'}
          onClick={() => {
            const withHash = text === '' || /\s$/.test(text) ? `${text}#` : `${text} #`;
            update({ text: withHash });
            setCaret(withHash.length);
            requestAnimationFrame(() => {
              area.current?.focus();
              area.current?.setSelectionRange(withHash.length, withHash.length);
            });
          }}
        >
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>
        <textarea
          ref={area}
          value={text}
          rows={1}
          aria-label={t('Ask Kiro…')}
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen ? `${menuId}-${selected}` : undefined}
          aria-autocomplete="list"
          placeholder={t('Ask Kiro…')}
          title={t('Enter sends, Shift+Enter adds a line, Esc stops.')}
          disabled={session.status !== 'ready'}
          onChange={(event) => {
            update({ text: event.target.value });
            setCaret(event.target.selectionStart);
            setSelected(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <button className="secondary" onClick={cancel} disabled={session.phase === 'cancelling'}>
            {session.phase === 'cancelling' ? t('Stopping…') : t('Stop')}
          </button>
        ) : (
          <button className="primary" onClick={send} disabled={!canSend}>
            {t('Send')}
          </button>
        )}
      </div>
    </div>
  );
}

function chipIcon(attachment: AttachmentView): string {
  switch (attachment.kind) {
    case 'folder':
      return 'folder';
    case 'problems':
      return 'warning';
    case 'gitDiff':
      return 'git-compare';
    default:
      return 'file';
  }
}
