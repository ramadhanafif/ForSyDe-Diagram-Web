import type { IRDelay, IRSignal, IRSystem } from './ir';
import { isDelay } from './ir';

/**
 * Started as a port of forsyde-devtools SDFSchedule.hs (exact rational
 * arithmetic): actors in first-appearance order, edges normal-then-delay. The
 * firing order is not the devtools one: the scheduler is round-robin class S
 * as in Sander's lecture notes (after a firing, try the next actor in order,
 * not the first), which reproduces the notes' schedule for Listing 6.1.
 * A disconnected graph gets a repetition vector per connected part.
 */

export interface Actor {
  name: string;
  isInput: boolean;
}

export interface Edge {
  edgeName: string;
  src: string;
  dst: string;
  prod: number;
  cons: number;
  initTokens: number;
  aliases: [string, string][];
}

export type ScheduleErrorKind =
  | 'rank'
  | 'deadlock'
  | 'no-positive-vector'
  | 'invalid-self-loop'
  | 'invalid-graph'
  | 'delay-wiring'
  | 'verify';

export type ScheduleResult =
  | {
      ok: true;
      schedule: string[];
      buffers: [string, number][];
      repetitions: Map<string, number>;
      aliases: Map<string, string>;
      /** Rank of the topology matrix, for analyze() so it need not row-reduce again. */
      rank: number;
    }
  | { ok: false; kind: ScheduleErrorKind; message: string; rank?: number };

export type ScheduleOk = Extract<ScheduleResult, { ok: true }>;

function err(kind: ScheduleErrorKind, message: string): ScheduleResult {
  return { ok: false, kind, message };
}

// ---------------------------------------------------------------------------
// Exact rationals over bigint (numerator n, denominator d > 0, normalized)

