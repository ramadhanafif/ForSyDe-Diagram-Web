import { describe, expect, it } from 'vitest';
import { layoutFailed, orderDiagnostics, type Diagnostic } from '../src/core/ast';
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

  it('ignores a block comment spanning multiple lines', () => {
    const src = `{- This is a\n   multiline comment\n   spanning several lines -}\n${MODEL}`;
    expect(errorsOf(src)).toEqual([]);
  });

  it('ignores multiple block comments', () => {
    const src = `{- Comment 1 -}\n{- Comment 2 -}\n${MODEL}`;
    expect(errorsOf(src)).toEqual([]);
  });

  it('fails on a single-element tuple system output', () => {
    // `(out)` parses as a parenthesized name, so elaboration fails: `out` has no producer.
    const src = `actor1 = actor11SDF 1 1 f\nsystem = (out)\n`;
    expect(errorsOf(src)).toContain('unknown-signal');
  });

  it('documents nested where-block behavior', () => {
    // `where_inner` lexes as one identifier, so no `nested-where` here;
    // elaboration still fails because `y` has no producer.
    const src = `actor1 = actor11SDF 1 1 f\nsystem out = x where\n  where_inner = actor1 y\n`;
    expect(errorsOf(src)).toContain('unknown-signal');
    const nested = MODEL.replace('s_1 = a_a s_in', 's_1 = a_a s_in where');
    expect(errorsOf(nested)).toContain('nested-where');
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

describe('find-my-errors helpers', () => {
  const diag = (severity: 'error' | 'warning', from: number): Diagnostic => ({
    severity,
    code: 'x',
    message: 'm',
    span: { from, to: from + 1 },
  });

  it('orders errors first, then by offset', () => {
    const inOrder = [diag('warning', 1), diag('error', 9), diag('error', 2), diag('warning', 0)];
    expect(orderDiagnostics(inOrder).map((d) => [d.severity, d.span.from])).toEqual([
      ['error', 2],
      ['error', 9],
      ['warning', 0],
      ['warning', 1],
    ]);
  });

  it('does not mutate the input array', () => {
    const diags = [diag('warning', 1), diag('error', 9)];
    orderDiagnostics(diags);
    expect(diags.map((d) => d.span.from)).toEqual([1, 9]);
  });

  it('formats a layout-failed error diagnostic', () => {
    const d = layoutFailed(new Error('boom'));
    expect(d.severity).toBe('error');
    expect(d.code).toBe('layout-failed');
    expect(d.message).toMatch(/boom/);
  });
});
