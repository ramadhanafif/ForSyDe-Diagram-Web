import type { IRSystem } from '../core/ir';
import { isDelay } from '../core/ir';
import type { ScheduleOk } from '../core/schedule';

/**
 * Token-count simulation of an SDF system. Counts only, never values.
 *
 * Queues are keyed by IR signal name. A delay is an instantaneous 1:1
 * pass-through: tokens produced onto its input signal appear on its output
 * signal in the same step, so a delay's input signal always holds 0 and its
 * output signal starts with the delay's initial tokens (summed along a chain
 * of delays). System inputs and outputs get steps of their own, so the
 * tokens can be seen entering and leaving the system: an input step puts
 * tokens into the buffer behind the input, an output step takes the tokens
 * collected in front of an output.
 */

export type Counts = Record<string, number>;

export interface SignalCount {
  signal: string;
  n: number;
}

export interface SimStep {
  /** An actor firing, a system input producing, or a system output taking tokens. */
  kind: 'actor' | 'input' | 'output';
  /** The actor, or the io node (named after its signal). */
  actor: string;
  consumed: SignalCount[];
  /** Named by the actor's output signal; behind a delay the count changes downstream. */
  produced: SignalCount[];
  /** Tokens taken by a system output, named by the signal that enters the output. */
  drained: SignalCount[];
  after: Counts;
}

export interface SimTrace {
  initial: Counts;
  /** One period of a static schedule, which loops; false for a run that got stuck. */
  periodic: boolean;
  steps: SimStep[];
  /** Per signal, the max over the initial state and every step's `after`. */
  maxOccupancy: Counts;
}

export interface PortShortfall {
  signal: string;
  needed: number;
  available: number;
}

export interface StuckRun {
  initial: Counts;
  steps: SimStep[];
}

export type StuckReport = StuckRun &
  (
    | {
        kind: 'deadlock';
        /** The actors that can never fire again, each with the inputs it is short on. */
        waiting: { actor: string; inputs: PortShortfall[] }[];
      }
    | { kind: 'unbounded'; signals: string[] }
    /** maxFirings reached without deadlock or a growing signal. */
    | { kind: 'running' }
  );

interface InPort {
  signal: string;
  rate: number;
  fromInput: boolean;
}

interface OutPort {
  signal: string;
  rate: number;
  /** Where the tokens land after passing through any delays. */
  land: string;
}

/** A system input (it feeds `signal`, whose tokens land on `land`) or output (fed by `land`). */
interface Io {
  name: string;
  signal: string;
  land: string;
}

interface Net {
  actors: string[];
  ins: Map<string, InPort[]>;
  outs: Map<string, OutPort[]>;
  inputs: Io[];
  outputs: Io[];
  initial: Counts;
}

function buildNet(ir: IRSystem): Net {
  const delays = new Map(ir.processes.filter(isDelay).map((d) => [d.name, d]));
  const bySource = new Map<string, string>();
  const byTarget = new Map<string, string>();
  for (const s of ir.signals) {
    if (!bySource.has(s.source.name)) bySource.set(s.source.name, s.name);
    if (!byTarget.has(s.target.name)) byTarget.set(s.target.name, s.name);
  }
  const sig = new Map(ir.signals.map((s) => [s.name, s]));

  // follow delays downstream to the signal that finally holds the tokens
  const down = (name: string): string => {
    const seen = new Set<string>();
    let cur = name;
    for (;;) {
      seen.add(cur);
      const t = sig.get(cur)!.target.name;
      const next = delays.has(t) ? bySource.get(t) : undefined;
      if (next === undefined || seen.has(next)) return cur;
      cur = next;
    }
  };
  // follow delays upstream to the process or system input that feeds a signal
  const origin = (name: string): string => {
    const seen = new Set<string>();
    let cur = name;
    for (;;) {
      seen.add(cur);
      const src = sig.get(cur)!.source.name;
      const prev = delays.has(src) ? byTarget.get(src) : undefined;
      if (prev === undefined || seen.has(prev)) return src;
      cur = prev;
    }
  };

  const initial: Counts = Object.fromEntries(ir.signals.map((s) => [s.name, 0]));
  for (const d of delays.values()) {
    const out = bySource.get(d.name);
    if (out !== undefined) initial[down(out)]! += d.tokens.length;
  }

  const actors = [...new Set(ir.processes.filter((p) => !isDelay(p)).map((p) => p.name))];
  const ins = new Map(actors.map((a) => [a, [] as InPort[]]));
  const outs = new Map(actors.map((a) => [a, [] as OutPort[]]));
  for (const s of ir.signals) {
    ins.get(s.target.name)?.push({
      signal: s.name,
      rate: s.target.rate,
      fromInput: ir.inputs.includes(origin(s.name)),
    });
    outs.get(s.source.name)?.push({ signal: s.name, rate: s.source.rate, land: down(s.name) });
  }
  const inputs = ir.signals
    .filter((s) => ir.inputs.includes(s.source.name))
    .map((s) => ({ name: s.source.name, signal: s.name, land: down(s.name) }));
  const outputs = ir.signals
    .filter((s) => ir.outputs.includes(s.target.name))
    .map((s) => ({ name: s.target.name, signal: s.name, land: s.name }));
  return { actors, ins, outs, inputs, outputs, initial };
}

