/** Bundled example models, imported as raw text at build time. */
const fixtures = import.meta.glob('../../examples/shallow/*.hs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// lessons live apart from the fixtures: the parity tests walk examples/shallow
const lessons = import.meta.glob('../../examples/lessons/*.hs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface Example {
  name: string;
  /** What the picker shows. */
  label: string;
  group: 'Lessons' | 'Test fixtures';
  source: string;
}

const load = (mods: Record<string, string>, group: Example['group']): Example[] =>
  Object.entries(mods)
    .map(([path, source]) => {
      const name = path.split('/').pop()!.replace(/\.hs$/, '');
      // 03_fork_and_join -> "3. fork and join"
      const lesson = /^(\d+)_(.*)$/.exec(name);
      const label = lesson ? `${Number(lesson[1])}. ${lesson[2]!.replace(/_/g, ' ')}` : name;
      return { name, label, group, source };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

export const examples: Example[] = [...load(lessons, 'Lessons'), ...load(fixtures, 'Test fixtures')];
