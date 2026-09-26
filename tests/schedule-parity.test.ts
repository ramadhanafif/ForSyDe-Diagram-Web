import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/core/parser';
import { elaborate } from '../src/core/elaborate';
import { buildChannels, computeScheduleAndBuffers, type Edge } from '../src/core/schedule';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

// The *.ir.json files hold no schedule data, so the reference here is the
// devtools firing rule itself: fire the first fireable actor, restart at the
// first. The app schedules round robin (lecture notes order), so the orders
// differ; what must still match is the repetition vector and the verdict, and
// the app's schedule must be a valid PASS needing no more buffer per channel.
const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.hs'))
  .map((f) => f.replace(/\.hs$/, ''));

/** Max tokens per edge over `order`, or null if some firing lacks tokens or the state does not return. */
function replay(edges: Edge[], order: string[]): number[] | null {
  const tokens = edges.map((e) => e.initTokens);
  const max = [...tokens];
  for (const a of order) {
    for (const [i, e] of edges.entries())
      if (e.dst === a && (tokens[i]! -= e.cons) < 0) return null;
    for (const [i, e] of edges.entries()) if (e.src === a) tokens[i]! += e.prod;
    tokens.forEach((t, i) => (max[i] = Math.max(max[i]!, t)));
  }
  return tokens.every((t, i) => t === edges[i]!.initTokens) ? max : null;
}

/** The devtools order: the first fireable actor, every time. */
function firstFireable(actors: string[], edges: Edge[], q: Map<string, number>): string[] {
  const left = new Map(q);
  const tokens = edges.map((e) => e.initTokens);
  const out: string[] = [];
  for (;;) {
    const a = actors.find(
      (x) => left.get(x)! > 0 && edges.every((e, i) => e.dst !== x || tokens[i]! >= e.cons),
    );
    if (!a) return out;
    edges.forEach((e, i) => {
      if (e.dst === a) tokens[i]! -= e.cons;
      if (e.src === a) tokens[i]! += e.prod;
    });
    left.set(a, left.get(a)! - 1);
    out.push(a);
  }
}

describe('schedule parity over fixtures', () => {
  expect(names.length).toBeGreaterThan(30);

  for (const name of names) {
    it(`${name} is a valid PASS no bigger than the devtools order`, () => {
      const source = readFileSync(join(FIXTURES, `${name}.hs`), 'utf8');

      const { module: mod, diagnostics: parseDiags } = parse(source);
      expect(parseDiags.filter((d) => d.severity === 'error')).toEqual([]);
      const { ir, diagnostics: elabDiags } = elaborate(mod);
      expect(elabDiags.filter((d) => d.severity === 'error')).toEqual([]);
      expect(ir).not.toBeNull();

      const r = computeScheduleAndBuffers(ir!);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([...r.repetitions.values()].every((v) => v > 0)).toBe(true);
      expect(r.buffers.every(([, n]) => n >= 0)).toBe(true);

      const conv = buildChannels(ir!);
      if ('error' in conv) throw new Error('no channels');
      const actors = conv.actors.map((a) => a.name);
      // each actor fires q times
      for (const a of actors)
        expect(r.schedule.filter((x) => x === a).length, a).toBe(r.repetitions.get(a));
      const mine = replay(conv.edges, r.schedule);
      expect(mine).not.toBeNull();
      const ref = firstFireable(actors, conv.edges, r.repetitions);
      expect(ref.length).toBe(r.schedule.length);
      const theirs = replay(conv.edges, ref)!;
      conv.edges.forEach((e, i) => expect(mine![i], e.edgeName).toBeLessThanOrEqual(theirs[i]!));
    });
  }
});
