import type { End, Item, Piece } from './order';

/** Gap between the extents of two neighbours in a column. */
const NODE_SEP = 16;
/** Dummies and io pills carry no name above them; they pack closer. */
const LIGHT_SEP = 12;
/**
 * Stacked io pills sit this close, so a node side facing only pills can space
 * its ports at the pills' pitch and every pill edge runs straight.
 */
export const IO_SEP = 2;
/** A hook only pulls its dummy toward the node; a crossing piece wants to be straight. */
const HOOK_WEIGHT = 0.25;
const ROUNDS = 4;
const EPS = 1e-6;

interface Target {
  v: number;
  w: number;
}

function weightedMedian(pts: Target[]): number {
  const s = [...pts].sort((a, b) => a.v - b.v);
  const total = s.reduce((t, p) => t + p.w, 0);
  let acc = 0;
  for (const p of s) {
    acc += p.w;
    if (acc >= total / 2 - 1e-9) return p.v;
  }
  return s[s.length - 1]!.v;
}

/**
 * Positions for one ordered column minimising the weighted L1 distance to each
 * item's targets under minimum separations: pool-adjacent-violators on the
 * separation-shifted targets, one weighted median per block. L1 (not L2) lands
 * items exactly on a target, which is what makes an edge straight.
 */
function pav(cur: number[], seps: number[], targets: Target[][]): number[] {
  const shift: number[] = [];
  let s = 0;
  seps.forEach((d, i) => shift.push((s += i ? d : 0)));
  const blocks: { n: number; pts: Target[]; v: number }[] = [];
  targets.forEach((ts, i) => {
    const pts = ts.length
      ? ts.map((t) => ({ v: t.v - shift[i]!, w: t.w }))
      : [{ v: cur[i]! - shift[i]!, w: 1e-3 }];
    let b = { n: 1, pts, v: weightedMedian(pts) };
    while (blocks.length && blocks[blocks.length - 1]!.v > b.v) {
      const p = blocks.pop()!;
      const merged = [...p.pts, ...b.pts];
      b = { n: p.n + b.n, pts: merged, v: weightedMedian(merged) };
    }
    blocks.push(b);
  });
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.v + shift[out.length]!);
  return out;
}

/** Vertical positions: stacked columns, sweeps toward straight pieces, then local repairs. */
export function placeY(items: Item[], layers: number[][], pieces: Piece[]): void {
  const seps = layers.map((layer) =>
    layer.map((it, i) => {
      if (!i) return 0;
      const a = items[layer[i - 1]!]!;
      const b = items[it]!;
      const gap = a.io && b.io ? IO_SEP : a.light || b.light ? LIGHT_SEP : NODE_SEP;
      return a.bottom + gap - b.top;
    }),
  );
  layers.forEach((l, L) => {
    let y = 0;
    l.forEach((it, i) => (items[it]!.y = y += seps[L]![i]!));
  });

  const touching = new Map<number, Piece[]>();
  for (const p of pieces)
    for (const e of [p.a, p.b]) {
      const list = touching.get(e.item) ?? [];
      list.push(p);
      touching.set(e.item, list);
    }

  const sweep = (L: number, use: 'L' | 'R' | 'both') => {
    const layer = layers[L]!;
    const targets = layer.map((it) => {
      const ts: Target[] = [];
      for (const p of touching.get(it) ?? []) {
        const [mine, other] = p.a.item === it ? [p.a, p.b] : [p.b, p.a];
        const hook = p.sa === p.sb;
        if (!hook) {
          const otherLayer = items[other.item]!.layer;
          if (use === 'L' && otherLayer > L) continue;
          if (use === 'R' && otherLayer < L) continue;
        }
        ts.push({ v: items[other.item]!.y + other.dy - mine.dy, w: hook ? HOOK_WEIGHT : 1 });
      }
      return ts;
    });
    const ys = pav(
      layer.map((it) => items[it]!.y),
      seps[L]!,
      targets,
    );
    layer.forEach((it, i) => (items[it]!.y = ys[i]!));
  };

  for (let r = 0; r < ROUNDS; r++) {
    for (let L = 1; L < layers.length; L++) sweep(L, 'L');
    for (let L = layers.length - 2; L >= 0; L--) sweep(L, 'R');
  }
  for (let L = 0; L < layers.length; L++) sweep(L, 'both');
  const groups = groupsOf(items, layers, pieces, seps);
  straighten(groups);
  liftLoops(groups);
}

/**
 * Items held together by straight pieces, and how far a group may shift
 * before one of its members runs into a neighbour outside the group.
 */
