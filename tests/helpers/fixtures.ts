import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elaborate } from '../../src/core/elaborate';
import type { IRSystem } from '../../src/core/ir';
import { parse } from '../../src/core/parser';
import { computeScheduleAndBuffers, type ScheduleResult } from '../../src/core/schedule';
import type { LabelFlags } from '../../src/scene/types';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));

export interface Fixture {
  name: string;
  ir: IRSystem;
  schedule: ScheduleResult;
}

/** Every bundled example, parsed, elaborated and scheduled; throws on a broken one. */
export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.hs'))
    .sort()
    .map((f) => {
      const name = f.replace(/\.hs$/, '');
      const { ir } = elaborate(parse(readFileSync(join(FIXTURES, f), 'utf8')).module);
      if (!ir) throw new Error(`${name} does not elaborate`);
      return { name, ir, schedule: computeScheduleAndBuffers(ir) };
    });
}

const FLAG_KEYS: (keyof LabelFlags)[] = [
  'signals',
  'rates',
  'unitRates',
  'buffers',
  'repetitions',
  'constructors',
  'functions',
];

/** All 128 combinations; bit i of the index is FLAG_KEYS[i]. */
export const ALL_FLAGS: LabelFlags[] = Array.from(
  { length: 1 << FLAG_KEYS.length },
  (_, bits) =>
    Object.fromEntries(FLAG_KEYS.map((k, i) => [k, !!(bits & (1 << i))])) as unknown as LabelFlags,
);

/** What the app shows on first load. */
export const DEFAULT_FLAGS: LabelFlags = {
  signals: true,
  rates: true,
  unitRates: false,
  buffers: true,
  repetitions: true,
  constructors: true,
  functions: true,
};

export const ALL_ON: LabelFlags = { ...DEFAULT_FLAGS, unitRates: true };
