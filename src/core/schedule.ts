import type { IRSystem } from './ir';
import { isDelay } from './ir';

/**
 * Port of forsyde-devtools SDFSchedule.hs (exact rational arithmetic
 * version). Iteration orders are preserved so results match the Haskell
 * implementation: actors in first-appearance order, edges normal-then-delay,
 * greedy scheduler fires the first fireable actor.
 */

interface Actor {
  name: string;
  isInput: boolean;
}

interface Edge {
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
    }
  | { ok: false; kind: ScheduleErrorKind; message: string };

function err(kind: ScheduleErrorKind, message: string): ScheduleResult {
  return { ok: false, kind, message };
}

// ---------------------------------------------------------------------------
// Exact rationals over bigint (numerator n, denominator d > 0, normalized)

interface Rat {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function rat(n: bigint, d = 1n): Rat {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

const sub = (a: Rat, b: Rat): Rat => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
const div = (a: Rat, b: Rat): Rat => rat(a.n * b.d, a.d * b.n);
const isZero = (a: Rat): boolean => a.n === 0n;

// ---------------------------------------------------------------------------
// Linear algebra: RREF, rank, nullspace, minimal integer vector

function rowReduce(rows: Rat[][]): { rref: Rat[][]; pivots: number[] } {
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
    const normalized = p.map((v) => div(v, p[col]!));
    const eliminate = (row: Rat[]): Rat[] => {
      const factor = row[col]!;
      if (isZero(factor)) return row;
      return row.map((v, i) => sub(v, mul(factor, normalized[i]!)));
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

function nullspaceBasis(mat: bigint[][]): Rat[][] {
  const nCols = mat[0]?.length ?? 0;
  const { rref, pivots } = rowReduce(mat.map((row) => row.map((v) => rat(v))));
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

function toMinimalIntegers(xs: Rat[]): bigint[] {
  const commonDenom = xs.reduce((l, x) => (l * x.d) / (gcd(l, x.d) || 1n), 1n);
  const ints = xs.map((x) => x.n * (commonDenom / x.d));
  const g = ints.reduce((a, b) => gcd(a, b), 0n);
  const reduced = g === 0n ? ints : ints.map((v) => v / g);
  return reduced.every((v) => v < 0n) ? reduced.map((v) => -v) : reduced;
}

// ---------------------------------------------------------------------------
// IRSystem -> actors + edges (delay folding), mirroring convertIRSystem

function convertIRSystem(
  ir: IRSystem,
): { actors: Actor[]; edges: Edge[] } | { error: ScheduleResult } {
  const delayNames = ir.processes.filter(isDelay).map((p) => p.name);
  const actorNames = [...new Set(ir.processes.filter((p) => !isDelay(p)).map((p) => p.name))];
  const inputActorNames = new Set(
    ir.signals.filter((s) => ir.inputs.includes(s.source.name)).map((s) => s.target.name),
  );
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
      !delayNames.includes(s.source.name) &&
      !delayNames.includes(s.target.name);
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

  for (const delay of ir.processes.filter(isDelay)) {
    const incoming = ir.signals.filter((s) => s.target.name === delay.name);
    const outgoing = ir.signals.filter((s) => s.source.name === delay.name);
    // delays adjacent to global I/O are ignored (Haskell behavior)
    if (incoming.length === 1 && ir.inputs.includes(incoming[0]!.name)) continue;
    if (outgoing.length === 1 && ir.outputs.includes(outgoing[0]!.name)) continue;
    if (incoming.length === 0)
      return { error: err('delay-wiring', `Delay '${delay.name}' has no input signal`) };
    if (outgoing.length === 0)
      return { error: err('delay-wiring', `Delay '${delay.name}' has no output signal`) };
    if (incoming.length !== 1 || outgoing.length !== 1)
      return {
        error: err('delay-wiring', `Delay '${delay.name}' must have exactly one input and output`),
      };
    const inSig = incoming[0]!;
    const outSig = outgoing[0]!;
    if (!actorSet.has(inSig.source.name) || !actorSet.has(outSig.target.name)) {
      return {
        error: err('delay-wiring', `Delay '${delay.name}' must connect two actors directly`),
      };
    }
    edges.push({
      edgeName: inSig.name,
      src: inSig.source.name,
      dst: outSig.target.name,
      prod: inSig.source.rate,
      cons: outSig.target.rate,
      initTokens: delay.tokens.length,
      aliases: [
        [inSig.name, inSig.name],
        [outSig.name, inSig.name],
      ],
    });
  }

  for (const e of edges) {
    if (e.src === e.dst && e.prod !== e.cons) {
      return {
        error: err(
          'invalid-self-loop',
          `Invalid self-loop on actor '${e.src}' (edge '${e.edgeName}'): prod=${e.prod}, cons=${e.cons}`,
        ),
      };
    }
  }
  return { actors, edges };
}

// ---------------------------------------------------------------------------
// Greedy scheduling + buffer simulation

function greedySchedule(actors: Actor[], edges: Edge[], reps: number[]): number[] | ScheduleResult {
  const incoming = actors.map((a, _i) => edges.flatMap((e, ei) => (e.dst === a.name ? [ei] : [])));
  const outgoing = actors.map((a) => edges.flatMap((e, ei) => (e.src === a.name ? [ei] : [])));
  const remaining = [...reps];
  const tokens = edges.map((e) => e.initTokens);
  const schedule: number[] = [];
  let left = remaining.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let fired = -1;
    for (let i = 0; i < actors.length && fired === -1; i++) {
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

export function computeScheduleAndBuffers(ir: IRSystem): ScheduleResult {
  const conv = convertIRSystem(ir);
  if ('error' in conv) return conv.error;
  const { actors, edges } = conv;

  let schedIdxs: number[];
  let repCounts: number[];

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
    const { pivots } = rowReduce(mat.map((row) => row.map((v) => rat(v))));
    if (pivots.length !== actors.length - 1) {
      return err(
        'rank',
        'Inconsistent rates: the topology matrix rank must equal the number of actors minus one',
      );
    }
    const basis = nullspaceBasis(mat);
    if (basis.length === 0) return err('rank', 'No repetition vector found');
    const repInt = toMinimalIntegers(basis[0]!);
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
  };
}
