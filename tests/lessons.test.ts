import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers } from '../src/core/schedule';

const DIR = fileURLToPath(new URL('../examples/lessons', import.meta.url));

/** What each lesson is meant to show: its repetition vector, or why it has none. */
const VERDICT: Record<string, Record<string, number> | 'deadlock' | 'rank'> = {
  '01_single_rate_chain': { a_double: 1, a_inc: 1 },
  '02_multirate_chain': { a_up: 3, a_down: 2 },
  '03_fork_and_join': { a_split: 1, a_top: 2, a_bottom: 1, a_join: 1 },
  '04_feedback_with_delay': { a_acc: 1 },
  '05_deadlock': 'deadlock',
  '06_inconsistent_rates': 'rank',
  '07_too_few_initial_tokens': 'deadlock',
};

describe('lesson examples', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.hs'));
  it('has a verdict for every lesson', () => {
    expect(files.map((f) => f.replace(/\.hs$/, '')).sort()).toEqual(Object.keys(VERDICT).sort());
  });
  for (const f of files) {
    const name = f.replace(/\.hs$/, '');
    it(`${name} shows what it says`, () => {
      const parsed = parse(readFileSync(join(DIR, f), 'utf8'));
      const { ir, diagnostics } = elaborate(parsed.module);
      expect([...parsed.diagnostics, ...diagnostics]).toEqual([]);
      const s = computeScheduleAndBuffers(ir!);
      const want = VERDICT[name]!;
      if (typeof want === 'string') expect(s.ok ? 'ok' : s.kind).toBe(want);
      else expect(s.ok && Object.fromEntries(s.repetitions)).toEqual(want);
    });
  }
});
