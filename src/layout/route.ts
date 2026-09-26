import { COLLINEAR_TOL, segmentsCrossProperly } from '../scene/metrics';
import type { Item, Piece } from './order';

/** Tracks sharing a column keep this much vertical clearance. */
const TRACK_CLEAR = 6;
const EPS = 1e-6;
/** Horizontals closer than this draw as one line: the metrics' tolerance plus 1 px of margin. */
const NEAR = COLLINEAR_TOL + 1;
/** Cost of two horizontals drawn on top of each other, against 1 for a crossing. */
const COLLINEAR = 10;

/** One vertical run of a piece: on `track`, from y0 to y1 in drawing order. */
export interface Run {
  track: number;
  y0: number;
  y1: number;
}

export interface GapRoute {
  /** Per piece (index into the gap's piece list): its runs, none when straight. */
  runs: Run[][];
  tracks: number;
}

type GapSide = 'L' | 'R';

interface Seg {
  piece: number;
  ya: number;
  yb: number;
  sa: GapSide;
  sb: GapSide;
  lo: number;
  hi: number;
}

type P = { x: number; y: number };

const seg = (piece: number, ya: number, yb: number, sa: GapSide, sb: GapSide): Seg => ({
  piece,
  ya,
  yb,
  sa,
  sb,
  lo: Math.min(ya, yb),
  hi: Math.max(ya, yb),
});

/**
 * cost() draws two segs in a gap scaled to sides at 0 and GAP_W, one vertical
 * at LEFT and the other at RIGHT. Only the order of the x values matters.
 */
const GAP_W = 10;
const LEFT = 4;
const RIGHT = 6;

/** The seg drawn with its vertical at x. */
function poly(s: Seg, x: number): P[] {
  const side = (v: GapSide) => (v === 'L' ? 0 : GAP_W);
  return [
    { x: side(s.sa), y: s.ya },
    { x, y: s.ya },
    { x, y: s.yb },
    { x: side(s.sb), y: s.yb },
  ];
}

const overlap = (a1: number, a2: number, b1: number, b2: number) =>
  Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)) > EPS;

/**
 * Crossings plus heavily weighted overlaps between two segs, s's vertical
 * left of t's. The verticals never share an x, so only horizontals can overlap.
 */
function cost(s: Seg, t: Seg): number {
  const p = poly(s, LEFT);
  const q = poly(t, RIGHT);
  // two edges leaving one port share their first horizontal by design
  const sameStart = s.sa === t.sa && Math.abs(s.ya - t.ya) < EPS;
  let c = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const [a1, a2] = [p[i]!, p[i + 1]!];
      const [b1, b2] = [q[j]!, q[j + 1]!];
      if (segmentsCrossProperly(a1, a2, b1, b2)) c += 1;
      else if (
        Math.abs(a1.y - a2.y) < EPS &&
        Math.abs(b1.y - b2.y) < EPS &&
        Math.abs(a1.y - b1.y) < NEAR &&
        overlap(a1.x, a2.x, b1.x, b2.x) &&
        !(sameStart && !i && !j)
      )
        c += COLLINEAR;
    }
  return c;
}

const near = (a: Seg, b: Seg) => a.lo <= b.hi + TRACK_CLEAR && b.lo <= a.hi + TRACK_CLEAR;

/** The y in (lo, hi) furthest from every horizontal already in the gap. */
function freeY(lo: number, hi: number, taken: number[]): number {
  const ys = [lo, ...taken.filter((y) => lo < y && y < hi).sort((a, b) => a - b), hi];
  let best = (lo + hi) / 2;
  let room = -1;
  for (let i = 1; i < ys.length; i++)
    if (ys[i]! - ys[i - 1]! > room) {
      room = ys[i]! - ys[i - 1]!;
      best = (ys[i]! + ys[i - 1]!) / 2;
    }
  return best;
}

/**
 * Order the segs (vertical constraint graph) and fill tracks left-edge style:
 * a seg joins the leftmost track whose segs it clears, after every seg that
 * should sit left of it. Returns the track per seg, and the seg placed at the
 * cost of an overlap when the constraints left no better way out.
 */
