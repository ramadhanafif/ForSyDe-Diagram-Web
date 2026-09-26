import { describe, expect, it } from 'vitest';
import { elaborate } from '../src/core/elaborate';
import { linkedAt, sourceSpans } from '../src/core/links';
import { parse } from '../src/core/parser';
import { edgeId } from '../src/scene/labels';

const SRC = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor11SDF 1 2 f
d_d = delaySDF [0]
a_b = actor11SDF 2 1 f
f :: [Int] -> [Int]
f [x] = [x, x]
`;

const ir = elaborate(parse(SRC).module).ir!;
const at = (needle: string, skip = 0) => SRC.indexOf(needle) + skip;
const linked = (offset: number) => {
  const l = linkedAt(ir, SRC, offset, edgeId);
  return { nodes: [...l.nodes].sort(), edges: [...l.edges].sort() };
};
const text = (spans: { from: number; to: number }[]) => spans.map((s) => SRC.slice(s.from, s.to));

describe('linkedAt', () => {
  it('marks the edge of a signal name under the cursor', () => {
    expect(linked(at('s_1 = a_a'))).toEqual({ nodes: [], edges: ['e_s_1_a_a_d_d'] });
  });
  it('marks an io pill with its edge', () => {
    expect(linked(at('system s_in') + 7).nodes).toEqual(['s_in']);
  });
  it('marks the process of a binding or a spec', () => {
    expect(linked(at('= a_a s_in') + 2)).toEqual({ nodes: ['a_a'], edges: [] });
    expect(linked(at('d_d = delaySDF') + 8)).toEqual({ nodes: ['d_d'], edges: [] });
  });
  it('marks every actor applying a function from its definition', () => {
    expect(linked(at('f [x]') + 3).nodes).toEqual(['a_a', 'a_b']);
    expect(linked(at('f ::') + 6).nodes).toEqual(['a_a', 'a_b']);
  });
  it('marks nothing on unrelated text', () => {
    expect(linked(at('import'))).toEqual({ nodes: [], edges: [] });
  });
});

describe('sourceSpans', () => {
  it('finds the exact rate literal of a port', () => {
    expect(text(sourceSpans(ir, SRC, { kind: 'rate', node: 'a_a', dir: 'out', index: 0 }))).toEqual(
      ['2'],
    );
    const [span] = sourceSpans(ir, SRC, { kind: 'rate', node: 'a_b', dir: 'in', index: 0 });
    expect(span!.from).toBe(at('actor11SDF 2 1') + 'actor11SDF '.length);
  });
  it('finds a delay token list and a function with its definition', () => {
    expect(text(sourceSpans(ir, SRC, { kind: 'stack', node: 'd_d', line: 'tokens' }))).toEqual([
      '[0]',
    ]);
    expect(text(sourceSpans(ir, SRC, { kind: 'stack', node: 'a_a', line: 'fn' }))).toEqual([
      'f',
      'f :: [Int] -> [Int]',
      'f [x] = [x, x]',
    ]);
  });
  it('finds every occurrence of a signal and the spec and binding of a process', () => {
    expect(text(sourceSpans(ir, SRC, { kind: 'edge', signal: 's_1' }))).toEqual(['s_1', 's_1']);
    expect(text(sourceSpans(ir, SRC, { kind: 'node', id: 'a_a' }))).toEqual([
      'a_a = actor11SDF 1 2 f',
      's_1 = a_a s_in',
    ]);
  });
});
