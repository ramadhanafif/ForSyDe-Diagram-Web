import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis';
import { applySplices, deleteProcess, renameProcess, setTokens } from '../src/core/edits';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers } from '../src/core/schedule';
import { simulate } from '../src/sim/simulate';

/** Listing 6.1 of Sander's lecture notes (p. 178), verbatim with its inline delay. */
const LISTING_6_1 = `module SDF_System_Model where

import ForSyDe.Shallow

-- System Netlist
system s_in = s_out where
  s_1 = p_1 s_in s_6_delayed
  (s_2, s_3) = p_2 s_1
  s_6 = p_3 s_3 s_5
  (s_out, s_4) = p_4 s_2
  s_5 = p_5 s_4
  s_6_delayed = delaySDF [0,0] s_6

-- Process Specification
p_1 = actor21SDF (2,1) 1 f_1
  where f_1 [x1,x2] [y] = [x1+x2+y]
p_2 = actor12SDF 1 (1,1) f_2
  where f_2 [x] = ([x],[x+1])
p_3 = actor21SDF (2,2) 2 f_3
  where f_3 [x1,x2] [y1,y2]
          = [x1+x2,y1+y2]
p_4 = actor12SDF 1 (3,1) f_4
  where f_4 [x] = ([x,x+1,x+2],[x])
p_5 = actor11SDF 1 1 f_5
  where f_5 [x] = [x+1]
`;

function compile(src: string) {
  const parsed = parse(src);
  const { ir, diagnostics } = elaborate(parsed.module);
  expect([...parsed.diagnostics, ...diagnostics]).toEqual([]);
  return ir!;
}
const lesson = (name: string) =>
  readFileSync(new URL(`../examples/lessons/${name}.hs`, import.meta.url), 'utf8');

describe('the lecture notes', () => {
  it('schedules Listing 6.1 as the notes do: q, order and buffers (p. 179)', () => {
    const r = computeScheduleAndBuffers(compile(LISTING_6_1));
    if (!r.ok) throw new Error(r.message);
    expect(Object.fromEntries(r.repetitions)).toEqual({ p_1: 2, p_2: 2, p_3: 1, p_4: 2, p_5: 2 });
    expect(r.schedule.join(' ')).toBe('p_1 p_2 p_4 p_5 p_1 p_2 p_4 p_5 p_3');
    const internal = Object.fromEntries(r.buffers.filter(([n]) => !/^s_(in|out)$/.test(n)));
    expect(internal).toEqual({ s_1: 1, s_2: 1, s_3: 2, s_4: 1, s_5: 2, s_6: 2 });
  });

  it('gives lesson 2 the round-robin schedule, s_1 = 4 = p + c - gcd(p, c)', () => {
    const r = computeScheduleAndBuffers(compile(lesson('02_multirate_chain')));
    if (!r.ok) throw new Error(r.message);
    expect(r.schedule.join(' ')).toBe('a_up a_up a_down a_up a_down');
    expect(r.buffers).toContainEqual(['s_1', 4]);
  });
});

describe('an inline delay in the system block', () => {
  const ir = compile(LISTING_6_1);
  const name = 'delay_s_6_delayed';

  it('becomes a named delay process', () => {
    expect(ir.processes).toContainEqual({ type: 'Delay', name, tokens: [0, 0] });
    expect(analyze(ir)!.channels.find((c) => c.delay === name)?.tokens).toBe(2);
  });

  it('can change its tokens and be deleted, but not renamed', () => {
    const more = applySplices(LISTING_6_1, setTokens(ir, name, [0, 0, 0])!);
    expect(more).toContain('s_6_delayed = delaySDF [0,0,0] s_6');
    expect(renameProcess(LISTING_6_1, ir, name, 'd_6')).toBeNull();
    const gone = applySplices(LISTING_6_1, deleteProcess(ir, name)!);
    expect(gone).not.toContain('delaySDF');
    expect(gone).toContain('s_1 = p_1 s_in s_6\n');
  });
});

describe('models the devtools scheduler rejected', () => {
  it('schedules a delay right after a system input', () => {
    const r = computeScheduleAndBuffers(
      compile(`system s_in = s_out
  where
    s_1 = d s_in
    s_2 = a s_1
    s_out = b s_2
d = delaySDF [0]
a = actor11SDF 1 1 f
b = actor11SDF 1 1 f
`),
    );
    expect(r.ok && r.schedule).toEqual(['a', 'b']);
  });

  it('schedules two delays in a row as one edge with both tokens', () => {
    const ir = compile(`system s_in = s_out
  where
    (s_out, s_1) = a s_in s_3
    s_2 = d1 s_1
    s_3 = d2 s_2
a = actor22SDF (1, 1) (1, 1) f
d1 = delaySDF [0]
d2 = delaySDF [0]
`);
    const r = computeScheduleAndBuffers(ir);
    if (!r.ok) throw new Error(r.message);
    expect(r.repetitions.get('a')).toBe(1);
    expect(analyze(ir)!.channels).toMatchObject([{ signal: 's_1', src: 'a', dst: 'a', tokens: 2 }]);
    expect(simulate(ir, r).steps.length).toBeGreaterThan(0);
  });

  it('schedules and analyses a graph of two unconnected parts', () => {
    const ir = compile(`system s_in s_in2 = (s_out, s_out2)
  where
    s_1 = a_up s_in
    s_out = a_down s_1
    s_out2 = a_c s_in2
a_up = actor11SDF 1 2 f
a_down = actor11SDF 3 1 f
a_c = actor11SDF 1 1 f
`);
    const r = computeScheduleAndBuffers(ir);
    if (!r.ok) throw new Error(r.message);
    const a = analyze(ir, r.rank)!;
    expect(a.parts).toBe(2);
    expect(a.q).toEqual(new Map([['a_up', 3], ['a_down', 2], ['a_c', 1]]));
    expect(a.q).toEqual(r.repetitions);
    expect(analyze(ir)!.rank).toBe(r.rank);
    expect(r.schedule).toHaveLength(6);
  });
});