export interface Rat {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function rat(n: bigint, d = 1n): Rat {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

export const sub = (a: Rat, b: Rat): Rat => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
export const div = (a: Rat, b: Rat): Rat => rat(a.n * b.d, a.d * b.n);
const isZero = (a: Rat): boolean => a.n === 0n;

// ---------------------------------------------------------------------------
// Linear algebra: RREF, rank, nullspace, minimal integer vector

export function rowReduce(rows: Rat[][]): { rref: Rat[][]; pivots: number[] } {
  const nCols = rows[0]?.length ?? 0;
  let work = rows.map((r) => [...r]);
  const pivots: number[] = [];
  for (let col = 0; col < nCols; col++) {
    const done = pivots.length;
    let pivotRow = -1;
    for (let r = done; r < work.length; r++) {
      if (!isZero(work[r]![col]!)) {
        pivotRow = r;
        break;
      }
    }
    if (pivotRow === -1) continue;
    const p = work[pivotRow]!;
    // Γ is almost all zeros: skip them, rat() runs a bigint gcd per call
    const normalized = p.map((v) => (isZero(v) ? v : div(v, p[col]!)));
    const eliminate = (row: Rat[]): Rat[] => {
      const factor = row[col]!;
      if (isZero(factor)) return row;
      return row.map((v, i) => (isZero(normalized[i]!) ? v : sub(v, mul(factor, normalized[i]!))));
    };
    work = [
      ...work.slice(0, done).map(eliminate),
      normalized,
      ...work
        .slice(done)
        .filter((_, i) => i !== pivotRow - done)
        .map(eliminate),
    ];
    pivots.push(col);
  }
  return { rref: work, pivots };
}

function nullspaceBasis(nCols: number, rref: Rat[][], pivots: number[]): Rat[][] {
  const basis: Rat[][] = [];
  for (let free = 0; free < nCols; free++) {
    if (pivots.includes(free)) continue;
    const vec: Rat[] = [];
    for (let col = 0; col < nCols; col++) {
      if (col === free) vec.push(rat(1n));
      else {
        const i = pivots.indexOf(col);
        vec.push(i === -1 ? rat(0n) : rat(-rref[i]![free]!.n, rref[i]![free]!.d));
      }
    }
    basis.push(vec);
  }
  return basis;
}

export function toMinimalIntegers(xs: Rat[]): bigint[] {
  const commonDenom = xs.reduce((l, x) => (l * x.d) / (gcd(l, x.d) || 1n), 1n);
  const ints = xs.map((x) => x.n * (commonDenom / x.d));
  const g = ints.reduce((a, b) => gcd(a, b), 0n);
  const reduced = g === 0n ? ints : ints.map((v) => v / g);
  return reduced.every((v) => v < 0n) ? reduced.map((v) => -v) : reduced;
}

// ---------------------------------------------------------------------------
// IRSystem -> actors + edges (delay folding), mirroring convertIRSystem

/** Actors and channels with delays folded into edges; self-loops are kept, unchecked. */
export function buildChannels(
  ir: IRSystem,
): { actors: Actor[]; edges: Edge[] } | { error: ScheduleResult } {
  const delays = new Map(ir.processes.filter(isDelay).map((p) => [p.name, p]));
  const actorNames = [...new Set(ir.processes.filter((p) => !isDelay(p)).map((p) => p.name))];
  // an actor behind delays on a system input still reads from that input
  const inputActorNames = new Set<string>();
  for (const s of ir.signals) {
    if (!ir.inputs.includes(s.source.name)) continue;
    let t = s.target.name;
    for (const seen = new Set<string>(); delays.has(t) && !seen.has(t);) {
      seen.add(t);
      t = ir.signals.find((x) => x.source.name === t)?.target.name ?? t;
    }
    inputActorNames.add(t);
  }
  const actors: Actor[] = actorNames.map((n) => ({
    name: n,
    isInput: inputActorNames.has(n) || ir.inputs.includes(n),
  }));
  const actorSet = new Set(actorNames);

  const edges: Edge[] = [];
  for (const s of ir.signals) {
    const internal =
      !ir.inputs.includes(s.source.name) &&
      !ir.outputs.includes(s.target.name) &&
      !delays.has(s.source.name) &&
      !delays.has(s.target.name);
    if (!internal) continue;
    if (!actorSet.has(s.source.name) || !actorSet.has(s.target.name)) {
      return { error: err('invalid-graph', `Actor not found for signal '${s.name}'`) };
    }
    edges.push({
      edgeName: s.name,
      src: s.source.name,
      dst: s.target.name,
      prod: s.source.rate,
      cons: s.target.rate,
      initTokens: 0,
      aliases: [],
    });
  }

  // a chain of delays folds into one edge carrying the tokens of all of them
  const walked = new Set<string>();
  for (const head of delays.values()) {
    const into = ir.signals.filter((s) => s.target.name === head.name);
    if (into.length === 1 && delays.has(into[0]!.source.name)) continue; // walked from its head
    let first: IRSignal | undefined;
    let last: IRSignal | undefined;
    let tokens = 0;
    const aliases: [string, string][] = [];
    for (let d: IRDelay | undefined = head; d && !walked.has(d.name);) {
      walked.add(d.name);
      const incoming = ir.signals.filter((s) => s.target.name === d!.name);
      const outgoing = ir.signals.filter((s) => s.source.name === d!.name);
      // behind a system input nothing is checked (Haskell behavior)
      if (ir.inputs.includes(first?.source.name ?? incoming[0]?.source.name ?? '')) {
        first ??= incoming[0]!;
        last = outgoing[0];
        d = last && delays.get(last.target.name);
        continue;
      }
      if (incoming.length === 0)
        return { error: err('delay-wiring', `Delay '${d.name}' has no input signal`) };
      if (outgoing.length === 0)
        return { error: err('delay-wiring', `Delay '${d.name}' has no output signal`) };
      if (incoming.length !== 1 || outgoing.length !== 1)
        return {
          error: err('delay-wiring', `Delay '${d.name}' must have exactly one input and output`),
        };
      first ??= incoming[0]!;
      last = outgoing[0]!;
      tokens += d.tokens.length;
      aliases.push([last.name, first.name]);
      d = delays.get(last.target.name);
    }
    // delays adjacent to global I/O are ignored (Haskell behavior)
    if (ir.inputs.includes(first!.source.name) || ir.outputs.includes(last!.target.name)) continue;
    if (!actorSet.has(first!.source.name) || !actorSet.has(last!.target.name)) {
      return {
        error: err('delay-wiring', `Delay '${head.name}' must connect two actors directly`),
      };
    }
    edges.push({
      edgeName: first!.name,
      src: first!.source.name,
      dst: last!.target.name,
      prod: first!.source.rate,
      cons: last!.target.rate,
      initTokens: tokens,
      aliases: [[first!.name, first!.name], ...aliases],
    });
  }
  const stray = [...delays.keys()].find((d) => !walked.has(d));
  if (stray) return { error: err('delay-wiring', `Delay '${stray}' is on a loop of delays only`) };

  return { actors, edges };
}

function convertIRSystem(
  ir: IRSystem,
): { actors: Actor[]; edges: Edge[] } | { error: ScheduleResult } {
  const conv = buildChannels(ir);
  if ('error' in conv) return conv;
  for (const e of conv.edges) {
    if (e.src === e.dst && e.prod !== e.cons) {
      return {
        error: err(
          'invalid-self-loop',
          `Invalid self-loop on actor '${e.src}' (edge '${e.edgeName}'): prod=${e.prod}, cons=${e.cons}`,
        ),
      };
    }
  }
  return conv;
}

// ---------------------------------------------------------------------------
// Round-robin class S scheduling + buffer simulation

function greedySchedule(actors: Actor[], edges: Edge[], reps: number[]): number[] | ScheduleResult {
  const incoming = actors.map((a, _i) => edges.flatMap((e, ei) => (e.dst === a.name ? [ei] : [])));
  const outgoing = actors.map((a) => edges.flatMap((e, ei) => (e.src === a.name ? [ei] : [])));
  const remaining = [...reps];
  const tokens = edges.map((e) => e.initTokens);
  const schedule: number[] = [];
  let left = remaining.reduce((a, b) => a + b, 0);
  // round robin: after a firing the search goes on from the next actor
  let start = 0;
  while (left > 0) {
    let fired = -1;
    for (let k = 0; k < actors.length && fired === -1; k++) {
      const i = (start + k) % actors.length;
      if (remaining[i]! <= 0) continue;
      const inc = incoming[i]!;
      if (inc.length === 0) {
        if (!actors[i]!.isInput) {
          return err(
            'invalid-graph',
            `Actor '${actors[i]!.name}' has no incoming edges but is not an input actor`,
          );
        }
        fired = i;
      } else if (inc.every((ei) => tokens[ei]! >= edges[ei]!.cons)) {
        fired = i;
      }
    }
    if (fired === -1) return err('deadlock', 'Deadlock detected: no fireable actor');
    for (const ei of incoming[fired]!) tokens[ei]! -= edges[ei]!.cons;
    for (const ei of outgoing[fired]!) tokens[ei]! += edges[ei]!.prod;
    remaining[fired]!--;
    left--;
    schedule.push(fired);
    start = (fired + 1) % actors.length;
  }
  return schedule;
}

function simulateBufferUsage(
  actors: Actor[],
  edges: Edge[],
  schedule: number[],
): [string, number][] {
  const tokens = edges.map((e) => e.initTokens);
  const maxTokens = [...tokens];
  for (const actorIdx of schedule) {
    const a = actors[actorIdx]!;
    edges.forEach((e, ei) => {
      if (e.dst === a.name) tokens[ei]! -= e.cons;
    });
    edges.forEach((e, ei) => {
      if (e.src === a.name) tokens[ei]! += e.prod;
    });
    tokens.forEach((t, ei) => {
      if (t > maxTokens[ei]!) maxTokens[ei] = t;
    });
  }
  return edges.map((e, ei) => [e.edgeName, maxTokens[ei]!]);
}

// ---------------------------------------------------------------------------
// I/O buffer sizes with delay chasing, mirroring computeIOBufferSizes

function computeIOBufferSizes(
  ir: IRSystem,
  reps: Map<string, number>,
): { ioBuffers: [string, number][]; aliases: [string, string][] } | { error: ScheduleResult } {
  const procByName = new Map(ir.processes.map((p) => [p.name, p]));
  const ioBuffers: [string, number][] = [];
  const aliases: [string, string][] = [];

  const chase = (
    sigId: string,
    endpoint: string,
    rate: number,
    dir: 'in' | 'out',
    accAliases: [string, string][],
    nTokens: number,
    visited: Set<string> = new Set(),
  ): { endpoint: string; rate: number; aliases: [string, string][]; nTokens: number } | string => {
    const p = procByName.get(endpoint);
    if (!p) return `Could not find the process '${endpoint}'`;
    if (visited.has(endpoint)) return `Delay cycle detected at '${endpoint}'`;
    visited.add(endpoint);
    if (!isDelay(p)) return { endpoint, rate, aliases: accAliases, nTokens };
    const nextSig =
      dir === 'in'
        ? ir.signals.find((s) => s.source.name === p.name)
        : ir.signals.find((s) => s.target.name === p.name);
    if (!nextSig) return `Could not find the signal adjacent to delay '${p.name}'`;
    const nextEnd = dir === 'in' ? nextSig.target : nextSig.source;
    return chase(
      sigId,
      nextEnd.name,
      nextEnd.rate,
      dir,
      [...accAliases, [sigId, sigId], [nextSig.name, sigId]],
      nTokens + p.tokens.length,
      visited,
    );
  };

  for (const s of ir.signals) {
    if (!ir.inputs.includes(s.source.name)) continue;
    const r = chase(s.name, s.target.name, s.target.rate, 'in', [], 0);
    if (typeof r === 'string') return { error: err('delay-wiring', r) };
    const rep = reps.get(r.endpoint);
    if (rep === undefined)
      return { error: err('invalid-graph', `Actor '${r.endpoint}' has no repetition count`) };
    ioBuffers.push([s.name, Math.max(r.rate * rep, r.nTokens)]);
    aliases.push(...r.aliases);
  }
  for (const s of ir.signals) {
    if (!ir.outputs.includes(s.target.name)) continue;
    const r = chase(s.name, s.source.name, s.source.rate, 'out', [], 0);
    if (typeof r === 'string') return { error: err('delay-wiring', r) };
    const rep = reps.get(r.endpoint);
    if (rep === undefined)
      return { error: err('invalid-graph', `Actor '${r.endpoint}' has no repetition count`) };
    ioBuffers.push([s.name, Math.max(r.rate * rep, r.nTokens)]);
    aliases.push(...r.aliases);
  }
  return { ioBuffers, aliases };
}

// ---------------------------------------------------------------------------

/** Connected part of each actor (0, 1, ...) over the internal edges. */
export function actorParts(actors: Actor[], edges: Edge[]): number[] {
  const idx = new Map(actors.map((a, i) => [a.name, i]));
  const parent = actors.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const e of edges) parent[find(idx.get(e.src)!)] = find(idx.get(e.dst)!);
  const ids = new Map<number, number>();
  return actors.map((_, i) => {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r)!;
  });
}