function assign(segs: Seg[]): { track: number[]; tracks: number; overlapping?: number } {
  // before[j] maps each seg that should sit left of j to what ignoring that costs
  const before = segs.map(() => new Map<number, number>());
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.piece === t.piece) {
        // the halves of a dogleg, in drawing order away from side sa
        if (s.sa === 'L') before[j]!.set(i, Infinity);
        else before[i]!.set(j, Infinity);
        continue;
      }
      if (!near(s, t)) continue;
      const iLeft = cost(s, t);
      const jLeft = cost(t, s);
      if (iLeft < jLeft) before[j]!.set(i, jLeft - iLeft);
      else if (jLeft < iLeft) before[i]!.set(j, iLeft - jLeft);
    }

  const track = segs.map(() => -1);
  const done = new Set<number>();
  const unmet = (i: number) => {
    let sum = 0;
    let max = 0;
    for (const [j, c] of before[i]!)
      if (!done.has(j)) {
        sum += c;
        max = Math.max(max, c);
      }
    return { sum, max };
  };
  let overlapping: number | undefined;
  let remaining = segs.map((_, i) => i);
  let t = 0;
  while (remaining.length) {
    let cands = remaining.filter((i) => unmet(i).sum === 0);
    if (!cands.length) {
      // a cyclic constraint: give up the cheapest one
      const i = remaining.reduce((best, k) => (unmet(k).sum < unmet(best).sum ? k : best));
      if (unmet(i).max >= COLLINEAR / 2 && overlapping === undefined) overlapping = i;
      cands = [i];
    }
    cands.sort((a, b) => segs[a]!.lo - segs[b]!.lo || a - b);
    const here: number[] = [];
    for (const i of cands)
      if (here.every((j) => !near(segs[i]!, segs[j]!))) {
        here.push(i);
        track[i] = t;
      }
    here.forEach((i) => done.add(i));
    remaining = remaining.filter((i) => !done.has(i));
    t++;
  }
  return { track, tracks: t, overlapping };
}

/**
 * Channel routing of one gap: every bent piece gets a vertical track, ordered
 * to cross and overlap as little as possible.
 *
 * Some pieces overlap on a horizontal whichever order their verticals take:
 * two that trade places exactly (one leaves at the height the other arrives
 * at, and the other way round), or a cycle of such conflicts among three or
 * more. One of them then becomes a dogleg: a vertical on each side of the
 * conflict, joined by a horizontal at a free height. That costs two bends and
 * keeps only the crossings the order forces anyway.
 */
export function routeGap(items: Item[], ps: Piece[]): GapRoute {
  const all = ps.map((p, i) =>
    seg(i, items[p.a.item]!.y + p.a.dy, items[p.b.item]!.y + p.b.dy, p.sa, p.sb),
  );
  const bent = all.filter((s) => s.sa === s.sb || Math.abs(s.ya - s.yb) > EPS);
  const ys = all.flatMap((s) => [s.ya, s.yb]);
  const mid = new Map<number, number>();
  const split = (piece: number) => {
    const s = all[piece]!;
    const m = freeY(s.lo, s.hi, ys);
    ys.push(m);
    mid.set(piece, m);
  };
  const crosses = (s: Seg) => s.sa !== s.sb;
  for (const [i, s] of bent.entries())
    for (const t of bent.slice(i + 1))
      if (
        crosses(s) &&
        crosses(t) &&
        !mid.has(s.piece) &&
        !mid.has(t.piece) &&
        near(s, t) &&
        cost(s, t) >= COLLINEAR &&
        cost(t, s) >= COLLINEAR
      )
        split(t.piece);

  for (;;) {
    const segs = bent.flatMap((s) => {
      const m = mid.get(s.piece);
      return m === undefined
        ? [s]
        : [seg(s.piece, s.ya, m, s.sa, s.sb), seg(s.piece, m, s.yb, s.sa, s.sb)];
    });
    const { track, tracks, overlapping } = assign(segs);
    const o = overlapping === undefined ? undefined : segs[overlapping]!;
    if (!o || !crosses(o) || mid.has(o.piece)) {
      const runs: Run[][] = ps.map(() => []);
      segs.forEach((s, i) => runs[s.piece]!.push({ track: track[i]!, y0: s.ya, y1: s.yb }));
      return { runs, tracks };
    }
    split(o.piece);
  }
}
