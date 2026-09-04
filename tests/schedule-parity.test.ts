import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/core/parser';
import { elaborate } from '../src/core/elaborate';
import { computeScheduleAndBuffers } from '../src/core/schedule';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

// Probe: *.ir.json holds only {system: {functions, inputs, outputs, processes,
// signals}} — no schedule/buffer/repetition data, so no golden equality to
// assert; instead require a successful schedule with sane output.
const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.hs'))
  .map((f) => f.replace(/\.hs$/, ''));

describe('schedule parity over fixtures', () => {
  expect(names.length).toBeGreaterThan(30);

  for (const name of names) {
    it(`${name} schedules with sane output`, () => {
      const source = readFileSync(join(FIXTURES, `${name}.hs`), 'utf8');

      const { module: mod, diagnostics: parseDiags } = parse(source);
      expect(parseDiags.filter((d) => d.severity === 'error')).toEqual([]);
      const { ir, diagnostics: elabDiags } = elaborate(mod);
      expect(elabDiags.filter((d) => d.severity === 'error')).toEqual([]);
      expect(ir).not.toBeNull();

      const r = computeScheduleAndBuffers(ir!);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.schedule.length).toBeGreaterThan(0);
      expect([...r.repetitions.values()].every((v) => v > 0)).toBe(true);
      expect(r.buffers.every(([, n]) => n >= 0)).toBe(true);
    });
  }
});
