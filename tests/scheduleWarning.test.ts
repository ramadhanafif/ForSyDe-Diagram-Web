import { describe, expect, it } from 'vitest';
import { scheduleWarning } from '../src/app/scheduleWarning';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers } from '../src/core/schedule';

const SELF_LOOP = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    (s_out, s_1) = a_a s_in s_2
    s_2 = d_d s_1
a_a = actor22SDF (1, 1) (1, 2) g
d_d = delaySDF [0]
`;

const build = (src: string) => elaborate(parse(src).module).ir!;

describe('scheduleWarning', () => {
  it('turns a failed schedule into a warning on the actor it names', () => {
    const ir = build(SELF_LOOP);
    const s = computeScheduleAndBuffers(ir);
    expect(s.ok).toBe(false);
    const d = scheduleWarning(ir, s.ok ? '' : s.message);
    expect(d.severity).toBe('warning');
    expect(d.message).toMatch(/^Not schedulable: .*a_a/);
    expect(SELF_LOOP.slice(d.span.from, d.span.to)).toBe('a_a');
  });

  it('falls back to the system parameters when no process is named', () => {
    const ir = build(SELF_LOOP);
    const d = scheduleWarning(ir, 'the graph has 2 disconnected parts');
    const text = SELF_LOOP.slice(d.span.from, d.span.to);
    expect(text).toContain('s_in');
  });
});
