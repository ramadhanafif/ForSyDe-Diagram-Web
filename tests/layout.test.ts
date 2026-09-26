import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySplices } from '../src/core/edits';
import { elaborate } from '../src/core/elaborate';
import { editValue, inlineEdit } from '../src/core/inlineEdit';
import type { IRSystem } from '../src/core/ir';
import { sourceSpans } from '../src/core/links';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers, type ScheduleResult } from '../src/core/schedule';
import { layout } from '../src/layout';
import { orderLayers, WORK_BUDGET, type Item, type Piece } from '../src/layout/order';
import { estimateMeasureFor, FIFO, fifoSize } from '../src/scene/measure';
import { drawnPoints, rectAxisSegmentDist, scoreScene, segments } from '../src/scene/metrics';
import type { DiagramStyle, LabelFlags, Scene } from '../src/scene/types';
import { validateScene } from '../src/scene/validate';
import { evaluateLayout, writeReport } from './helpers/evaluate';
import { ALL_FLAGS, ALL_ON, DEFAULT_FLAGS, loadFixtures } from './helpers/fixtures';
import { dumpScenes } from './helpers/sceneSvg';

interface Model {
  ir: IRSystem;
  schedule: ScheduleResult;
}

function compile(src: string): Model {
  const { ir } = elaborate(parse(src).module);
  if (!ir) throw new Error('model does not elaborate');
  return { ir, schedule: computeScheduleAndBuffers(ir) };
}

const STYLES: DiagramStyle[] = ['lecture', 'modern'];

const run = (m: Model, flags: LabelFlags, prev?: Scene, style: DiagramStyle = 'lecture') =>
  layout({ ...m, flags, measure: estimateMeasureFor(style), style, prev });

const errorsOf = (m: Model, scene: Scene, flags: LabelFlags, style: DiagramStyle = 'lecture') =>
  validateScene(scene, m.ir, {
    schedule: m.schedule,
    flags,
    measure: estimateMeasureFor(style),
    style,
  });

/** An actor with `ins` inputs and `outs` outputs, all rate 1. */
function actor(name: string, ins: number, outs: number): string {
  const tuple = (n: number, t: string) =>
    n === 1 ? t : `(${Array.from({ length: n }, () => t).join(', ')})`;
  const args = Array.from({ length: ins }, (_, i) => `x${i}`).join(' ');
  return [
    `${name} :: ${'Signal Int -> '.repeat(ins)}${tuple(outs, 'Signal Int')}`,
    `${name} ${args} = actor${ins}${outs}SDF ${tuple(ins, '1')} ${tuple(outs, '1')} f ${args}`,
  ].join('\n');
}

const DELAY = (name: string) => `${name} :: Signal Int -> Signal Int\n${name} s = delaySDF [0] s`;

function model(system: string[], procs: string[]): Model {
  return compile(['module T where', 'import ForSyDe.Shallow', ...system, ...procs].join('\n'));
}

/**
 * `layers` x `per` actors with two inputs and two outputs each. Every actor
 * consumes two signals not yet consumed, drawn from the system inputs (first
 * layer) or any earlier actor's outputs; what nobody consumes is a system
 * output. Deterministic for a seed.
 */
function randomModel(layers: number, per: number, seed: number): string {
  const inputs = Array.from({ length: 2 * per }, (_, i) => `s_in_${i}`);
  const free = [...inputs];
  let state = seed;
  /** Remove and return a random not-yet-consumed signal. */
  const take = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return free.splice(state % free.length, 1)[0]!;
  };
  const lines: string[] = [];
  const procs: string[] = [];
  for (let l = 0; l < layers; l++) {
    const made: string[] = [];
    for (let i = 0; i < per; i++) {
      const name = `a_${l}_${i}`;
      lines.push(`    (s_${l}_${i}a, s_${l}_${i}b) = ${name} ${take()} ${take()}`);
      procs.push(actor(name, 2, 2));
      made.push(`s_${l}_${i}a`, `s_${l}_${i}b`);
    }
    free.push(...made);
  }
  const sig = (n: number) => Array.from({ length: n }, () => 'Signal Int').join(', ');
  return [
    'module R where',
    'import ForSyDe.Shallow',
    `system :: ${'Signal Int -> '.repeat(inputs.length)}(${sig(free.length)})`,
    `system ${inputs.join(' ')} = (${free.join(', ')})`,
    '  where',
    ...lines,
    ...procs,
  ].join('\n');
}

