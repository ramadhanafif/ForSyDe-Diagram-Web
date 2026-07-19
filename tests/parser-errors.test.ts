import { describe, expect, it } from 'vitest';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers } from '../src/core/schedule';

const MODEL = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_out = a_b s_1
a_a = actor11SDF 1 1 f
a_b = actor11SDF 1 1 f
f :: [Int] -> [Int]
f [x] = [x]
`;

function errorsOf(source: string): string[] {
  const { module: mod, diagnostics } = parse(source);
  const { diagnostics: elabDiags } = elaborate(mod);
  return [...diagnostics, ...elabDiags].filter((d) => d.severity === 'error').map((d) => d.code);
}

describe('parser and elaborator diagnostics', () => {
  it('parses a valid model without errors', () => {
    expect(errorsOf(MODEL)).toEqual([]);
  });

  it('handles CRLF line endings with correct spans', () => {
    const crlf = MODEL.replace(/\n/g, '\r\n');
    const { module: mod, diagnostics } = parse(crlf);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const { ir } = elaborate(mod);
    expect(ir).not.toBeNull();
    const span = ir!.spans.processes.get('a_a')!.specBinding;
    expect(crlf.slice(span.from, span.to)).toContain('a_a = actor11SDF');
  });

  it('rejects inline constructors in the system block', () => {
    const src = MODEL.replace('s_1 = a_a s_in', 's_1 = delaySDF [0] s_in');
    expect(errorsOf(src)).toContain('inline-constructor');
  });

  it('rejects implicit signal splits', () => {
    const src = MODEL.replace('s_out = a_b s_1', 's_out = a_b s_in');
    expect(errorsOf(src)).toContain('implicit-split');
  });

  it('rejects non-positive rates', () => {
    const src = MODEL.replace('a_a = actor11SDF 1 1 f', 'a_a = actor11SDF 0 1 f');
    expect(errorsOf(src)).toContain('bad-rate');
  });

  it('rejects unknown processes and signals', () => {
    expect(errorsOf(MODEL.replace('a_b s_1', 'nope s_1'))).toContain('unknown-process');
    expect(errorsOf(MODEL.replace('a_b s_1', 'a_b s_ghost'))).toContain('unknown-signal');
  });

  it('reports a missing system netlist', () => {
    expect(errorsOf('module M where\nx = 1\n')).toContain('no-system');
  });

  it('caps explosive repetition vectors instead of freezing', () => {
    const src = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = a_b s_1
    s_out = a_c s_2
a_a = actor11SDF 1 999 f
a_b = actor11SDF 1000 999 f
a_c = actor11SDF 1000 1 f
`;
    const { module: mod } = parse(src);
    const { ir } = elaborate(mod);
    expect(ir).not.toBeNull();
    const r = computeScheduleAndBuffers(ir!);
    expect(!r.ok && r.kind).toBe('invalid-graph');
    expect(!r.ok && r.message).toMatch(/too large/);
  });
});
