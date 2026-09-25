import { describe, expect, it } from 'vitest';
import { placeNodes, renameKey, type PlacedBox } from '../src/diagram/placement';
import { LAYER_SPACING, NODE_SPACING } from '../src/diagram/toElk';

const box = (id: string, x = 0, y = 0, width = 60, height = 60): PlacedBox => ({
  id,
  x,
  y,
  width,
  height,
});
const sig = (source: string, target: string) => ({
  source: { name: source },
  target: { name: target },
});

describe('placeNodes', () => {
  it('keeps stored positions over hints and elk', () => {
    const out = placeNodes(
      [box('a', 5, 5)],
      new Map([['a', { x: 100, y: 200 }]]),
      new Map([['a', { x: 0, y: 0 }]]),
      [],
    );
    expect(out.get('a')).toEqual({ x: 100, y: 200 });
  });

  it('converts a center hint to a top-left corner', () => {
    const out = placeNodes(
      [box('a', 0, 0, 40, 20)],
      new Map(),
      new Map([['a', { x: 100, y: 100 }]]),
      [],
    );
    expect(out.get('a')).toEqual({ x: 80, y: 90 });
  });

  it('steps a hinted node down past the stored nodes it would cover', () => {
    // edge-insert hint at the midpoint between two pinned neighbours
    const out = placeNodes(
      [box('m', 0, 0, 90, 90), box('a'), box('b')],
      new Map([
        ['a', { x: 0, y: 0 }],
        ['b', { x: 124, y: 0 }],
      ]),
      new Map([['m', { x: 92, y: 30 }]]),
      [],
    );
    expect(out.get('m')).toEqual({ x: 47, y: 60 + NODE_SPACING });
  });

  it('places a new node right of its producer, centers aligned', () => {
    const out = placeNodes(
      [box('a', 0, 0, 60, 60), box('b', 999, 999, 40, 20)],
      new Map([['a', { x: 10, y: 10 }]]),
      new Map(),
      [sig('a', 'b')],
    );
    expect(out.get('b')).toEqual({ x: 10 + 60 + LAYER_SPACING, y: 10 + 30 - 10 });
  });

  it('steps down when the spot right of the producer is taken', () => {
    const out = placeNodes(
      [box('a'), box('c'), box('b')],
      new Map([
        ['a', { x: 0, y: 0 }],
        ['c', { x: 60 + LAYER_SPACING, y: 0 }],
      ]),
      new Map(),
      [sig('a', 'b')],
    );
    expect(out.get('b')).toEqual({ x: 60 + LAYER_SPACING, y: 60 + NODE_SPACING });
  });

  it('places producers first even when elk lists the consumer first', () => {
    const out = placeNodes(
      [box('c'), box('b'), box('a')],
      new Map([['a', { x: 0, y: 0 }]]),
      new Map(),
      [sig('b', 'c'), sig('a', 'b')],
    );
    expect(out.get('b')).toEqual({ x: 60 + LAYER_SPACING, y: 0 });
    expect(out.get('c')).toEqual({ x: 2 * (60 + LAYER_SPACING), y: 0 });
  });

  it('puts an unconnected node below the lowest one at the leftmost x', () => {
    const out = placeNodes(
      [box('a'), box('b'), box('z')],
      new Map([
        ['a', { x: 30, y: 0 }],
        ['b', { x: 200, y: 100 }],
      ]),
      new Map(),
      [],
    );
    expect(out.get('z')).toEqual({ x: 30, y: 160 + NODE_SPACING });
  });

  it('resolves a cycle with nothing placed and returns every node', () => {
    const out = placeNodes([box('a', 7, 8), box('b')], new Map(), new Map(), [
      sig('a', 'b'),
      sig('b', 'a'),
    ]);
    expect(out.get('a')).toEqual({ x: 7, y: 8 });
    expect(out.get('b')).toEqual({ x: 7 + 60 + LAYER_SPACING, y: 8 });
    expect(out.size).toBe(2);
  });
});

describe('renameKey', () => {
  it('moves the position to the new id without mutating the input', () => {
    const before = new Map([['a', { x: 1, y: 2 }]]);
    const after = renameKey(before, 'a', 'b');
    expect(after.get('b')).toEqual({ x: 1, y: 2 });
    expect(after.has('a')).toBe(false);
    expect(before.has('a')).toBe(true);
  });

  it('returns an equal copy when the old id is absent', () => {
    const before = new Map([['a', { x: 1, y: 2 }]]);
    expect(renameKey(before, 'x', 'y')).toEqual(before);
  });
});
