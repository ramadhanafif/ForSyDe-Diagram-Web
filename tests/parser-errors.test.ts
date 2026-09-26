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

  it('rejects inline actor constructors in the system block', () => {
    const src = MODEL.replace('s_1 = a_a s_in', 's_1 = actor11SDF 1 1 f s_in');
    expect(errorsOf(src)).toContain('inline-constructor');
  });

  it('rejects a signal that feeds an actor and is also a system output', () => {
    const src = MODEL.replace('system s_in = s_out', 'system s_in = (s_1, s_out)');
    expect(errorsOf(src)).toEqual(['implicit-split']);
  });

  it('rejects integer literals above 2^53 on the literal', () => {
    const big = '99999999999999999999';
    for (const src of [
      MODEL.replace('a_a = actor11SDF 1 1 f', `a_a = actor11SDF ${big} 1 f`),
      MODEL.replace('a_a = actor11SDF 1 1 f', `a_a = actor21SDF (1, ${big}) 1 f`),
      MODEL.replace('a_b = actor11SDF 1 1 f', `a_b = delaySDF [${big}]`),
    ]) {
      const { diagnostics } = parse(src);
      expect(diagnostics.map((d) => d.code)).toEqual(['big-literal']);
      expect(src.slice(diagnostics[0]!.span.from, diagnostics[0]!.span.to)).toBe(big);
    }
    expect(
      errorsOf(MODEL.replace('actor11SDF 1 1 f\na_b', 'actor11SDF 9007199254740991 1 f\na_b')),
    ).toEqual([]);
  });

  it('rejects implicit signal splits', () => {
    const src = MODEL.replace('s_out = a_b s_1', 's_out = a_b s_in');
    expect(errorsOf(src)).toContain('implicit-split');
  });

  it('rejects non-positive rates', () => {
    const src = MODEL.replace('a_a = actor11SDF 1 1 f', 'a_a = actor11SDF 0 1 f');
    expect(errorsOf(src)).toContain('bad-rate');
  });

  it('rejects float rates', () => {
    const src = MODEL.replace('a_a = actor11SDF 1 1 f', 'a_a = actor11SDF 1.5 1 f');
    expect(errorsOf(src)).toContain('bad-rate');
  });

  it('accepts float delay tokens', () => {
    const src = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor11SDF 1 1 f
a_b = actor11SDF 1 1 f
d_d = delaySDF [0.5, -1.25]
`;
    expect(errorsOf(src)).toEqual([]);
    const { module: mod } = parse(src);
    const { ir } = elaborate(mod);
    expect(ir!.processes.find((p) => p.name === 'd_d')).toMatchObject({ tokens: [0.5, -1.25] });
    // scheduling counts initial tokens, never their values
    const r = computeScheduleAndBuffers(ir!);
    expect(r.ok).toBe(true);
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

describe('root-cause diagnostics', () => {
  function diagsOf(source: string): Diagnostic[] {
    const { module: mod, diagnostics } = parse(source);
    return orderDiagnostics([...diagnostics, ...elaborate(mod).diagnostics]);
  }
  const first = (source: string) => diagsOf(source)[0]?.message;
  const spec = (to: string) => MODEL.replace('a_a = actor11SDF 1 1 f', to);

  it('names a near-miss constructor instead of the unknown process', () => {
    const src = spec('a_a = actor11sdf 1 1 f');
    const d = diagsOf(src);
    expect(d.map((x) => x.message)).toEqual([
      "Unknown constructor 'actor11sdf': did you mean actor11SDF?",
    ]);
    expect(src.slice(d[0]!.span.from, d[0]!.span.to)).toBe('actor11sdf');
  });

  it('reports a zero rate alone', () => {
    expect(diagsOf(spec('a_a = actor11SDF 0 1 f')).map((d) => d.message)).toEqual([
      'Rates must be whole numbers of at least 1, got 0',
    ]);
  });

  it('asks for a rate tuple on a multi-input actor', () => {
    const src = spec('a_a = actor21SDF 2 1 1 f');
    const d = diagsOf(src);
    expect(d[0]!.message).toBe(
      'actor21SDF takes its 2 input rates as a tuple: actor21SDF (2, 1) 1 f',
    );
    expect(src.slice(d[0]!.span.from, d[0]!.span.to)).toBe('2');
    expect(first(spec('a_a = actor12SDF 1 1 2 f'))).toBe(
      'actor12SDF takes its 2 output rates as a tuple: actor12SDF 1 (1, 2) f',
    );
  });

  it('asks for a named function instead of a lambda', () => {
    expect(diagsOf(spec('a_a = actor11SDF 1 1 (\\x -> x)')).map((d) => d.message)).toEqual([
      'Name the function at top level and pass its name: f_1 [x] = [x]',
    ]);
  });

  it('reports a missing where on the system head', () => {
    const src = MODEL.replace('  where\n', '');
    expect(first(src)).toMatch(/^The system's bindings need a 'where' block/);
    expect(diagsOf(src).map((d) => d.code)).not.toContain('unknown-signal');
  });

  it('reports unindented bindings instead of unknown signals', () => {
    const src = MODEL.replace('    s_1 = a_a', 's_1 = a_a').replace(
      '    s_out = a_b',
      's_out = a_b',
    );
    const d = diagsOf(src);
    expect(d.map((x) => x.code)).toEqual(['unindented-binding', 'unindented-binding']);
    expect(d[0]!.message).toBe(
      "This binding is not indented, so it is outside the system's 'where' block",
    );
  });

  it('reports only no-where when the where is missing and the body is at column 0', () => {
    const src = MODEL.replace('  where\n', '')
      .replace('    s_1 = a_a', 's_1 = a_a')
      .replace('    s_out = a_b', 's_out = a_b');
    expect(diagsOf(src).map((d) => d.code)).toEqual(['no-where']);
  });

  it('reports an unsupported binding alone', () => {
    expect(
      diagsOf(MODEL.replace('s_out = a_b s_1', 's_out = a_b $ s_1')).map((d) => d.message),
    ).toEqual(['Only applications of a named process to signal names are supported here']);
  });

  it('leaves ordinary function definitions alone', () => {
    expect(errorsOf(`${MODEL}g x = f x\nactor = 1\n`)).toEqual([]);
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
