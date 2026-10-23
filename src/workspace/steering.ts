/** Steering files: Markdown in `.kiro/steering` that tells Kiro how the project works. */
import { firstHeading, parseFrontMatter } from './frontmatter';
import { join, stripExtension, type FileReader } from './reader';

export type SteeringScope = 'workspace' | 'global';

export interface SteeringFile {
  name: string;
  path: string;
  scope: SteeringScope;
  /** `always`, `fileMatch`, `manual` or `auto`; `always` when the file does not say. */
  inclusion: string;
  /** For `fileMatch`: the pattern or patterns. */
  patterns: string[];
  description?: string;
  title?: string;
}

export function parseSteering(text: string, path: string, scope: SteeringScope): SteeringFile {
  const { data, body } = parseFrontMatter(text);
  const pattern = data.fileMatchPattern;
  const description = typeof data.description === 'string' ? data.description : undefined;
  const title = firstHeading(body);
  return {
    name: stripExtension(path.split(/[\\/]/).pop() ?? path, '.md'),
    path,
    scope,
    inclusion: typeof data.inclusion === 'string' ? data.inclusion : 'always',
    patterns: Array.isArray(pattern) ? pattern : typeof pattern === 'string' ? [pattern] : [],
    ...(description === undefined ? {} : { description }),
    ...(title === undefined ? {} : { title }),
  };
}

/** The steering files of one `.kiro/steering` folder. */
export async function readSteering(reader: FileReader, dir: string, scope: SteeringScope): Promise<SteeringFile[]> {
  const entries = (await reader.list(dir)).filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.md'));
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return parseSteering((await reader.readText(path)) ?? '', path, scope);
    }),
  );
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** A new steering file: the front matter says how it is included, the body is for the user to fill. */
export function steeringTemplate(name: string, inclusion: 'always' | 'fileMatch' | 'manual' = 'always'): string {
  const matcher = inclusion === 'fileMatch' ? 'fileMatchPattern: "**/*"\n' : '';
  return `---\ninclusion: ${inclusion}\n${matcher}---\n\n# ${name}\n\n`;
}

/** The prompt that asks Kiro to write the foundational steering files for the workspace. */
export const GENERATE_STEERING_PROMPT =
  'Look through this workspace and create the foundational steering files in .kiro/steering: product.md (what the ' +
  'product is and who it is for), tech.md (languages, frameworks, tools, commands to build and test) and structure.md ' +
  '(folder layout and naming conventions). Keep each file short and factual, and include `inclusion: always` in the ' +
  'front matter. Do not change any other file.';
