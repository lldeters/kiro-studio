/** Specs: a folder `.kiro/specs/<name>` with `requirements.md`, `design.md` and `tasks.md`. */
import { join, type FileReader } from './reader';

export interface SpecProgress {
  done: number;
  total: number;
}

export interface SpecInfo {
  name: string;
  dir: string;
  requirements?: string;
  design?: string;
  tasks?: string;
  /** From the checkboxes in `tasks.md`; undefined without that file. */
  progress?: SpecProgress;
}

/**
 * Counts the task checkboxes (`- [ ]`, `- [x]`, also nested and with `*` or `+` bullets). A task marked in progress
 * (`- [-]`) is not done. The exact `tasks.md` format of Kiro is not confirmed (PLAN.md decision E3); the checkbox
 * lines are the part every version of it has.
 */
export function parseTaskProgress(markdown: string): SpecProgress {
  let done = 0;
  let total = 0;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const box = /^\s*[-*+]\s+\[([ xX-])\]/.exec(line);
    if (!box) continue;
    total++;
    if (box[1] === 'x' || box[1] === 'X') done++;
  }
  return { done, total };
}

const DOCS = ['requirements', 'design', 'tasks'] as const;

export async function readSpecs(reader: FileReader, specsDir: string): Promise<SpecInfo[]> {
  const folders = (await reader.list(specsDir)).filter((e) => e.type === 'directory');
  const specs = await Promise.all(
    folders.map(async (folder): Promise<SpecInfo> => {
      const dir = join(specsDir, folder.name);
      const present = new Set((await reader.list(dir)).filter((e) => e.type === 'file').map((e) => e.name));
      const spec: SpecInfo = { name: folder.name, dir };
      for (const doc of DOCS) if (present.has(`${doc}.md`)) spec[doc] = join(dir, `${doc}.md`);
      if (spec.tasks !== undefined) spec.progress = parseTaskProgress((await reader.readText(spec.tasks)) ?? '');
      return spec;
    }),
  );
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}