function groupsOf(items: Item[], layers: number[][], pieces: Piece[], seps: number[][]) {
  const links = pieces.filter((p) => p.sa !== p.sb);
  const pos = new Map<number, { L: number; i: number }>();
  layers.forEach((l, L) => l.forEach((it, i) => pos.set(it, { L, i })));
  const at = (e: End) => items[e.item]!.y + e.dy;
  const straight = (p: Piece) => Math.abs(at(p.a) - at(p.b)) < EPS;
  const parent: number[] = [];
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));

  /** Members per group, keyed by root; recomputed from the current ys. */
  const build = () => {
    parent.length = 0;
    items.forEach((_, i) => parent.push(i));
    for (const p of links) if (straight(p)) parent[find(p.a.item)] = find(p.b.item);
    const members = new Map<number, number[]>();
    items.forEach((_, i) => {
      const r = find(i);
      const list = members.get(r);
      if (list) list.push(i);
      else members.set(r, [i]);
    });
    return members;
  };

  /** Room to move a group up (negative) and down (positive). */
  const room = (members: number[]): [number, number] => {
    const inGroup = new Set(members);
    let up = -Infinity;
    let down = Infinity;
    for (const m of members) {
      const { L, i } = pos.get(m)!;
      const y = items[m]!.y;
      const above = layers[L]![i - 1];
      const below = layers[L]![i + 1];
      if (above !== undefined && !inGroup.has(above))
        up = Math.max(up, items[above]!.y + seps[L]![i]! - y);
      if (below !== undefined && !inGroup.has(below))
        down = Math.min(down, items[below]!.y - seps[L]![i + 1]! - y);
    }
    return [up, down];
  };

  return { items, pieces, links, at, straight, find, build, room };
}

type Groups = ReturnType<typeof groupsOf>;

/**
 * L1 is flat between two targets, so the sweeps may park an item between its
 * neighbours with both pieces bent. Fix that greedily: shift a group rigidly
 * so that more of its outside pieces become straight, when every member stays
 * clear of its neighbours. A group's outside pieces are all bent (a straight
 * one would have joined it), so each move adds straight pieces and the loop
 * ends.
 */
function straighten(g: Groups): void {
  for (let guard = 0; guard < 4 * g.links.length; guard++) {
    const groups = g.build();
    let best: { members: number[]; delta: number; gain: number } | null = null;
    for (const p of g.links) {
      if (g.straight(p)) continue;
      for (const [mine, other] of [
        [p.a, p.b],
        [p.b, p.a],
      ] as const) {
        const members = groups.get(g.find(mine.item))!;
        // both ends in one group (two pieces between the same two items):
        // no rigid shift straightens it
        if (g.find(other.item) === g.find(mine.item)) continue;
        const delta = g.at(other) - g.at(mine);
        const [up, down] = g.room(members);
        if (delta < up - EPS || delta > down + EPS) continue;
        const inGroup = new Set(members);
        let gain = 0;
        for (const q of g.links) {
          const ia = inGroup.has(q.a.item);
          if (ia === inGroup.has(q.b.item)) continue;
          const d = ia ? g.at(q.a) + delta - g.at(q.b) : g.at(q.a) - g.at(q.b) - delta;
          if (Math.abs(d) < EPS) gain++;
        }
        if (
          !best ||
          gain > best.gain ||
          (gain === best.gain && Math.abs(delta) < Math.abs(best.delta) - EPS)
        )
          best = { members, delta, gain };
      }
    }
    if (!best) return;
    for (const m of best.members) g.items[m]!.y += best.delta;
  }
}

/**
 * A feedback edge's dummy chain is one straight group held only by its two
 * hooks. The sweeps move one dummy at a time and a lone dummy cannot leave the
 * chain's line without bending it, so the chain stays wherever the initial
 * stacking put it, often far below the columns it passes. Shift each such
 * chain toward its hooks until a member meets a neighbour.
 */
function liftLoops(g: Groups): void {
  const hooks = g.pieces.filter((p) => p.sa === p.sb);
  for (const members of g.build().values()) {
    if (members.some((m) => g.items[m]!.node)) continue;
    const inGroup = new Set(members);
    // a bent piece to the outside would bend differently after the shift
    if (g.links.some((q) => inGroup.has(q.a.item) !== inGroup.has(q.b.item))) continue;
    let pull = 0;
    for (const h of hooks) {
      const [mine, other] = inGroup.has(h.a.item) ? [h.a, h.b] : [h.b, h.a];
      if (inGroup.has(mine.item)) pull += Math.sign(g.at(other) - g.at(mine));
    }
    if (!pull) continue;
    const [up, down] = g.room(members);
    const delta = pull < 0 ? up : down;
    if (Number.isFinite(delta)) for (const m of members) g.items[m]!.y += delta;
  }
}
