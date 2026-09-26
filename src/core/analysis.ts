import type { IRSystem } from './ir';
import { isDelay } from './ir';
import { buildChannels, div, mul, rat, rowReduce, toMinimalIntegers, type Rat } from './schedule';

/**
 * The formal view of a model: the topology matrix Γ, its rank, the balance
 * equations and the repetition vector q, or the loop of channels whose rates
 * contradict each other. It sits beside the scheduler port (which it does not
 * change) so the UI can explain a failure in the model's own names.
 */

/** A channel between two actors, a delay folded in as initial tokens. */
export interface Channel {
  signal: string;
  src: string;
  dst: string;
  prod: number;
  cons: number;
  tokens: number;
  /** The delay folded into this channel, if any. */
  delay: string | null;
}

/** Two ways from `from` to `to` that demand different firing ratios q(to)/q(from). */
export interface Conflict {
  from: string;
  to: string;
  pathA: Channel[];
  ratioA: [number, number];
  pathB: Channel[];
  ratioB: [number, number];
}

export interface Analysis {
  actors: string[];
  channels: Channel[];
  /** Rows are channels, columns actors: prod at the source, -cons at the destination. */
  gamma: number[][];
  rank: number;
  /** Minimal positive repetition vector; null when inconsistent or disconnected. */
  q: Map<string, number> | null;
  conflict: Conflict | null;
  /** Weakly connected parts of the actor graph. */
  parts: number;
}

const frac = (r: Rat): [number, number] => [Number(r.n), Number(r.d)];
const eq = (a: Rat, b: Rat) => a.n === b.n && a.d === b.d;

/** Null when the model has no channel structure yet (bad delay wiring, a dangling signal). */
export function analyze(ir: IRSystem): Analysis | null {
  const conv = buildChannels(ir);
  if ('error' in conv) return null;
  const actors = conv.actors.map((a) => a.name);
  const delayOf = new Map<string, string>();
  for (const d of ir.processes.filter(isDelay)) {
    const inSig = ir.signals.find((s) => s.target.name === d.name);
    if (inSig) delayOf.set(inSig.name, d.name);
  }
  const channels: Channel[] = conv.edges.map((e) => ({
    signal: e.edgeName,
    src: e.src,
    dst: e.dst,
    prod: e.prod,
    cons: e.cons,
    tokens: e.initTokens,
    delay: delayOf.get(e.edgeName) ?? null,
  }));
  const gamma = channels.map((c) =>
    actors.map((a) =>
      c.src === c.dst
        ? a === c.src
          ? c.prod - c.cons
          : 0
        : a === c.src
          ? c.prod
          : a === c.dst
            ? -c.cons
            : 0,
    ),
  );
  const rank = channels.length
    ? rowReduce(gamma.map((row) => row.map((v) => rat(BigInt(v))))).pivots.length
    : 0;

  // spanning forest: q relative to each part's root, and each actor's tree edge up
  const q = new Map<string, Rat>();
  const up = new Map<string, { ch: Channel; parent: string }>();
  let parts = 0;
  for (const root of actors) {
    if (q.has(root)) continue;
    parts++;
    q.set(root, rat(1n));
    const queue = [root];
    while (queue.length) {
      const u = queue.shift()!;
      for (const c of channels) {
        if (c.src === c.dst || (c.src !== u && c.dst !== u)) continue;
        const v = c.src === u ? c.dst : c.src;
        if (q.has(v)) continue;
        // prod·q(src) = cons·q(dst)
        const qu = q.get(u)!;
        q.set(
          v,
          c.src === u
            ? mul(qu, rat(BigInt(c.prod), BigInt(c.cons)))
            : mul(qu, rat(BigInt(c.cons), BigInt(c.prod))),
        );
        up.set(v, { ch: c, parent: u });
        queue.push(v);
      }
    }
  }

  const chain = (a: string) => {
    const out = [a];
    for (let x = a; up.has(x);) out.push((x = up.get(x)!.parent));
    return out;
  };
  /** Tree channels from `anc` down to `x`. */
  const down = (anc: string, x: string) => {
    const out: Channel[] = [];
    for (let y = x; y !== anc; y = up.get(y)!.parent) out.unshift(up.get(y)!.ch);
    return out;
  };
  let conflict: Conflict | null = null;
  for (const c of channels) {
    if (c.src === c.dst) {
      if (c.prod !== c.cons)
        conflict = {
          from: c.src,
          to: c.src,
          pathA: [],
          ratioA: [1, 1],
          pathB: [c],
          ratioB: frac(rat(BigInt(c.prod), BigInt(c.cons))),
        };
    } else {
      const want = mul(q.get(c.src)!, rat(BigInt(c.prod), BigInt(c.cons)));
      if (!eq(want, q.get(c.dst)!)) {
        const srcUp = chain(c.src);
        const lca = chain(c.dst).find((x) => srcUp.includes(x))!;
        const base = q.get(lca)!;
        conflict = {
          from: lca,
          to: c.dst,
          pathA: down(lca, c.dst),
          ratioA: frac(div(q.get(c.dst)!, base)),
          pathB: [...down(lca, c.src), c],
          ratioB: frac(div(want, base)),
        };
      }
    }
    if (conflict) break;
  }

  const reps =
    conflict || parts !== 1
      ? null
      : new Map(
          toMinimalIntegers(actors.map((a) => q.get(a)!)).map((v, i) => [actors[i]!, Number(v)]),
        );
  return { actors, channels, gamma, rank, q: reps, conflict, parts };
}

/** A flat schedule written with repetition counts: `3(a_up) 2(a_down)`. */
export function loopedSchedule(firings: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < firings.length;) {
    let j = i;
    while (firings[j] === firings[i]) j++;
    out.push(j - i > 1 ? `${j - i}(${firings[i]})` : firings[i]!);
    i = j;
  }
  return out.join(' ');
}

/** `2·q(a_up) = 3·q(a_down)`, and with q filled in `2·3 = 3·2`. */
export function balanceEquation(c: Channel, q?: Map<string, number> | null): string {
  const sym = `${c.prod}·q(${c.src}) = ${c.cons}·q(${c.dst})`;
  if (!q) return sym;
  const qs = q.get(c.src)!;
  const qd = q.get(c.dst)!;
  return `${sym}: ${c.prod}·${qs} = ${c.cons}·${qd}`;
}
