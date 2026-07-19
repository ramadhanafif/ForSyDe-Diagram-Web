import { describe, expect, it } from 'vitest';
import type { ActorType, Span } from '../src/core/ast';
import type { IRProcess, IRSignal, IRSystem, SpanIndex } from '../src/core/ir';
import { computeScheduleAndBuffers } from '../src/core/schedule';

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

function actor(name: string, type: ActorType): IRProcess {
  return { type, name, function: 'f', inRates: [], outRates: [] };
}
function delay(name: string, tokens: number[]): IRProcess {
  return { type: 'Delay', name, tokens };
}
function sig(name: string, src: string, prodRate: number, dst: string, consRate: number): IRSignal {
  return { name, source: { name: src, rate: prodRate }, target: { name: dst, rate: consRate } };
}
function system(
  inputs: string[],
  outputs: string[],
  processes: IRProcess[],
  signals: IRSignal[],
): IRSystem {
  return { inputs, outputs, processes, signals, functions: [], spans: emptySpans };
}

// Test systems ported verbatim from forsyde-devtools test/SDFScheduleSpec.hs

describe('SDF scheduling golden tests (SDFScheduleSpec.hs)', () => {
  it('exampleSystem1: single actor with self loop', () => {
    const ir = system(
      ['input'],
      ['output'],
      [actor('actor_1', 'Actor22'), delay('delay_1', [0])],
      [
        sig('s_in', 'input', 1, 'actor_1', 1),
        sig('s_1', 'actor_1', 1, 'delay_1', 1),
        sig('s_2', 'delay_1', 1, 'actor_1', 1),
        sig('s_out', 'actor_1', 1, 'output', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(r.ok && r.schedule).toEqual(['actor_1']);
    expect(r.ok && r.buffers).toEqual([
      ['s_in', 1],
      ['s_out', 1],
      ['s_1', 1],
    ]);
  });

  it('exampleSystem2: single actor and nothing else', () => {
    const ir = system(
      ['in'],
      ['out'],
      [actor('actor', 'Actor11')],
      [sig('s_in', 'in', 1, 'actor', 1), sig('s_out', 'actor', 1, 'out', 1)],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(r.ok && r.schedule).toEqual(['actor']);
    expect(r.ok && r.buffers).toEqual([
      ['s_in', 1],
      ['s_out', 1],
    ]);
  });

  it('exampleSystem3: two actors, one self loop', () => {
    const ir = system(
      ['input'],
      ['output'],
      [actor('actor_1', 'Actor22'), delay('delay_1', [0]), actor('actor_2', 'Actor11')],
      [
        sig('s_in', 'input', 1, 'actor_1', 1),
        sig('s_1', 'actor_1', 1, 'delay_1', 1),
        sig('s_2', 'delay_1', 1, 'actor_1', 1),
        sig('s_3', 'actor_1', 1, 'actor_2', 1),
        sig('s_out', 'actor_2', 1, 'output', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(r.ok && r.schedule).toEqual(['actor_1', 'actor_2']);
    expect(r.ok && r.buffers).toEqual([
      ['s_in', 1],
      ['s_out', 1],
      ['s_3', 1],
      ['s_1', 1],
    ]);
  });

  it('exampleSystem4: multiple inputs', () => {
    const ir = system(
      ['s_ina', 's_inb'],
      ['s_out'],
      [
        actor('actor_a', 'Actor11'),
        actor('actor_b', 'Actor11'),
        actor('actor_c', 'Actor21'),
        actor('actor_d', 'Actor22'),
        delay('delay', [0]),
      ],
      [
        sig('s_ina', 's_ina', 1, 'actor_a', 2),
        sig('s_inb', 's_inb', 1, 'actor_b', 1),
        sig('s_1', 'actor_a', 1, 'actor_c', 2),
        sig('s_2', 'actor_b', 2, 'actor_d', 2),
        sig('s_3', 'actor_c', 1, 'actor_d', 1),
        sig('s_4_delay', 'actor_d', 1, 'delay', 1),
        sig('s_4', 'delay', 1, 'actor_c', 1),
        sig('s_out', 'actor_d', 2, 's_out', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(r.ok && r.schedule).toEqual(['actor_a', 'actor_a', 'actor_b', 'actor_c', 'actor_d']);
    expect(r.ok && r.buffers).toEqual([
      ['s_ina', 4],
      ['s_inb', 1],
      ['s_out', 2],
      ['s_1', 2],
      ['s_2', 2],
      ['s_3', 1],
      ['s_4_delay', 1],
    ]);
  });

  it('exampleSystem5', () => {
    const ir = system(
      ['s_in'],
      ['s_out'],
      [
        actor('a', 'Actor21'),
        actor('b', 'Actor11'),
        actor('c', 'Actor12'),
        delay('delay', [0, 0, 0, 0, 0, 0]),
      ],
      [
        sig('s_in', 's_in', 1, 'a', 2),
        sig('s1', 'a', 1, 'b', 2),
        sig('s2', 'b', 3, 'c', 1),
        sig('s3_delay', 'c', 2, 'delay', 2),
        sig('s3', 'delay', 3, 'a', 3),
        sig('s_out', 'c', 1, 's_out', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(r.ok && r.schedule).toEqual(['a', 'a', 'b', 'c', 'c', 'c']);
    expect(r.ok && r.buffers).toEqual([
      ['s_in', 4],
      ['s_out', 3],
      ['s1', 2],
      ['s2', 3],
      ['s3_delay', 6],
    ]);
  });

  it('exampleSystem6', () => {
    const ir = system(
      ['s_in'],
      ['s_out'],
      [
        actor('a', 'Actor12'),
        actor('b', 'Actor11'),
        actor('c', 'Actor11'),
        actor('d', 'Actor12'),
        delay('delay', [0, 0]),
      ],
      [
        sig('s_in', 's_in', 1, 'a', 2),
        sig('s1', 'a', 1, 'b', 4),
        sig('s2_delay', 'b', 1, 'delay', 1),
        sig('s2', 'delay', 2, 'd', 2),
        sig('s3', 'd', 4, 'c', 1),
        sig('s4', 'c', 4, 'a', 2),
        sig('s_out', 'd', 1, 's_out', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(r.ok && r.schedule).toEqual([
      'd', 'c', 'a', 'a', 'c', 'a', 'a', 'b', 'c', 'a', 'a', 'c', 'a', 'a', 'b',
    ]);
    expect(r.ok && r.buffers).toEqual([
      ['s_in', 16],
      ['s_out', 1],
      ['s1', 4],
      ['s3', 4],
      ['s4', 4],
      ['s2_delay', 2],
    ]);
  });

  it('rejects inconsistent rates with rank error', () => {
    const ir = system(
      ['in'],
      ['out'],
      [actor('a', 'Actor11'), actor('b', 'Actor11')],
      [
        sig('s_in', 'in', 1, 'a', 1),
        sig('s1', 'a', 2, 'b', 3),
        sig('s2', 'b', 1, 'a', 1), // cycle with inconsistent rates
        sig('s_out', 'b', 1, 'out', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(!r.ok && r.kind).toBe('rank');
  });

  it('rejects invalid self-loop', () => {
    const ir = system(
      ['in'],
      ['out'],
      [actor('a', 'Actor22')],
      [
        sig('s_in', 'in', 1, 'a', 1),
        sig('s1', 'a', 2, 'a', 3),
        sig('s_out', 'a', 1, 'out', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(!r.ok && r.kind).toBe('invalid-self-loop');
  });

  it('detects deadlock when delay tokens are insufficient', () => {
    const ir = system(
      ['in'],
      ['out'],
      [actor('a', 'Actor21'), actor('b', 'Actor11'), delay('d', [])],
      [
        sig('s_in', 'in', 1, 'a', 1),
        sig('s1', 'a', 1, 'b', 1),
        sig('s2', 'b', 1, 'd', 1),
        sig('s3', 'd', 1, 'a', 1),
        sig('s_out', 'a', 1, 'out', 1),
      ],
    );
    const r = computeScheduleAndBuffers(ir);
    expect(!r.ok && r.kind).toBe('deadlock');
  });
});
