import { describe, expect, it } from 'vitest';
import { applySplices } from '../src/core/edits';
import { elaborate } from '../src/core/elaborate';
import { editValue, inlineEdit, type EditTarget } from '../src/core/inlineEdit';
import { parse } from '../src/core/parser';

const SRC = `module M where
import ForSyDe.Shallow
system s_in s_y = s_out
  where
    s_1 = a_a s_in s_y
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor21SDF (1, 3) 2 f
d_d = delaySDF [0]
a_b = actor11SDF 2 1 g
`;
const ir = elaborate(parse(SRC).module).ir!;

const edit = (t: EditTarget, text: string) => {
  const r = inlineEdit(ir, SRC, t, text);
  return typeof r === 'string' ? r : applySplices(SRC, r);
};

describe('editValue', () => {
  it('starts from the current value of each field', () => {
    expect(editValue(ir, { kind: 'rate', node: 'a_a', dir: 'in', index: 1 })).toBe('3');
    expect(editValue(ir, { kind: 'tokens', node: 'd_d' })).toBe('0');
    expect(editValue(ir, { kind: 'name', node: 'a_b' })).toBe('a_b');
    expect(editValue(ir, { kind: 'signal', signal: 's_2' })).toBe('s_2');
    expect(editValue(ir, { kind: 'fn', node: 'a_b' })).toBe('g');
    expect(editValue(ir, { kind: 'rate', node: 'd_d', dir: 'in', index: 0 })).toBeNull();
  });
});

describe('inlineEdit', () => {
  it('changes one rate of a tuple and nothing else', () => {
    expect(edit({ kind: 'rate', node: 'a_a', dir: 'in', index: 1 }, ' 5 ')).toBe(
      SRC.replace('(1, 3)', '(1, 5)'),
    );
  });
  it('sets tokens, names and functions through the same splices as the popover', () => {
    expect(edit({ kind: 'tokens', node: 'd_d' }, '1, 2.5')).toBe(SRC.replace('[0]', '[1,2.5]'));
    expect(edit({ kind: 'name', node: 'a_b' }, 'sink')).toBe(SRC.replaceAll('a_b', 'sink'));
    expect(edit({ kind: 'signal', signal: 's_2' }, 'mid')).toBe(SRC.replaceAll('s_2', 'mid'));
    expect(edit({ kind: 'fn', node: 'a_b' }, 'h')).toBe(SRC.replace('2 1 g', '2 1 h'));
  });
  it('refuses bad input with a reason and no splices', () => {
    expect(edit({ kind: 'rate', node: 'a_a', dir: 'in', index: 0 }, '0')).toMatch(/1 or more/);
    expect(edit({ kind: 'rate', node: 'a_a', dir: 'in', index: 0 }, '1, 2')).toMatch(/whole/);
    expect(edit({ kind: 'tokens', node: 'd_d' }, 'x')).toMatch(/non-negative/);
    expect(edit({ kind: 'tokens', node: 'd_d' }, '-1')).toMatch(/non-negative/);
    expect(edit({ kind: 'name', node: 'a_b' }, 'a_a')).toMatch(/taken/);
    expect(edit({ kind: 'signal', signal: 's_2' }, 'Bad')).toMatch(/identifier/);
  });
});
