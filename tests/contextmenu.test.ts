import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/diagram/ContextMenu';
import { elaborate } from '../src/core/elaborate';
import type { IRSystem } from '../src/core/ir';
import { parse } from '../src/core/parser';

const MODEL = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor11SDF 1 2 f
d_d = delaySDF [0]
a_b = actor11SDF 2 1 g
f :: [Int] -> [Int]
f [x] = [x, x]
g :: [Int] -> [Int]
g [x, y] = [x + y]
`;

const UNDEF_FN = MODEL.replace('a_a = actor11SDF 1 2 f', 'a_a = actor11SDF 1 2 undefined');

function build(source: string): IRSystem {
  const { module: mod, diagnostics } = parse(source);
  const { ir, diagnostics: elabDiags } = elaborate(mod);
  const errors = [...diagnostics, ...elabDiags].filter((d) => d.severity === 'error');
  expect(errors).toEqual([]);
  expect(ir).not.toBeNull();
  return ir!;
}

describe('menuItems', () => {
  it('actor node offers rename, rates, function, goto and live delete', () => {
    const items = menuItems({ kind: 'node', name: 'a_a' }, build(MODEL));
    expect(items.map((i) => i.action)).toEqual([
      'rename',
      'rates',
      'function',
      'goto-definition',
      'delete',
    ]);
    expect(items.every((i) => !i.disabledReason)).toBe(true);
  });

  it('delay node offers rename, tokens and live delete', () => {
    const items = menuItems({ kind: 'node', name: 'd_d' }, build(MODEL));
    expect(items.map((i) => i.action)).toEqual(['rename', 'tokens', 'delete']);
  });

  it('edge offers insert actor/delay and rename', () => {
    const items = menuItems({ kind: 'edge', edgeId: 'e1', signalName: 's_1' }, build(MODEL));
    expect(items.map((i) => i.action)).toEqual(['insert-actor', 'insert-delay', 'rename-signal']);
  });

  it('canvas offers add actor and fit view', () => {
    const items = menuItems({ kind: 'canvas' }, build(MODEL));
    expect(items.map((i) => i.action)).toEqual(['add-actor', 'fit-view']);
  });

  it('refuses delete on a multi-port process', () => {
    const src = MODEL.replace('a_a = actor11SDF 1 2 f', 'a_a = actor12SDF 1 (2, 2) f').replace(
      's_1 = a_a s_in',
      '(s_1, s_x) = a_a s_in',
    );
    const src2 = src
      .replace('s_out = a_b s_2', 's_out = a_b s_2\n    s_y = d_e s_x')
      .replace('d_d = delaySDF [0]', 'd_d = delaySDF [0]\nd_e = delaySDF [0]');
    const items = menuItems({ kind: 'node', name: 'a_a' }, build(src2));
    const del = items.find((i) => i.action === 'delete')!;
    expect(del.disabledReason).toBeTruthy();
  });

  it('refuses goto on an undefined function', () => {
    const items = menuItems({ kind: 'node', name: 'a_a' }, build(UNDEF_FN));
    const goto = items.find((i) => i.action === 'goto-definition')!;
    expect(goto.disabledReason).toBe('function is undefined');
  });

  it('returns nothing for unknown targets or a missing model', () => {
    const ir = build(MODEL);
    expect(menuItems({ kind: 'node', name: 'ghost' }, ir)).toEqual([]);
    expect(menuItems({ kind: 'edge', edgeId: 'e9', signalName: 'ghost' }, ir)).toEqual([]);
    expect(menuItems({ kind: 'canvas' }, null)).toEqual([]);
  });
});
