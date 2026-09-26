import { describe, expect, it } from 'vitest';
import type { Span } from '../src/core/ast';
import type { IRProcess, IRSignal, IRSystem, SpanIndex } from '../src/core/ir';
import { computeScheduleAndBuffers } from '../src/core/schedule';
import { simMarks } from '../src/app/useSimulation';
import type { SceneModel } from '../src/app/useScene';
import { edgeId } from '../src/scene/labels';
import { simulate, simulateUntilStuck, type SimStep } from '../src/sim/simulate';
import { loadFixtures } from './helpers/fixtures';

const span: Span = { from: 0, to: 0 };
const emptySpans: SpanIndex = {
  processes: new Map(),
  signals: new Map(),
  anchors: {
    whereEnd: 0,
    whereIndent: '',
    procSpecsEnd: 0,
    systemParams: span,
    systemOutputs: span,
  },
};
const actor = (name: string): IRProcess => ({
  type: 'Actor22',
  name,
  function: 'f',
  inRates: [],
  outRates: [],
});
const delay = (name: string, tokens: number[]): IRProcess => ({ type: 'Delay', name, tokens });
const sig = (name: string, src: string, prod: number, dst: string, cons: number): IRSignal => ({
  name,
  source: { name: src, rate: prod },
  target: { name: dst, rate: cons },
  targetSpan: span,
});
const system = (processes: IRProcess[], signals: IRSignal[]): IRSystem => ({
  inputs: ['x'],
  outputs: ['y'],
  processes,
  signals,
  spans: emptySpans,
});

const noNegatives = (steps: SimStep[]) => {
  for (const st of steps)
    for (const n of Object.values(st.after)) expect(n).toBeGreaterThanOrEqual(0);
};

describe('simulate one period', () => {
  const fixtures = loadFixtures();

  it('simulates all 35 fixtures (the scheduler accepts every one)', () => {
    expect(fixtures.filter((f) => f.schedule.ok)).toHaveLength(35);
  });

  for (const { name, ir, schedule } of fixtures) {
    if (!schedule.ok) continue;
    it(`${name}: periodic, non-negative, buffers match the scheduler`, () => {
      const trace = simulate(ir, schedule);
      const firings = trace.steps.filter((s) => s.kind === 'actor');
      expect(firings.map((s) => s.actor)).toEqual(schedule.schedule);
      // inputs produce before any firing, outputs take after the last one
      const kinds = trace.steps.map((s) => s.kind).join(' ');
      expect(kinds).toMatch(/^(input )*(actor ?)*( ?output)*$/);
      noNegatives(trace.steps);
      expect(trace.steps.at(-1)?.after ?? trace.initial).toEqual(trace.initial);

      // Group our queues under the scheduler's buffer names. A delay folds its
      // input and output signals into one buffer named after the input signal;
      // our tokens live on the output side (the input side is always 0).
      const group = (buf: string) =>
        Object.keys(trace.initial).filter((s) => (schedule.aliases.get(s) ?? s) === buf);
      const sum = (buf: string, pick: (s: SimStep) => { signal: string; n: number }[]) => {
        const members = group(buf);
        return trace.steps
          .flatMap(pick)
          .filter((c) => members.includes(c.signal))
          .reduce((a, c) => a + c.n, 0);
      };
      for (const [buf, size] of schedule.buffers) {
        const members = group(buf);
        const initial = Math.max(...members.map((s) => trace.initial[s]!));
        const src = ir.signals.find((s) => s.name === buf)!;
        if (ir.inputs.includes(src.source.name)) {
          // The scheduler sizes IO buffers as one period's worth of samples
          // (rate x repetitions), which is what the input step produces, or
          // the chained delay tokens if larger.
          const made = sum(buf, (s) => (s.kind === 'input' ? s.produced : []));
          expect(size).toBe(Math.max(made, initial));
          // without delays in front, that is exactly the peak the buffer reaches
          if (initial === 0)
            expect(Math.max(...members.map((s) => trace.maxOccupancy[s]!))).toBe(size);
        } else if (ir.outputs.includes(src.target.name)) {
          expect(size).toBe(
            Math.max(
              sum(buf, (s) => s.drained),
              initial,
            ),
          );
        } else {
          expect(size).toBe(Math.max(...members.map((s) => trace.maxOccupancy[s]!)));
        }
      }
    });
  }
});