const fireable = (net: Net, counts: Counts, actor: string): boolean =>
  net.ins.get(actor)!.every((p) => p.fromInput || counts[p.signal]! >= p.rate);

const blank = (kind: SimStep['kind'], actor: string): SimStep => ({
  kind,
  actor,
  consumed: [],
  produced: [],
  drained: [],
  after: {},
});

function fire(net: Net, counts: Counts, actor: string): SimStep {
  const step = blank('actor', actor);
  for (const p of net.ins.get(actor)!) {
    counts[p.signal]! -= p.rate;
    step.consumed.push({ signal: p.signal, n: p.rate });
  }
  for (const o of net.outs.get(actor)!) {
    counts[o.land]! += o.rate;
    step.produced.push({ signal: o.signal, n: o.rate });
  }
  step.after = { ...counts };
  return step;
}

/** A system input puts n tokens into the buffer behind it. */
function produce(counts: Counts, io: Io, n: number): SimStep {
  const step = blank('input', io.name);
  counts[io.land]! += n;
  step.produced.push({ signal: io.signal, n });
  step.after = { ...counts };
  return step;
}

/** A system output takes n tokens from the buffer in front of it. */
function drain(counts: Counts, io: Io, n: number): SimStep {
  const step = blank('output', io.name);
  counts[io.land]! -= n;
  step.drained.push({ signal: io.land, n });
  step.after = { ...counts };
  return step;
}

/** Output steps taking everything collected in front of each output since `base`. */
const drainAll = (net: Net, counts: Counts, base: Counts): SimStep[] =>
  net.outputs
    .filter((o) => counts[o.land]! > base[o.land]!)
    .map((o) => drain(counts, o, counts[o.land]! - base[o.land]!));

/**
 * Replay one period of a static schedule: every input first produces the
 * tokens its consumers take in the period (the input buffer size the
 * scheduler computes, rate times repetitions), then the actors fire in
 * schedule order, then every output takes what collected in front of it.
 */
export function simulate(ir: IRSystem, schedule: ScheduleOk): SimTrace {
  const net = buildNet(ir);
  const counts = { ...net.initial };
  const need = new Map<string, number>();
  for (const actor of schedule.schedule)
    for (const p of net.ins.get(actor) ?? [])
      if (p.fromInput) need.set(p.signal, (need.get(p.signal) ?? 0) + p.rate);
  const steps = [
    ...net.inputs
      .filter((io) => (need.get(io.land) ?? 0) > 0)
      .map((io) => produce(counts, io, need.get(io.land)!)),
    ...schedule.schedule.map((actor) => fire(net, counts, actor)),
  ];
  steps.push(...drainAll(net, counts, net.initial));
  return traceOf({ initial: net.initial, steps }, true);
}

/** A playable trace of a run: a loop for a period, else the first `cap` steps of a stuck run. */
export function traceOf(run: StuckRun, periodic: boolean, cap = Infinity): SimTrace {
  const steps = run.steps.slice(0, cap);
  const maxOccupancy = { ...run.initial };
  for (const step of steps)
    for (const [s, n] of Object.entries(step.after))
      maxOccupancy[s] = Math.max(maxOccupancy[s]!, n);
  return { initial: run.initial, periodic, steps, maxOccupancy };
}

/**
 * Data-driven execution for systems the scheduler rejects. Rounds sweep the
 * actors in IR order. A round stands for one sample on every system input: an
 * actor fed by a system input (or with no inputs) fires once per round, any
 * other actor fires while it can. Firing every actor at most once per round
 * instead would let a source outrun a 1:2 consumer and flag a consistent
 * system as unbounded; firing input-fed actors while they can never ends.
 *
 * Stops on deadlock (a round fires nothing) or after maxFirings. A deadlock
 * behind a source does not stop the run: the source fires every round and
 * floods the queue in front of the stuck part. So after R complete rounds, an
 * actor that fired in none of the last R/2 and is short on an input is
 * deadlocked too. Otherwise a signal is 'unbounded' when its count at the end
 * of rounds R/4, R/2, 3R/4 and R is strictly increasing: bounded queues settle
 * after a transient, while inconsistent rates grow a queue with every round.
 */
