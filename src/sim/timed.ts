import type { Analysis } from '../core/analysis';

/**
 * Self-timed execution: every actor fires as soon as its input tokens are
 * there and its previous firing has ended (no overlap with itself), taking the
 * time given in a `-- @time <actor> <duration>` comment line, 1 by default.
 * System inputs always have tokens. It answers what the untimed model cannot:
 * how often an iteration completes, and when the first one does.
 */

const TIME_RE = /^--\s*@time\s+([A-Za-z_][\w']*)\s+(\d+(?:\.\d+)?)\s*$/gm;

/** Execution times from `-- @time a_up 2` lines; empty when the model has none. */
export function parseTimes(source: string): Map<string, number> {
  return new Map([...source.matchAll(TIME_RE)].map((m) => [m[1]!, Number(m[2])]));
}

export interface Firing {
  actor: string;
  start: number;
  end: number;
}

export interface Timing {
  /** Time between two iterations completing, once the run settles. */
  period: number;
  /** When the first iteration has completed. */
  latency: number;
  /** When iteration n (1-based) has completed, for the first iterations. */
  completed: number[];
  firings: Firing[];
}

/** Iterations simulated; the period is measured over the second half. */
const ITERATIONS = 16;
/** Firings one run may simulate, so a large repetition vector cannot stall typing. */
const MAX_FIRINGS = 20_000;

/** Null without a repetition vector or when the run gets stuck. */
export function selfTimed(
  facts: Analysis,
  times: Map<string, number>,
  iterations = ITERATIONS,
): Timing | null {
  const q = facts.q;
  if (!q) return null;
  // a model with many firings per iteration simulates fewer iterations, never under 2
  const perIteration = [...q.values()].reduce((a, b) => a + b, 0);
  iterations = Math.max(2, Math.min(iterations, Math.floor(MAX_FIRINGS / perIteration)));
  const dur = (a: string) => times.get(a) ?? 1;
  const tokens = facts.channels.map((c) => c.tokens);
  const ins = new Map(
    facts.actors.map((a) => [a, facts.channels.flatMap((c, i) => (c.dst === a ? [i] : []))]),
  );
  const outs = new Map(
    facts.actors.map((a) => [a, facts.channels.flatMap((c, i) => (c.src === a ? [i] : []))]),
  );
  // ponytail: sources stop after `iterations` worth of firings, so the run
  // drains at the end; the period comes from the middle, not the tail
  const left = new Map(facts.actors.map((a) => [a, q.get(a)! * iterations]));
  const done = new Map(facts.actors.map((a) => [a, [] as number[]]));
  const busyUntil = new Map(facts.actors.map((a) => [a, -1]));
  const running: Firing[] = [];
  const firings: Firing[] = [];
  let t = 0;
  for (;;) {
    // finish what ends now, then start everything that can start now
    for (const f of running.filter((f) => f.end === t)) {
      for (const i of outs.get(f.actor)!) tokens[i]! += facts.channels[i]!.prod;
      done.get(f.actor)!.push(f.end);
    }
    for (let i = running.length - 1; i >= 0; i--) if (running[i]!.end === t) running.splice(i, 1);
    for (const a of facts.actors) {
      if (left.get(a)! <= 0 || busyUntil.get(a)! > t) continue;
      if (!ins.get(a)!.every((i) => tokens[i]! >= facts.channels[i]!.cons)) continue;
      for (const i of ins.get(a)!) tokens[i]! -= facts.channels[i]!.cons;
      const f = { actor: a, start: t, end: t + dur(a) };
      running.push(f);
      firings.push(f);
      busyUntil.set(a, f.end);
      left.set(a, left.get(a)! - 1);
    }
    if (!running.length) break;
    t = Math.min(...running.map((f) => f.end));
  }
  if ([...left.values()].some((n) => n > 0)) return null;
  // iteration n completes when every actor has ended its n·q-th firing
  const completedAt = (n: number) =>
    Math.max(...facts.actors.map((a) => done.get(a)![n * q.get(a)! - 1]!));
  const half = Math.floor(iterations / 2);
  return {
    period: (completedAt(iterations) - completedAt(half)) / (iterations - half),
    latency: completedAt(1),
    completed: [1, 2, 3].map(completedAt),
    firings,
  };
}
