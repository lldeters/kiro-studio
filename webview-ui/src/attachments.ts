import { IMAGE_TYPES, MAX_IMAGE_BASE64_CHARS, type AttachmentView } from '../../src/shared/chatProtocol';
import { selectionLabel, terminalLabel } from '../../src/shared/format';

/** `file:///c%3A/ws/a.ts` or `file:///home/me/a.ts` to a path. Other schemes give undefined. */
export function fileUriToPath(uri: string): string | undefined {
  if (!/^file:\/\//i.test(uri)) return undefined;
  try {
    const { pathname } = new URL(uri);
    const decoded = decodeURIComponent(pathname);
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return undefined;
  }
}

/** The files named in what was dropped (VS Code's explorer drops `text/uri-list`; some sources use `resourceurls`). */
export function droppedPaths(data: Pick<DataTransfer, 'getData'>): string[] {
  const uris: string[] = [];
  for (const line of data.getData('text/uri-list').split(/\r?\n/))
    if (line && !line.startsWith('#')) uris.push(line.trim());
  const resources = data.getData('resourceurls');
  if (resources) {
    try {
      const parsed: unknown = JSON.parse(resources);
      if (Array.isArray(parsed)) for (const entry of parsed) if (typeof entry === 'string') uris.push(entry);
    } catch {
      // not JSON: ignore
    }
  }
  return [...new Set(uris.flatMap((uri) => fileUriToPath(uri) ?? []))];
}

export const isImageType = (type: string): boolean => (IMAGE_TYPES as readonly string[]).includes(type);

/** Reads an image file into an attachment; undefined when it is not a supported type or too large. */
export function readImage(file: File): Promise<AttachmentView | undefined> {
  if (!isImageType(file.type)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(undefined);
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const data = result.slice(result.indexOf(',') + 1);
      resolve(
        data === '' || data.length > MAX_IMAGE_BASE64_CHARS
          ? undefined
          : { kind: 'image', mimeType: file.type, data, name: file.name || 'image' },
      );
    };
    reader.readAsDataURL(file);
  });
}

export function attachmentLabel(attachment: AttachmentView): string {
  switch (attachment.kind) {
    case 'file':
      return attachment.path.split(/[\\/]/).filter(Boolean).pop() ?? attachment.path;
    case 'folder':
      return `${attachment.path.split(/[\\/]/).filter(Boolean).pop() ?? attachment.path}/`;
    case 'selection':
      return selectionLabel(attachment);
    case 'terminal':
      return terminalLabel(attachment);
    case 'problems':
      return 'Problems';
    case 'gitDiff':
      return 'git diff';
    case 'image':
      return attachment.name;
  }
}
