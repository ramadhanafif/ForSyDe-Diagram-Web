import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { parseTimes, selfTimed } from '../src/sim/timed';

const facts = (src: string) => analyze(elaborate(parse(src).module).ir!)!;
const lesson = (name: string) =>
  readFileSync(new URL(`../examples/lessons/${name}.hs`, import.meta.url), 'utf8');

describe('self-timed execution', () => {
  it('reads -- @time lines', () => {
    expect(parseTimes('x\n-- @time a_up 2\n--@time a_down 0.5\n-- @time bad\n')).toEqual(
      new Map([
        ['a_up', 2],
        ['a_down', 0.5],
      ]),
    );
  });

  it('paces a chain by its slowest actor, and the first iteration by the sum', () => {
    const t = selfTimed(facts(lesson('01_single_rate_chain')), new Map([['a_inc', 2]]))!;
    expect(t.period).toBe(2);
    expect(t.latency).toBe(3);
  });

  it('counts every firing of a multirate iteration', () => {
    // a_up fires 3 times per iteration and cannot overlap itself
    const t = selfTimed(facts(lesson('02_multirate_chain')), new Map())!;
    expect(t.period).toBe(3);
  });

  it('is bounded by the tokens on a loop', () => {
    const t = selfTimed(facts(lesson('04_feedback_with_delay')), new Map([['a_acc', 2]]))!;
    expect(t.period).toBe(2);
  });

  it('has no timing without a schedule', () => {
    expect(selfTimed(facts(lesson('06_inconsistent_rates')), new Map())).toBeNull();
    expect(selfTimed(facts(lesson('05_deadlock')), new Map())).toBeNull();
  });
});
