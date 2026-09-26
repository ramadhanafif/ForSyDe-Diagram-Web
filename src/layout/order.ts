/** A layer entry: a node, or a dummy carrying one edge through a column. */
export interface Item {
  /** Node id; undefined for a dummy. */
  node?: string;
  /** A dummy or an io pill: nothing drawn above it. */
  light: boolean;
  io: boolean;
  layer: number;
  order: number;
  /** Initial sort key (previous scene order, else DFS discovery). */
  rank: number;
  /** Vertical extent around y, labels included (top < 0). */
  top: number;
  bottom: number;
  y: number;
}

/** Where an edge piece meets a layer item: vertical offset and slot for ordering. */
export interface End {
  item: number;
  dy: number;
  /** Position inside the item for crossing counts, in (0, 1). */
  frac: number;
}

/**
 * The part of an edge inside one inter-layer gap, in drawing order: from end
 * a on side sa to end b on side sb. L/R pieces cross the gap; L/L and R/R are
 * the hooks where a feedback edge turns around.
 */
export interface Piece {
  edge: number;
  gap: number;
  a: End;
  b: End;
  sa: 'L' | 'R';
  sb: 'L' | 'R';
}

/**
 * The ports on one side of a node. ends[i] are the edge ends at the i-th port
 * in argument order; slot[i] is the slot (End.frac) it takes, an index into
 * fracs, which lists the side's slots top to bottom.
 */
export interface PortGroup {
  item: number;
  ends: End[][];
  fracs: number[];
  slot: number[];
  /** Output side (faces the next layer). */
  out: boolean;
}

/** Largest layer permuted exhaustively (6! = 720 orders). */
const EXHAUSTIVE_MAX = 6;
const BARY_ROUNDS = 4;
const REFINE_ROUNDS = 3;
/**
 * Piece pairs compared per call, barycenter sweeps included. A pair costs
 * about 38 ns, so the cap holds ordering near 3 ms and leaves the rest of the
 * 4 ms budget to placement and routing. The largest fixture (022) needs about
 * 51k; a larger or loop-heavy model gives up exact search instead of time.
 * Each step checks the budget before it starts, so the last one may overrun it
 * by up to two counts of every gap (a chain swap touching every layer).
 */
export const WORK_BUDGET = 80_000;

const key = (items: Item[], e: End) => items[e.item]!.order + e.frac;

/** Span kinds: a piece across the gap, or a hook on its left or right side. */
type Kind = 0 | 1 | 2;
const LR = 0;
const LL = 1;
const RR = 2;

/**
 * Crossings forced by the orders alone, however the gap is routed. A span is
 * a piece reduced to its kind and two keys: for LR the left and right key,
 * for a hook the lower and upper key on its side.
 */
function pairCross(sk: Kind, slo: number, shi: number, tk: Kind, tlo: number, thi: number): number {
  if (sk === LR && tk === LR) return (slo - tlo) * (shi - thi) < 0 ? 1 : 0;
  if (sk === LR) return pairCross(tk, tlo, thi, sk, slo, shi);
  const inside = (k: number) => slo < k && k < shi;
  if (tk === LR) return inside(sk === LL ? tlo : thi) ? 1 : 0;
  if (sk !== tk) return 0;
  return inside(tlo) !== inside(thi) && tlo !== slo && tlo !== shi && thi !== slo && thi !== shi
    ? 1
    : 0;
}

