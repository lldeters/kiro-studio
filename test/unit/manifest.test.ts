import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    views: Record<string, { id: string; when?: string }[]>;
    viewsWelcome: { view: string; contents: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    configuration: { properties: Record<string, { default?: unknown; enum?: string[] }> };
  };
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
const commands = new Set(manifest.contributes.commands.map((c) => c.command));
const views = new Set(Object.values(manifest.contributes.views).flatMap((list) => list.map((v) => v.id)));
const nls = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>;

describe('manifest', () => {
  it('lists every command only once', () => {
    expect(manifest.contributes.commands.length).toBe(commands.size);
  });

  it('puts only declared commands into the menus', () => {
    const used = Object.values(manifest.contributes.menus).flatMap((entries) => entries.map((e) => e.command));
    expect(used.filter((id) => !commands.has(id))).toEqual([]);
  });

  it('shows menus only on views that exist', () => {
    const ids = Object.values(manifest.contributes.menus)
      .flatMap((entries) => entries.map((e) => e.when ?? ''))
      .flatMap((when) => [...when.matchAll(/view == ([\w.]+)/g)].map((m) => m[1] ?? ''));
    expect(ids.filter((id) => !views.has(id))).toEqual([]);
  });

  it('gives welcome content only to views that exist, and links only to declared commands', () => {
    for (const entry of manifest.contributes.viewsWelcome) expect(views.has(entry.view), entry.view).toBe(true);
    const linked = manifest.contributes.viewsWelcome
      .flatMap((entry) => [...(nls[entry.contents.replace(/%/g, '')] ?? '').matchAll(/command:([\w.]+)/g)])
      .map((m) => m[1] ?? '');
    expect(linked.filter((id) => !commands.has(id) && !id.startsWith('workbench.'))).toEqual([]);
  });

  it('has a title for every command and a name for every view', () => {
    for (const command of manifest.contributes.commands)
      expect(nls[command.title.replace(/%/g, '')], command.command).toBeTruthy();
    for (const id of views) expect(manifest.contributes.views['kiro-studio']?.find((v) => v.id === id)).toBeDefined();
  });

  it('shows the chat in the editor by default and as a sidebar view only when asked', () => {
    const setting = manifest.contributes.configuration.properties['kiroStudio.chatLocation'];
    expect(setting?.default).toBe('editor');
    expect(setting?.enum).toEqual(['editor', 'sidebar']);
    const chat = manifest.contributes.views['kiro-studio']?.find((v) => v.id === 'kiroStudio.chat');
    expect(chat?.when).toBe("config.kiroStudio.chatLocation == 'sidebar'");
    // Every other view stays in the sidebar whatever the setting says.
    const others = manifest.contributes.views['kiro-studio']?.filter((v) => v.id !== 'kiroStudio.chat') ?? [];
    expect(others.filter((v) => v.when !== undefined)).toEqual([]);
  });

  it('offers to open the chat from the sessions view, where the menu now starts', () => {
    const entries = manifest.contributes.menus['view/title'] ?? [];
    const onSessions = entries
      .filter((e) => (e.when ?? '').includes('view == kiroStudio.sessions'))
      .map((e) => e.command);
    expect(onSessions).toContain('kiroStudio.openChat');
    expect(onSessions).toContain('kiroStudio.newSession');
  });
});
