/**
 * Specs: a folder `.kiro/specs/<name>` with `requirements.md` (a bugfix spec has `bugfix.md` instead), `design.md` and
 * `tasks.md`.
 */
import { baseName, join, type FileReader } from './reader';
import { parseTasks, taskProgress, type TaskItem, type TaskProgress } from './tasks';

export type SpecProgress = TaskProgress;

export type SpecDocument = 'requirements' | 'bugfix' | 'design' | 'tasks';

/** The documents in the order of the workflow. */
export const SPEC_DOCUMENTS: readonly SpecDocument[] = ['requirements', 'bugfix', 'design', 'tasks'];

export interface SpecInfo {
  name: string;
  dir: string;
  requirements?: string;
  /** The analysis of a bugfix spec, which takes the place of the requirements. */
  bugfix?: string;
  design?: string;
  tasks?: string;
  /** The tasks in `tasks.md`; undefined without that file. */
  taskItems?: TaskItem[];
  /** From the tasks in `tasks.md`; undefined without that file. */
  progress?: SpecProgress;
}

/** Counts the tasks of a `tasks.md`, see {@link taskProgress}. */
export function parseTaskProgress(markdown: string): SpecProgress {
  return taskProgress(parseTasks(markdown));
}

export async function readSpecs(reader: FileReader, specsDir: string): Promise<SpecInfo[]> {
  const folders = (await reader.list(specsDir)).filter((e) => e.type === 'directory');
  const specs = await Promise.all(
    folders.map(async (folder): Promise<SpecInfo> => {
      const dir = join(specsDir, folder.name);
      const present = new Set((await reader.list(dir)).filter((e) => e.type === 'file').map((e) => e.name));
      const spec: SpecInfo = { name: folder.name, dir };
      for (const doc of SPEC_DOCUMENTS) if (present.has(`${doc}.md`)) spec[doc] = join(dir, `${doc}.md`);
      if (spec.tasks !== undefined) {
        spec.taskItems = parseTasks((await reader.readText(spec.tasks)) ?? '');
        spec.progress = taskProgress(spec.taskItems);
      }
      return spec;
    }),
  );
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SpecContents {
  name: string;
  documents: { kind: SpecDocument; path: string; text: string }[];
}

/** The documents of one spec with their text, or undefined when the folder is gone or holds no document. */
export async function readSpecContents(reader: FileReader, dir: string): Promise<SpecContents | undefined> {
  const present = new Set((await reader.list(dir)).filter((e) => e.type === 'file').map((e) => e.name));
  const documents = await Promise.all(
    SPEC_DOCUMENTS.filter((doc) => present.has(`${doc}.md`)).map(async (kind) => {
      const path = join(dir, `${kind}.md`);
      return { kind, path, text: (await reader.readText(path)) ?? '' };
    }),
  );
  return documents.length === 0 ? undefined : { name: baseName(dir), documents };
}
