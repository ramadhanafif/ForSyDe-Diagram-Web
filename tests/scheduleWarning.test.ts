import { describe, expect, it } from 'vitest';
import { explain } from '../src/app/explain';
import { scheduleWarning } from '../src/app/scheduleWarning';
import { analyze } from '../src/core/analysis';
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
  it('turns a failed schedule into a warning on the actor at fault', () => {
    const ir = build(SELF_LOOP);
    const s = computeScheduleAndBuffers(ir);
    if (s.ok) throw new Error('schedulable');
    const d = scheduleWarning(explain(SELF_LOOP, ir, s, analyze(ir), null, 1));
    expect(d.severity).toBe('warning');
    expect(d.message).toMatch(/^Not schedulable: .*a_a/);
    expect(SELF_LOOP.slice(d.span.from, d.span.to)).toBe('a_a');
  });

  it('blames the inconsistent part of a disconnected graph, not the disconnection', () => {
    const src =
      SELF_LOOP.replace('system s_in = s_out', 'system s_in s_in2 = (s_out, s_out2)').replace(
        '    s_2 = d_d s_1',
        '    s_2 = d_d s_1\n    s_out2 = a_b s_in2',
      ) + 'a_b = actor11SDF 1 1 f\n';
    const ir = build(src);
    const s = computeScheduleAndBuffers(ir);
    if (s.ok) throw new Error('schedulable');
    const e = explain(src, ir, s, analyze(ir), null, 2);
    expect(e.message).toMatch(/^inconsistent rates: around the loop s_1/);
    expect(e.lines).toContain('the graph has 2 unconnected parts, each scheduled on its own');
    expect(scheduleWarning(e).message).not.toMatch(/disconnected/);
  });
});
