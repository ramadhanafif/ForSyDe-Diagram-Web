import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/app/explain';
import { analyze } from '../src/core/analysis';
import { applySplices } from '../src/core/edits';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers } from '../src/core/schedule';
import { simulateUntilStuck } from '../src/sim/simulate';

function explainSource(source: string) {
  const ir = elaborate(parse(source).module).ir!;
  const s = computeScheduleAndBuffers(ir);
  if (s.ok) throw new Error('schedulable');
  return explain(source, ir, s, analyze(ir), simulateUntilStuck(ir, 1000), 1);
}
const lesson = (name: string) =>
  readFileSync(new URL(`../examples/lessons/${name}.hs`, import.meta.url), 'utf8');
const schedules = (src: string) =>
  computeScheduleAndBuffers(elaborate(parse(src).module).ir!).ok;

describe('explain', () => {
  it('names both paths of an inconsistent fork and join, and no deadlock', () => {
    const src = lesson('06_inconsistent_rates');
    const e = explainSource(src);
    expect(e.message).toMatch(/^inconsistent rates: via .*q\(a_join\) = .*q\(a_split\)/);
    expect(e.message).not.toMatch(/deadlock|rank|matrix/i);
    expect(e.lines).toContain('a_twice writes 2 tokens to s_3 per firing, a_join reads 1');
    expect(src.slice(e.span.from, e.span.to)).toBe('a_join');
    expect(e.fix).toBeNull();
  });

  it('calls a loop through a delay a loop, not a self-loop', () => {
    const src = `system s_in = s_out
  where
    (s_out, s_1) = a_a s_in s_2
    s_2 = d_d s_1
a_a = actor22SDF (1, 1) (1, 2) g
d_d = delaySDF [0]
`;
    const e = explainSource(src);
    expect(e.message).toBe(
      'inconsistent rates: around the loop s_1 (through d_d), q(a_a) = 2·q(a_a), which no number of firings satisfies. Change one of the rates on the loop.',
    );
    expect(src.slice(e.span.from, e.span.to)).toBe('a_a');
  });

  it('offers a delay with one token for a loop without one, and the fix schedules', () => {
    const src = lesson('05_deadlock');
    const e = explainSource(src);
    expect(e.message).toMatch(/^deadlock: a_acc and a_back wait .*no initial token is on the loop/);
    expect(e.fix?.label).toMatch(/^Insert a delay with 1 initial token on s_/);
    expect(schedules(applySplices(src, e.fix!.splices))).toBe(true);
  });

  it('offers more tokens in the delay that has too few', () => {
    const src = lesson('07_too_few_initial_tokens');
    const e = explainSource(src);
    expect(e.message).toMatch(/too few initial tokens/);
    expect(e.lines).toContain('a_pair needs 2 on s_1, has 1');
    expect(e.fix?.label).toBe('Give d_1 2 initial tokens');
    expect(schedules(applySplices(src, e.fix!.splices))).toBe(true);
  });
});
