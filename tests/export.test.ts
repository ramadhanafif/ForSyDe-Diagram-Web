import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDelay } from '../src/core/ir';
import { sceneToTikz, texText } from '../src/export/tikz';
import { layout } from '../src/layout';
import { estimateMeasureFor } from '../src/scene/measure';
import type { DiagramStyle } from '../src/scene/types';
import { ALL_ON, DEFAULT_FLAGS, loadFixtures } from './helpers/fixtures';

const fixtures = loadFixtures();

function tikzFor(name: string, style: DiagramStyle, flags = DEFAULT_FLAGS) {
  const fx = fixtures.find((f) => f.name === name)!;
  const scene = layout({
    ir: fx.ir,
    schedule: fx.schedule,
    flags,
    measure: estimateMeasureFor(style),
    style,
  });
  const tokens = new Map(fx.ir.processes.filter(isDelay).map((d) => [d.name, d.tokens.length]));
  return { scene, tex: sceneToTikz(scene, { style, tokens }) };
}

const balanced = (s: string) => {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++; // an escaped brace is text
      continue;
    }
    if (s[i] === '{') depth++;
    if (s[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
};

const hasPdflatex = (() => {
  try {
    execFileSync('pdflatex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('sceneToTikz', () => {
  it('draws every edge and label, with balanced braces, for every fixture in both styles', () => {
    for (const fx of fixtures)
      for (const style of ['lecture', 'modern'] as const) {
        const { scene, tex } = tikzFor(fx.name, style, ALL_ON);
        const arrows = tex.split('\n').filter((l) => l.startsWith('\\draw[-{Stealth'));
        expect(arrows.length, `${fx.name} ${style}`).toBe(scene.edges.length);
        const nodes = tex.split('\n').filter((l) => l.startsWith('\\node[')).length;
        // every non-strip label is a node; plus the System title and the io names
        const io = scene.nodes.filter((n) => n.kind === 'io').length;
        const strips = style === 'modern' ? scene.labels.filter((l) => l.kind === 'buffer') : [];
        const bars = strips.filter((l) => Number(/\d+/.exec(l.text)?.[0]) > 8).length;
        expect(nodes, `${fx.name} ${style}`).toBe(
          scene.labels.length - strips.length + 1 + io + bars,
        );
        expect(balanced(tex), `${fx.name} ${style}`).toBe(true);
      }
  });

  it('escapes LaTeX specials in text', () => {
    expect(texText('a_b#c$d%e&f{g}h~i^j\\k')).toBe(
      'a\\_b\\#c\\$d\\%e\\&f\\{g\\}h\\textasciitilde{}i\\textasciicircum{}j\\textbackslash{}k',
    );
  });

  it.skipIf(!hasPdflatex)(
    'compiles with pdflatex',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'fsd-tikz-'));
      try {
        for (const name of [
          'SDF_example_002',
          'SDF_example_003',
          'SDF_example_010',
          'SDF_example_024',
          'SDF_example_027',
        ])
          for (const style of ['lecture', 'modern'] as const) {
            const file = `${name}-${style}.tex`;
            writeFileSync(join(dir, file), tikzFor(name, style, ALL_ON).tex);
            execFileSync('pdflatex', ['-halt-on-error', '-interaction=nonstopmode', file], {
              cwd: dir,
              stdio: 'pipe',
              timeout: 60_000,
            });
          }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