/**
 * Buffer sizes for a deadlocked model, which has no schedule to size them: the
 * most each signal held during the run, and at least what a waiting actor
 * needs, so the tokens it waits beside have a place on the diagram.
 */
export function stuckBufferSizes(
  stuck: Extract<StuckReport, { kind: 'deadlock' }>,
): [string, number][] {
  const most = new Map<string, number>();
  const at = (sig: string, n: number) => most.set(sig, Math.max(most.get(sig) ?? 0, n));
  for (const counts of [stuck.initial, ...stuck.steps.map((s) => s.after)])
    for (const [sig, n] of Object.entries(counts)) at(sig, n);
  for (const w of stuck.waiting) for (const i of w.inputs) at(i.signal, i.needed);
  return [...most].filter(([, n]) => n > 0);
}

export function simulateUntilStuck(ir: IRSystem, maxFirings: number): StuckReport {
  const net = buildNet(ir);
  const counts = { ...net.initial };
  const steps: SimStep[] = [];
  const rounds: Counts[] = [];
  const lastRound = new Map<string, number>();
  const deadlock = (actors: string[]): StuckReport | null => {
    const waiting = actors
      .map((actor) => ({
        actor,
        inputs: net.ins
          .get(actor)!
          .filter((p) => !p.fromInput && counts[p.signal]! < p.rate)
          .map((p) => ({ signal: p.signal, needed: p.rate, available: counts[p.signal]! })),
      }))
      .filter((w) => w.inputs.length > 0);
    return waiting.length ? { kind: 'deadlock', initial: net.initial, steps, waiting } : null;
  };
  const run = { initial: net.initial, steps };
  while (steps.length < maxFirings) {
    let fired = false;
    for (const a of net.actors) {
      const ins = net.ins.get(a)!;
      // ponytail: one firing per round per input-fed actor ignores repetitions, so
      // two inputs whose consumers need different rates can report growth that a
      // rate-aware input clock would not; derive per-input rates if that shows up
      const once = ins.length === 0 || ins.some((p) => p.fromInput);
      while (steps.length < maxFirings && fireable(net, counts, a)) {
        // the input delivers exactly what this firing takes, as its own step
        for (const p of ins)
          if (p.fromInput) {
            const io = net.inputs.find((i) => i.land === p.signal);
            if (io) steps.push(produce(counts, io, p.rate));
          }
        steps.push(fire(net, counts, a));
        fired = true;
        lastRound.set(a, rounds.length);
        if (once) break;
      }
    }
    // no actor fired, so each one is short somewhere (null: there are no actors)
    if (!fired) {
      const stuck = deadlock(net.actors);
      // the inputs still deliver what a waiting actor reads, so the run shows
      // their tokens arriving and waiting beside the buffer that stays empty
      if (stuck)
        for (const a of net.actors)
          for (const p of net.ins.get(a)!) {
            const io = p.fromInput && net.inputs.find((i) => i.land === p.signal);
            if (io && counts[p.signal]! < p.rate)
              steps.push(produce(counts, io, p.rate - counts[p.signal]!));
          }
      return stuck ?? { kind: 'running', ...run };
    }
    steps.push(...drainAll(net, counts, net.initial));
    if (steps.length < maxFirings) rounds.push({ ...counts });
  }
  const r = rounds.length;
  if (r >= 4) {
    // ponytail: a live actor that fires less than once per R/2 rounds (a 1:k
    // consumer with k near R/2, about 500 at 1000 firings) reads as deadlocked;
    // raise maxFirings if such rates show up
    const starved = deadlock(net.actors.filter((a) => (lastRound.get(a) ?? -1) < r / 2));
    if (starved) return starved;
    const marks = [r / 4, r / 2, (3 * r) / 4, r].map((i) => rounds[Math.ceil(i) - 1]!);
    const signals = Object.keys(counts).filter((s) =>
      marks.every((m, i) => i === 0 || m[s]! > marks[i - 1]![s]!),
    );
    if (signals.length > 0) return { kind: 'unbounded', ...run, signals };
  }
  return { kind: 'running', ...run };
}