/** Exact crossing count of one gap from the current orders; `work` counts pairs compared. */
function gapCrossings(items: Item[], ps: Piece[], work: { left: number }): number {
  const n = ps.length;
  work.left -= (n * (n - 1)) / 2;
  const kind: Kind[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  for (const p of ps) {
    const ka = key(items, p.a);
    const kb = key(items, p.b);
    if (p.sa === p.sb) {
      kind.push(p.sa === 'L' ? LL : RR);
      lo.push(Math.min(ka, kb));
      hi.push(Math.max(ka, kb));
    } else {
      kind.push(LR);
      lo.push(p.sa === 'L' ? ka : kb);
      hi.push(p.sa === 'L' ? kb : ka);
    }
  }
  let c = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      c += pairCross(kind[i]!, lo[i]!, hi[i]!, kind[j]!, lo[j]!, hi[j]!);
  return c;
}

const fact = (n: number): number => (n <= 1 ? 1 : n * fact(n - 1));

/** Heap's algorithm; visits every order of `a` in place, the identity first. */
function permute(a: number[], visit: () => void): void {
  const c = new Array<number>(a.length).fill(0);
  visit();
  let i = 1;
  while (i < a.length) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      [a[j], a[i]] = [a[i]!, a[j]!];
      visit();
      c[i] = c[i]! + 1;
      i = 1;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

/**
 * Order every layer to minimise crossings, counted exactly at port level
 * (hooks included):
 *
 * 1. Barycenter sweeps from the initial ranks.
 * 2. Exhaustive permutation of each small layer, adjacent swaps for a larger
 *    one, against the crossings of its two gaps.
 * 3. Whole dummy-chain moves (to the top or bottom, or two chains swapped),
 *    which one layer at a time cannot find.
 * 4. Where crossings remain, the ports on a node side trade slots, each
 *    order judged after the layer the side faces has reordered to suit it.
 * 5. A joint search over two neighbouring layers, while budget remains.
 *
 * Every step keeps a change only when it strictly lowers the count, so ties
 * keep the initial order, which is the previous scene's where there is one.
 * Returns the piece pairs compared, every phase counted.
 */
export function orderLayers(
  items: Item[],
  layers: number[][],
  byGap: Map<number, Piece[]>,
  ports: PortGroup[] = [],
): number {
  const work = { left: WORK_BUDGET };
  const setOrder = (l: number[]) => l.forEach((it, i) => (items[it]!.order = i));
  const restore = (saved: number[][]) =>
    layers.forEach((l, L) => {
      l.splice(0, l.length, ...saved[L]!);
      setOrder(l);
    });
  for (const l of layers) {
    l.sort((a, b) => items[a]!.rank - items[b]!.rank);
    setOrder(l);
  }
  const gapCost = (gap: number) => gapCrossings(items, byGap.get(gap) ?? [], work);
  const local = (L: number) => gapCost(L - 1) + gapCost(L);
  const total = () => {
    let c = 0;
    for (const gap of byGap.keys()) c += gapCost(gap);
    return c;
  };

  let best = total();
  let snapshot = layers.map((l) => [...l]);
  const bary = (L: number, side: 'L' | 'R') => {
    const layer = layers[L]!;
    const sum = new Map<number, { s: number; n: number }>();
    const mySide = side === 'L' ? 'R' : 'L';
    for (const p of byGap.get(side === 'L' ? L - 1 : L) ?? []) {
      if (p.sa === p.sb) continue;
      const [mine, other] = p.sa === mySide ? [p.a, p.b] : [p.b, p.a];
      if (items[mine.item]!.layer !== L) continue;
      const acc = sum.get(mine.item) ?? { s: 0, n: 0 };
      acc.s += key(items, other);
      acc.n++;
      sum.set(mine.item, acc);
    }
    const val = new Map(
      layer.map((it) => {
        const acc = sum.get(it);
        return [it, acc ? acc.s / acc.n : items[it]!.order + 0.5] as const;
      }),
    );
    layer.sort((a, b) => val.get(a)! - val.get(b)! || items[a]!.order - items[b]!.order);
    setOrder(layer);
  };
  for (let r = 0; r < BARY_ROUNDS && best > 0 && work.left > 0; r++) {
    for (let L = 1; L < layers.length; L++) bary(L, 'L');
    for (let L = layers.length - 2; L >= 0; L--) bary(L, 'R');
    const c = total();
    if (c < best) {
      best = c;
      snapshot = layers.map((l) => [...l]);
    }
  }
  restore(snapshot);

  /** Upper bound on the pairs one count of these gaps compares. */
  const pairsIn = (gaps: number[]) =>
    gaps.reduce((t, gap) => t + (byGap.get(gap)?.length ?? 0) ** 2 / 2, 0);
  const improveLayer = (L: number): boolean => {
    const layer = layers[L]!;
    if (layer.length < 2 || work.left <= 0) return false;
    let cur = local(L);
    if (cur === 0) return false;
    let improved = false;
    if (layer.length <= EXHAUSTIVE_MAX && fact(layer.length) * pairsIn([L - 1, L]) <= work.left) {
      let bestPerm = [...layer];
      permute(layer, () => {
        setOrder(layer);
        const c = local(L);
        if (c < cur) {
          cur = c;
          bestPerm = [...layer];
          improved = true;
        }
      });
      layer.splice(0, layer.length, ...bestPerm);
      setOrder(layer);
      return improved;
    }
    // too large to enumerate: adjacent swaps while they help
    for (let i = 0; i + 1 < layer.length && work.left > 0; i++) {
      [layer[i], layer[i + 1]] = [layer[i + 1]!, layer[i]!];
      setOrder(layer);
      const c = local(L);
      if (c < cur) {
        cur = c;
        improved = true;
      } else {
        [layer[i], layer[i + 1]] = [layer[i + 1]!, layer[i]!];
        setOrder(layer);
      }
    }
    return improved;
  };
  const refine = () => {
    for (let r = 0; r < REFINE_ROUNDS && work.left > 0; r++) {
      let improved = false;
      for (let L = 0; L < layers.length; L++) improved = improveLayer(L) || improved;
      if (!improved) break;
    }
  };

  // a long edge that must change sides in several layers at once: move its
  // whole dummy chain
  const chains = new Map<number, number[]>();
  for (const ps of byGap.values())
    for (const p of ps)
      for (const e of [p.a, p.b]) {
        if (items[e.item]!.node) continue;
        const c = chains.get(p.edge) ?? [];
        if (!c.includes(e.item)) c.push(e.item);
        chains.set(p.edge, c);
      }
  const chainList = [...chains.values()];
  /** Apply `move` to the given layers; keep it only when their gaps cross less. */
  const tryMove = (touched: number[], move: () => void): boolean => {
    const gaps = [...new Set(touched.flatMap((L) => [L - 1, L]))];
    const cost = () => gaps.reduce((t, gap) => t + gapCost(gap), 0);
    const saved = layers.map((l) => [...l]);
    const c0 = cost();
    move();
    touched.forEach((L) => setOrder(layers[L]!));
    if (cost() < c0) return true;
    restore(saved);
    return false;
  };
  const layersOf = (chain: number[]) => chain.map((it) => items[it]!.layer);
  const toEnd = (chain: number[], top: boolean) => () => {
    for (const it of chain) {
      const l = layers[items[it]!.layer]!;
      l.splice(l.indexOf(it), 1);
      if (top) l.unshift(it);
      else l.push(it);
    }
  };
  const swap = (a: number[], b: number[]) => () => {
    for (const x of a) {
      const y = b.find((d) => items[d]!.layer === items[x]!.layer);
      if (y === undefined) continue;
      const l = layers[items[x]!.layer]!;
      const i = l.indexOf(x);
      const j = l.indexOf(y);
      [l[i], l[j]] = [y, x];
    }
  };

  for (let r = 0; r < REFINE_ROUNDS; r++) {
    refine();
    if (work.left <= 0 || total() === 0) break;
    let moved = false;
    for (const [i, a] of chainList.entries()) {
      if (work.left <= 0) break;
      moved =
        tryMove(layersOf(a), toEnd(a, true)) || tryMove(layersOf(a), toEnd(a, false)) || moved;
      for (const b of chainList.slice(i + 1))
        if (work.left > 0) moved = tryMove([...layersOf(a), ...layersOf(b)], swap(a, b)) || moved;
    }
    if (!moved) break;
  }

  // ports trade slots on their side, only where the orders above still
  // cross: a drawing that is already planar keeps its argument order. A new
  // slot order is judged after the layer the side faces has reordered to
  // suit it, since a port swap alone rarely helps a settled layer.
  const setSlots = (g: PortGroup) =>
    g.ends.forEach((es, i) => es.forEach((e) => (e.frac = g.fracs[g.slot[i]!]!)));
  const improvePorts = (g: PortGroup): boolean => {
    const L = items[g.item]!.layer;
    const N = g.out ? L + 1 : L - 1;
    const gaps = g.out ? [L - 1, L, L + 1] : [L - 2, L - 1, L];
    const cost = () => gaps.reduce((t, gap) => t + gapCost(gap), 0);
    const s = g.slot;
    // ponytail: sides of more than EXHAUSTIVE_MAX ports keep argument order
    if (s.length > EXHAUSTIVE_MAX || fact(s.length) * pairsIn(gaps) > work.left) return false;
    let cur = cost();
    if (cur === 0) return false;
    const base = layers.map((l) => [...l]);
    let slot = [...s];
    let order = base;
    permute(s, () => {
      if (work.left <= 0) return;
      setSlots(g);
      if (N >= 0 && N < layers.length) improveLayer(N);
      const c = cost();
      if (c < cur) {
        cur = c;
        slot = [...s];
        order = layers.map((l) => [...l]);
      }
      restore(base);
    });
    s.splice(0, s.length, ...slot);
    setSlots(g);
    restore(order);
    return order !== base;
  };
  for (let r = 0; r < REFINE_ROUNDS && ports.length && work.left > 0 && total() > 0; r++) {
    let improved = false;
    for (const g of ports) improved = improvePorts(g) || improved;
    if (!improved) break;
    refine();
  }

  // last resort for small graphs: two neighbouring layers permuted jointly
  for (let L = 0; L + 1 < layers.length && work.left > 0 && total() > 0; L++) {
    const A = layers[L]!;
    const B = layers[L + 1]!;
    if (fact(A.length) * fact(B.length) * pairsIn([L - 1, L, L + 1]) > work.left) continue;
    const cost = () => gapCost(L - 1) + gapCost(L) + gapCost(L + 1);
    let cur = cost();
    let found: [number[], number[]] = [[...A], [...B]];
    permute(A, () => {
      setOrder(A);
      permute(B, () => {
        setOrder(B);
        const c = cost();
        if (c < cur) {
          cur = c;
          found = [[...A], [...B]];
        }
      });
    });
    A.splice(0, A.length, ...found[0]);
    B.splice(0, B.length, ...found[1]);
    setOrder(A);
    setOrder(B);
  }
  return WORK_BUDGET - work.left;
}