/** Every flag set in both styles: no validator complaint (bar `allowed`) and no overlap. */
function expectClean(m: Model, allowed: string[] = []): Scene[] {
  return STYLES.flatMap((style) =>
    ALL_FLAGS.map((flags) => {
      const scene = run(m, flags, undefined, style);
      const why = `${style} ${JSON.stringify(flags)}`;
      expect(errorsOf(m, scene, flags, style), why).toEqual(allowed);
      expect(scoreScene(scene).overlaps, why).toBe(0);
      // no redundant point, and no spike doubling back on itself, for the metrics to miss
      for (const e of scene.edges) expect(drawnPoints(e.points), e.id).toEqual(e.points);
      return scene;
    }),
  );
}

const node = (s: Scene, id: string) => s.nodes.find((n) => n.id === id)!;
const area = (s: Scene) => s.bounds.w * s.bounds.h;

describe('layout', () => {
  it('meets the hard gates on every fixture and flag set', async () => {
    const r = evaluateLayout(layout, { flags: ALL_FLAGS });
    const baseline = JSON.parse(
      readFileSync(new URL('../docs/layout-baseline.json', import.meta.url), 'utf8'),
    ).defaultFlags.perFixture as Record<string, { crossings: number; bends: number }>;

    // soft gate: crossings and bends no worse than elk per fixture, recorded only
    const worse = Object.entries(r.perFixture).flatMap(([fx, m]) => {
      const elk = baseline[fx];
      return elk && (m.crossings > elk.crossings || m.bends > elk.bends)
        ? [{ fixture: fx, crossings: [m.crossings, elk.crossings], bends: [m.bends, elk.bends] }]
        : [];
    });
    const sum = (k: 'crossings' | 'bends' | 'area') =>
      Object.values(r.perFixture).reduce((t, m) => t + m[k], 0);
    const defaults = { crossings: sum('crossings'), bends: sum('bends'), area: sum('area') };

    // budget: under 4 ms per fixture, as the median over the flag sets (warm
    // after the sweep above); a max is too noisy while other test files run
    const msMedian: Record<string, number> = {};
    for (const fx of loadFixtures()) {
      const ts = ALL_FLAGS.map((flags) => {
        const t0 = performance.now();
        run(fx, flags);
        return performance.now() - t0;
      }).sort((a, b) => a - b);
      msMedian[fx.name] = ts[ts.length >> 1]!;
    }
    writeReport('layout', { defaults, softGate: { worseThanElk: worse }, msMedian, ...r });
    await dumpScenes('layout', layout);

    expect(r.errors.slice(0, 3)).toEqual([]);
    expect(r.totals.overlaps).toBe(0);
    expect(r.nondeterministic).toEqual([]);
    // the design target is 4 ms (report.json msMedian), but identical code
    // measured 2.15 ms and 4.6 ms on this machine on different days, so the
    // gate is half a 16 ms frame: it catches real regressions, not CPU clocks
    for (const [fx, ms] of Object.entries(msMedian)) expect(ms, fx).toBeLessThan(8);
  }, 120_000);

  it('meets the hard gates in the modern style', () => {
    const r = evaluateLayout(layout, { flags: ALL_FLAGS, style: 'modern' });
    expect(r.errors.slice(0, 3)).toEqual([]);
    expect(r.totals.overlaps).toBe(0);
    expect(r.nondeterministic).toEqual([]);
  }, 120_000);

  it('draws a modern delay as a strip of its tokens with the edge straight through', () => {
    const m = model(
      [
        'system :: Signal Int -> Signal Int',
        'system s_in = s_out',
        '  where',
        '    s_1 = a_a s_in',
        '    s_2 = d_1 s_1',
        '    s_out = a_b s_2',
      ],
      [actor('a_a', 1, 1), DELAY('d_1').replace('[0]', '[0, 0, 0]'), actor('a_b', 1, 1)],
    );
    expectClean(m);
    const d = node(run(m, DEFAULT_FLAGS, undefined, 'modern'), 'd_1');
    expect(d.shape).toBe('strip');
    expect(d.box.w).toBeCloseTo(2 * FIFO.PAD + 3 * FIFO.SLOT_W + 2 * FIFO.GAP, 9);
    expect(d.box.h).toBeCloseTo(fifoSize(3, 0).h, 9);
    const [inp, out] = d.ports;
    expect([inp!.side, out!.side]).toEqual(['W', 'E']);
    expect(inp!.at.y).toBeCloseTo(d.box.y + d.box.h / 2, 9);
    expect(out!.at.y).toBeCloseTo(inp!.at.y, 9);
    expect(node(run(m, DEFAULT_FLAGS), 'd_1').shape).toBe('circle');
  });

  it('reserves a modern buffer label as its FIFO strip', () => {
    const measure = estimateMeasureFor('modern');
    expect(measure('buf 3', 'buffer')).toEqual(fifoSize(3, 0));
    // above MAX_SLOTS: a bar plus the count
    const w12 = estimateMeasureFor('lecture')('12', 'buffer').w;
    expect(measure('buf 12', 'buffer').w).toBeCloseTo(
      2 * FIFO.PAD + FIFO.BAR_W + FIFO.GAP + w12,
      9,
    );
    expect(measure('buf 3', 'signal')).toEqual(estimateMeasureFor('lecture')('buf 3', 'signal'));
  });

  it('reorders ports to save a crossing, tags them, and edits still hit the argument', () => {
    // a_b takes a_a's results swapped: one side trades its ports rather than
    // the edges crossing. Distinct rates show which argument a port is.
    const src = [
      'module T where',
      'import ForSyDe.Shallow',
      'system :: Signal Int -> Signal Int',
      'system s_in = s_out',
      '  where',
      '    (s_1, s_2) = a_a s_in',
      '    s_out = a_b s_2 s_1',
      'a_a :: Signal Int -> (Signal Int, Signal Int)',
      'a_a x = actor12SDF 1 (2, 3) f x',
      'a_b :: Signal Int -> Signal Int -> Signal Int',
      'a_b x y = actor21SDF (3, 2) 1 g x y',
    ].join('\n');
    const m = compile(src);
    for (const scene of expectClean(m)) {
      expect(scoreScene(scene).crossings).toBe(0);
      // a side is reordered when its ports, top to bottom, are not in index order
      const reordered = scene.nodes.flatMap((n) =>
        (['in', 'out'] as const).flatMap((dir) => {
          const ps = n.ports.filter((p) => p.dir === dir).sort((p, q) => p.at.y - q.at.y);
          return ps.some((p, i) => p.index !== i) ? [ps] : [];
        }),
      );
      expect(reordered).toHaveLength(1);
      const side = reordered[0]!;
      const tags = scene.labels.filter((l) => l.kind === 'index');
      expect(tags.map((l) => [l.owner, l.text]).sort()).toEqual(
        side.map((p) => [p.id, `#${p.index + 1}`]).sort(),
      );
      // the top port is argument 2: links and inline edit reach that rate
      const top = side[0]!;
      expect(top.index).toBe(1);
      const t = { kind: 'rate' as const, node: top.node, dir: top.dir, index: top.index };
      const [span] = sourceSpans(m.ir, src, t);
      expect(src.slice(span!.from, span!.to)).toBe(String(top.rate));
      expect(editValue(m.ir, t)).toBe(String(top.rate));
      const edited = inlineEdit(m.ir, src, t, '7');
      if (typeof edited === 'string') throw new Error(edited);
      const again = compile(applySplices(src, edited)).ir;
      const sig = again.signals.find((x) => x.name === top.signal)!;
      expect(top.dir === 'in' ? sig.target.rate : sig.source.rate).toBe(7);
    }
  });

  it('puts the system output of 002 rightmost with no crossing', () => {
    // s_4 loops back through d_1 to a_c; s_out leaves a_d from the top port so
    // it passes above the loop to a column of its own
    const m = compile(
      readFileSync(new URL('../fixtures/SDF_example_002.hs', import.meta.url), 'utf8'),
    );
    for (const scene of expectClean(m)) {
      expect(scoreScene(scene).crossings).toBe(0);
      const out = node(scene, 's_out');
      for (const n of scene.nodes) if (n !== out) expect(n.box.x + n.box.w).toBeLessThan(out.box.x);
      for (const e of scene.edges)
        if (e.feedback) for (const p of e.points) expect(p.x).toBeLessThan(out.box.x);
      const ys = node(scene, 'a_d')
        .ports.filter((p) => p.dir === 'out')
        .sort((p, q) => p.at.y - q.at.y);
      expect(ys.map((p) => p.signal)).toEqual(['s_out', 's_4']);
    }
  });

  it('draws a 4-input actor as a stadium with its ports in order', () => {
    const m = model(
      [
        'system :: Signal Int -> Signal Int -> Signal Int -> Signal Int -> Signal Int',
        'system s_a s_b s_c s_d = s_out',
        '  where',
        '    s_out = a_a s_a s_b s_c s_d',
      ],
      [actor('a_a', 4, 1)],
    );
    for (const scene of expectClean(m)) {
      const a = node(scene, 'a_a');
      expect(a.shape).toBe('stadium');
      expect(a.ports.filter((p) => p.dir === 'in').map((p) => p.signal)).toEqual([
        's_a',
        's_b',
        's_c',
        's_d',
      ]);
    }
    // io pills stacked at the port pitch: every input edge runs straight
    expect(scoreScene(run(m, DEFAULT_FLAGS)).bends).toBe(0);
  });

  it('routes a self-loop through a delay back around the actor', () => {
    const m = model(
      [
        'system :: Signal Int -> Signal Int',
        'system s_in = s_out',
        '  where',
        '    (s_out, s_fb) = a_a s_in s_d',
        '    s_d = d_1 s_fb',
      ],
      [actor('a_a', 2, 2), DELAY('d_1')],
    );
    for (const scene of expectClean(m)) {
      const back = scene.edges.filter((e) => e.feedback);
      expect(back.map((e) => e.id)).toEqual(['e_s_d_d_1_a_a']);
      expect(node(scene, 'd_1').layer).toBeGreaterThan(node(scene, 'a_a').layer);
      // it passes a_a clear of its box and enters the input port from the left
      const box = node(scene, 'a_a').box;
      const segs = segments(back[0]!.points);
      const [p, q] = segs.pop()!;
      for (const [a, b] of segs) expect(rectAxisSegmentDist(box, a, b)).toBeGreaterThan(0);
      expect(
        segs.some(([a, b]) => Math.min(a.x, b.x) < box.x && Math.max(a.x, b.x) > box.x + box.w),
      ).toBe(true);
      expect(p.y).toBeCloseTo(q.y, 9);
      expect(p.x).toBeLessThan(q.x);
    }
  });

  it('lays out disconnected components side by side in the same layers', () => {
    const m = model(
      [
        'system :: Signal Int -> Signal Int -> (Signal Int, Signal Int)',
        'system s_a s_b = (s_x, s_y)',
        '  where',
        '    s_1 = a_a s_a',
        '    s_x = a_b s_1',
        '    (s_y, s_2) = a_c s_b s_3',
        '    s_3 = d_1 s_2',
      ],
      [actor('a_a', 1, 1), actor('a_b', 1, 1), actor('a_c', 2, 2), DELAY('d_1')],
    );
    for (const scene of expectClean(m)) {
      expect(node(scene, 'a_c').layer).toBe(node(scene, 'a_a').layer);
      expect(node(scene, 'd_1').layer).toBe(node(scene, 'a_b').layer);
    }
  });

  // One io node would have to be in the first layer and in the last. The
  // validator cannot be satisfied while other nodes sit in between; the pill
  // stays with the inputs and that is the only complaint.
  it('draws an input wired straight to an output', () => {
    const m = model(
      [
        'system :: Signal Int -> Signal Int -> (Signal Int, Signal Int)',
        'system s_in s_p = (s_out, s_p)',
        '  where',
        '    s_out = a_a s_in',
      ],
      [actor('a_a', 1, 1)],
    );
    expectClean(m, ['node s_p: system output in layer 0, not 2']);
  });

  it('draws a signal that is consumed and also a system output', () => {
    const m = model(
      [
        'system :: Signal Int -> (Signal Int, Signal Int)',
        'system s_in = (s_1, s_out)',
        '  where',
        '    s_1 = a_a s_in',
        '    s_out = a_b s_1',
      ],
      [actor('a_a', 1, 1), actor('a_b', 1, 1)],
    );
    for (const scene of expectClean(m)) {
      const from = scene.edges.filter((e) => e.signal === 's_1').map((e) => e.points[0]);
      expect(from).toHaveLength(2);
      expect(from[0]).toEqual(from[1]);
    }
  });

  describe('with a previous scene', () => {
    const src = readFileSync(new URL('../fixtures/SDF_example_026.hs', import.meta.url), 'utf8');

    it('keeps every node where it was after a rate change', () => {
      const before = run(compile(src), DEFAULT_FLAGS);
      // s_1 and s_3 carry 3 tokens instead of 2 at both ends: the schedule
      // stays balanced and every label keeps its width
      const edited = compile(
        src
          .replace('actor22SDF (2, 1) (2, 1)', 'actor22SDF (2, 1) (3, 1)')
          .replace('actor11SDF 2 2', 'actor11SDF 3 3')
          .replace('actor22SDF (2, 1) (1, 1)', 'actor22SDF (3, 1) (1, 1)'),
      );
      const after = run(edited, DEFAULT_FLAGS, before);
      expect(after.labels.some((l) => l.kind === 'rate' && l.text === '3')).toBe(true);
      const boxes = (s: Scene) => s.nodes.map((n) => [n.id, n.layer, n.order, n.box]);
      expect(boxes(after)).toEqual(boxes(before));
    });

    it('keeps the relative order of the other nodes when an actor is added', () => {
      const before = run(compile(src), DEFAULT_FLAGS);
      const edited = compile(
        src
          .replace('s_4 = a_3 s_2', 's_4x = a_3 s_2\n    s_4 = a_5 s_4x')
          .replace('d_1 ::', `${actor('a_5', 1, 1).replace(' f ', ' f_3 ')}\n\nd_1 ::`),
      );
      const after = run(edited, DEFAULT_FLAGS, before);
      expect(node(after, 'a_5')).toBeDefined();
      let compared = 0;
      for (const a of before.nodes)
        for (const b of before.nodes) {
          const a2 = node(after, a.id);
          const b2 = node(after, b.id);
          if (a.id >= b.id || a.layer !== b.layer || a2.layer !== b2.layer) continue;
          compared++;
          expect(Math.sign(a2.order - b2.order), `${a.id} vs ${b.id}`).toBe(
            Math.sign(a.order - b.order),
          );
        }
      expect(compared).toBeGreaterThan(0);
    });

    it('keeps the order when only the flags change', () => {
      const order = (s: Scene) => s.nodes.map((n) => `${n.id}@${n.layer}.${n.order}`).sort();
      for (const fx of loadFixtures()) {
        const first = run(fx, ALL_FLAGS[0]!);
        expect(order(run(fx, ALL_ON, first)), fx.name).toEqual(order(first));
      }
    });
  });

  // Larger than any fixture: 28 two-in, two-out actors in 7 layers wired at
  // random. Aligned ports make edges trade places exactly, which drew two
  // edges on one line until route.ts learned doglegs.
  it('keeps random layered models free of overlaps', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const m = compile(randomModel(7, 4, seed));
      for (const flags of [DEFAULT_FLAGS, ALL_ON, ALL_FLAGS[0]!]) {
        const scene = run(m, flags);
        expect(errorsOf(m, scene, flags), `seed ${seed}`).toEqual([]);
        expect(scoreScene(scene).overlaps, `seed ${seed}`).toBe(0);
      }
    }
  });

  it('charges every ordering phase against the work budget', () => {
    // 8 layers of 20 dummies and 100 random pieces per gap: one crossing count
    // compares about 35k pairs, so the barycenter sweeps alone use up the budget
    let state = 7;
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const items: Item[] = [];
    const layers = Array.from({ length: 8 }, (_, layer) =>
      Array.from({ length: 20 }, () => {
        items.push({
          light: true,
          io: false,
          layer,
          order: 0,
          rank: rand(1000),
          top: 0,
          bottom: 0,
          y: 0,
        });
        return items.length - 1;
      }),
    );
    const end = (layer: number) => ({ item: layers[layer]![rand(20)]!, dy: 0, frac: 0.5 });
    const byGap = new Map<number, Piece[]>();
    for (let gap = 0; gap < 7; gap++)
      byGap.set(
        gap,
        Array.from({ length: 100 }, (_, i) => ({
          edge: gap * 100 + i,
          gap,
          a: end(gap),
          b: end(gap + 1),
          sa: 'L' as const,
          sb: 'R' as const,
        })),
      );
    const count = [...byGap.values()].reduce((t, ps) => t + (ps.length * (ps.length - 1)) / 2, 0);
    const spent = orderLayers(items, layers, byGap);
    expect(spent).toBeGreaterThan(WORK_BUDGET);
    expect(spent).toBeLessThanOrEqual(WORK_BUDGET + 2 * count);
  });

  it('gives hidden labels no space', () => {
    const keys = Object.keys(ALL_ON) as (keyof LabelFlags)[];
    for (const fx of loadFixtures()) {
      const full = run(fx, ALL_ON);
      expect(area(run(fx, ALL_FLAGS[0]!)), fx.name).toBeLessThan(area(full));
      // hiding any one kind never makes the drawing larger
      for (const k of keys)
        expect(
          area(run(fx, { ...ALL_ON, [k]: false })),
          `${fx.name} without ${k}`,
        ).toBeLessThanOrEqual(area(full) + 1e-6);
    }
  });
});
