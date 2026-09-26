import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, balanceEquation, loopedSchedule } from '../src/core/analysis';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { loadFixtures } from './helpers/fixtures';

const irOf = (src: string) => elaborate(parse(src).module).ir!;
const lesson = (name: string) =>
  irOf(readFileSync(new URL(`../examples/lessons/${name}.hs`, import.meta.url), 'utf8'));

describe('analyze', () => {
  it('agrees with the scheduler on every fixture', () => {
    for (const f of loadFixtures()) {
      const a = analyze(f.ir)!;
      expect(a.conflict, f.name).toBeNull();
      expect(a.rank, f.name).toBe(a.actors.length - 1);
      if (f.schedule.ok) expect(a.q, f.name).toEqual(f.schedule.repetitions);
    }
  });

  it('names the two paths of an inconsistent fork and join', () => {
    const a = analyze(lesson('06_inconsistent_rates'))!;
    expect(a.q).toBeNull();
    expect(a.rank).toBe(a.actors.length);
    const c = a.conflict!;
    expect([c.from, c.to]).toEqual(['a_split', 'a_join']);
    const paths = [c.pathA, c.pathB].map((p) => p.map((ch) => ch.signal).join(' '));
    expect(paths.sort()).toEqual(['s_1 s_3', 's_2 s_4']);
    const ratios = [c.ratioA, c.ratioB].map(([n, d]) => n / d).sort();
    expect(ratios).toEqual([1, 2]);
  });

  it('finds a loop through a delay whose rates do not return to one', () => {
    const a = analyze(
      irOf(`system s_in = s_out
  where
    (s_out, s_1) = a s_in s_2
    s_2 = d s_1
a = actor22SDF (1, 1) (1, 2) f
d = delaySDF [0]
`),
    )!;
    const c = a.conflict!;
    expect([c.from, c.to]).toEqual(['a', 'a']);
    expect(c.pathB.map((ch) => [ch.signal, ch.delay])).toEqual([['s_1', 'd']]);
    expect(c.ratioB).toEqual([2, 1]);
  });

  it('writes the schedule with repetition counts and balance equations with numbers', () => {
    expect(loopedSchedule(['s', 'a', 'a', 'a', 'b', 'b', 'a'])).toBe('s 3(a) 2(b) a');
    const a = analyze(lesson('02_multirate_chain'))!;
    expect(a.q).toEqual(new Map([['a_up', 3], ['a_down', 2]]));
    expect(balanceEquation(a.channels[0]!, a.q)).toBe('2·q(a_up) = 3·q(a_down): 2·3 = 3·2');
    expect(a.gamma).toEqual([[2, -3]]);
  });
});