export function computeScheduleAndBuffers(ir: IRSystem): ScheduleResult {
  const conv = convertIRSystem(ir);
  if ('error' in conv) return conv.error;
  const { actors, edges } = conv;

  let schedIdxs: number[];
  let repCounts: number[];
  let rank = 0;

  if (edges.length === 0) {
    schedIdxs = actors.map((_, i) => i);
    repCounts = actors.map(() => 1);
  } else {
    // topology matrix: rows = edges, cols = actors; self-loops are zero rows
    const mat = edges.map((e) =>
      actors.map((a) => {
        if (e.src === e.dst) return 0n;
        if (e.src === a.name) return BigInt(e.prod);
        if (e.dst === a.name) return -BigInt(e.cons);
        return 0n;
      }),
    );
    // each connected part has rank = its actors - 1 when its rates are consistent
    const parts = new Set(actorParts(actors, edges)).size;
    const { rref, pivots } = rowReduce(mat.map((row) => row.map((v) => rat(v))));
    rank = pivots.length;
    if (rank !== actors.length - parts) {
      return {
        ok: false,
        kind: 'rank',
        message:
          parts === 1
            ? 'Inconsistent rates: the topology matrix rank must equal the number of actors minus one'
            : `Inconsistent rates: the topology matrix rank must equal the number of actors minus the number of connected parts (${parts})`,
        rank,
      };
    }
    // one basis vector per part, zero outside it: minimal integers within each part
    const basis = nullspaceBasis(actors.length, rref, pivots);
    if (basis.length === 0) return err('rank', 'No repetition vector found');
    const repInt = actors.map(() => 0n);
    for (const b of basis) {
      const idx = b.flatMap((r, i) => (isZero(r) ? [] : [i]));
      toMinimalIntegers(idx.map((i) => b[i]!)).forEach((v, k) => (repInt[idx[k]!] = v));
    }
    if (repInt.some((v) => v <= 0n)) {
      return err('no-positive-vector', 'No strictly positive repetition vector exists');
    }
    // ponytail: hard cap keeps the synchronous scheduler from freezing the tab
    // on co-prime rate explosions; lift if someone has a real >100k-firing model
    const totalFirings = repInt.reduce((a, b) => a + b, 0n);
    if (totalFirings > 100_000n) {
      return err(
        'invalid-graph',
        `Repetition vector too large (${totalFirings} firings per period): check the rates`,
      );
    }
    // exact verification: mat * rep == 0
    for (const row of mat) {
      const dot = row.reduce((acc, v, i) => acc + v * repInt[i]!, 0n);
      if (dot !== 0n) return err('verify', 'Repetition vector verification failed');
    }
    repCounts = repInt.map((v) => Number(v));
    const sched = greedySchedule(actors, edges, repCounts);
    if (!Array.isArray(sched)) return sched;
    schedIdxs = sched;
  }

  const repetitions = new Map(actors.map((a, i) => [a.name, repCounts[i]!]));
  const io = computeIOBufferSizes(ir, repetitions);
  if ('error' in io) return io.error;
  const internal = edges.length === 0 ? [] : simulateBufferUsage(actors, edges, schedIdxs);
  const delayAliases = edges.flatMap((e) => e.aliases);

  return {
    ok: true,
    schedule: schedIdxs.map((i) => actors[i]!.name),
    buffers: [...io.ioBuffers, ...internal],
    repetitions,
    aliases: new Map([...delayAliases, ...io.aliases]),
    rank,
  };
}
