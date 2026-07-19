/** Bundled example models, imported as raw text at build time. */
const modules = import.meta.glob('../../examples/shallow/*.hs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const examples: { name: string; source: string }[] = Object.entries(modules)
  .map(([path, source]) => ({
    name: path.split('/').pop()!.replace(/\.hs$/, ''),
    source,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