describe('simulateUntilStuck', () => {
  it('reports the waiting actors and shortfalls in a cycle without a delay', () => {
    const ir = system(
      [actor('a'), actor('b')],
      [
        sig('s_x', 'x', 1, 'a', 1),
        sig('s_ab', 'a', 1, 'b', 1),
        sig('s_ba', 'b', 1, 'a', 2),
        sig('s_y', 'b', 1, 'y', 1),
      ],
    );
    expect(computeScheduleAndBuffers(ir).ok).toBe(false);
    const r = simulateUntilStuck(ir, 100);
    expect(r).toMatchObject({
      kind: 'deadlock',
      steps: [],
      waiting: [
        { actor: 'a', inputs: [{ signal: 's_ba', needed: 2, available: 0 }] },
        { actor: 'b', inputs: [{ signal: 's_ab', needed: 1, available: 0 }] },
      ],
    });
  });

  it('deadlocks after the initial tokens run out', () => {
    // two delay tokens, but the loop returns one for every two a consumes
    const ir = system(
      [actor('a'), actor('b'), delay('d', [0, 0])],
      [
        sig('s_x', 'x', 1, 'a', 1),
        sig('s_ab', 'a', 1, 'b', 1),
        sig('s_bd', 'b', 1, 'd', 1),
        sig('s_da', 'd', 1, 'a', 2),
        sig('s_y', 'b', 1, 'y', 1),
      ],
    );
    const r = simulateUntilStuck(ir, 100);
    expect(r.kind).toBe('deadlock');
    // x produces what a takes, then y takes what b produced, as steps of their own
    expect(r.steps.map((s) => `${s.kind}:${s.actor}`)).toEqual([
      'input:x',
      'actor:a',
      'actor:b',
      'output:y',
    ]);
    noNegatives(r.steps);
    expect(r.kind === 'deadlock' && r.waiting[0]).toEqual({
      actor: 'a',
      inputs: [{ signal: 's_da', needed: 2, available: 1 }],
    });
  });

  it('reports a deadlock behind a source that keeps firing', () => {
    // a fires on every input sample, but the b <-> c loop has no delay
    const ir = system(
      [actor('a'), actor('b'), actor('c')],
      [
        sig('s_x', 'x', 1, 'a', 1),
        sig('s_ab', 'a', 1, 'b', 1),
        sig('s_bc', 'b', 1, 'c', 1),
        sig('s_cb', 'c', 1, 'b', 1),
        sig('s_y', 'c', 1, 'y', 1),
      ],
    );
    const sched = computeScheduleAndBuffers(ir);
    expect(sched.ok || sched.kind).toBe('deadlock');
    expect(simulateUntilStuck(ir, 1000)).toMatchObject({
      kind: 'deadlock',
      waiting: [
        { actor: 'b', inputs: [{ signal: 's_cb', needed: 1, available: 0 }] },
        { actor: 'c', inputs: [{ signal: 's_bc', needed: 1, available: 0 }] },
      ],
    });
  });

  it('reports the growing signal for inconsistent rates', () => {
    // a -> b is 2:1 and b -> a is 1:1, so the feedback queue gains one token per round
    const ir = system(
      [actor('a'), actor('b'), delay('d', [0])],
      [
        sig('s_x', 'x', 1, 'a', 1),
        sig('s_ab', 'a', 2, 'b', 1),
        sig('s_bd', 'b', 1, 'd', 1),
        sig('s_da', 'd', 1, 'a', 1),
        sig('s_y', 'a', 1, 'y', 1),
      ],
    );
    const sched = computeScheduleAndBuffers(ir);
    expect(sched.ok || sched.kind).toBe('rank');
    const r = simulateUntilStuck(ir, 300);
    expect(r).toMatchObject({ kind: 'unbounded', signals: ['s_da'] });
    expect(r.steps).toHaveLength(300);
    noNegatives(r.steps);
  });

  it('keeps running for a consistent system', () => {
    const ir = system(
      [actor('a'), actor('b')],
      [sig('s_x', 'x', 1, 'a', 1), sig('s_ab', 'a', 2, 'b', 1), sig('s_y', 'b', 1, 'y', 1)],
    );
    expect(simulateUntilStuck(ir, 200).kind).toBe('running');
  });
});

describe('simMarks', () => {
  it('fills both strips of a delay-folded buffer from the one buffer', () => {
    // a -> d -> b: the scheduler aliases s_ad and s_db to one buffer, whose
    // initial token the simulation keeps on s_db
    const ir = system(
      [actor('a'), actor('b'), delay('d', [0])],
      [
        sig('s_x', 'x', 1, 'a', 1),
        sig('s_ad', 'a', 1, 'd', 1),
        sig('s_db', 'd', 1, 'b', 1),
        sig('s_y', 'b', 1, 'y', 1),
      ],
    );
    const schedule = computeScheduleAndBuffers(ir);
    if (!schedule.ok) throw new Error(schedule.message);
    expect(schedule.aliases.get('s_db')).toBe('s_ad');
    const trace = simulate(ir, schedule);
    const model = { ir, schedule } as SceneModel;
    const e = (name: string) => edgeId(ir.signals.find((s) => s.name === name)!);
    for (let pos = 0; pos <= trace.steps.length; pos++) {
      const { fill } = simMarks(model, { trace, stuck: null, pos });
      const held = pos === 0 ? trace.initial : trace.steps[pos - 1]!.after;
      expect(fill.get(e('s_ad'))).toBe(held['s_db']);
      expect(fill.get(e('s_db'))).toBe(held['s_db']);
    }
  });
});
