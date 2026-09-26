import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SceneMarks } from '../render/SceneShapes';
import { edgeId } from '../scene/labels';
import {
  simulate,
  simulateUntilStuck,
  traceOf,
  type SimTrace,
  type StuckReport,
} from '../sim/simulate';
import type { SceneModel } from './useScene';

/** Step interval at 1x. */
const STEP_MS = 800;
/** Token travel takes this share of a step, so it ends before the next one fires. */
const TRAVEL_SHARE = 0.7;

const travelMs = (speed: Speed) => (TRAVEL_SHARE * STEP_MS) / speed;
/** Firings simulateUntilStuck may spend looking for a deadlock or a growing queue. */
const STUCK_FIRINGS = 1000;
/** Steps of a stuck run the timeline replays: enough to see it stall or a queue grow. */
const STUCK_STEPS = 60;

export const SPEEDS = [0.5, 1, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export interface Simulation {
  /**
   * What playback shows: one period of the static schedule (it loops), else
   * the start of a stuck run (it ends where the model gets stuck); null when
   * there is neither.
   */
  trace: SimTrace | null;
  /** Why the scheduler failed, as observed by running the model; null when it did not fail. */
  stuck: StuckReport | null;
  /** 0 is the initial state; k is the state after firing k - 1 of the period. */
  pos: number;
  /** Set when `pos` was reached by one step forward (play or step): the firing to animate. */
  stepSeq: number | null;
  /** Token travel time of that step, fixed when it fired: a speed change does not restart it. */
  stepMs: number;
  playing: boolean;
  speed: Speed;
  toggle(): void;
  /** Start playing (from the start again when a stuck run already ended). */
  play(): void;
  stop(): void;
  step(delta: 1 | -1): void;
  reset(): void;
  seek(pos: number): void;
  setSpeed(s: Speed): void;
}

/**
 * Position after one step from `p` over a trace of `n` steps. A period wraps
 * around in both directions (past the initial state, which equals the state
 * after the last firing); a run that does not loop stops at its ends.
 */
export function stepPos(p: number, delta: 1 | -1, n: number, loops: boolean): number {
  if (delta === 1) return p >= n ? (loops ? 1 : n) : p + 1;
  return p <= 0 ? (loops ? n - 1 : 0) : p - 1;
}

/**
 * Playback over one schedule period. The position is kept per source text, so
 * an edit starts again from the initial state without an effect, while a
 * re-layout of the same text (SHOW toggles, style) keeps it. The timer runs
 * only while `active` (its controls are on screen).
 */
export function useSimulation(model: SceneModel | null, active: boolean): Simulation {
  const period = useMemo(
    () => (model?.schedule.ok ? simulate(model.ir, model.schedule) : null),
    [model],
  );
  const stuck = useMemo(() => {
    const s = model?.schedule;
    if (!model || !s || s.ok) return null;
    if (s.kind === 'deadlock' || s.kind === 'no-positive-vector' || s.kind === 'rank')
      return simulateUntilStuck(model.ir, STUCK_FIRINGS);
    return null;
  }, [model]);
  // no period: replay how the model fails, up to where it gets stuck
  const trace = useMemo(
    () => period ?? (stuck ? traceOf(stuck, false, STUCK_STEPS) : null),
    [period, stuck],
  );

  const key = trace && model ? model.source : null;
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  // seq counts moves, so stepping onto the same position again still animates
  const [at, setAt] = useState({ key: null as string | null, pos: 0, seq: 0, fwd: false, ms: 0 });
  const pos = at.key === key ? at.pos : 0;
  const n = trace?.steps.length ?? 0;
  const loops = trace?.periodic ?? false;
  const running = playing && active && n > 0;

  // the period loops: the state after the last firing equals the initial one
  const move = useCallback(
    (f: (p: number) => number, fwd = false) =>
      setAt((a) => ({
        key,
        pos: n ? f(a.key === key ? a.pos : 0) : 0,
        seq: a.seq + 1,
        fwd,
        ms: travelMs(speed),
      })),
    [key, n, speed],
  );
  const step = useCallback(
    (delta: 1 | -1) => move((p) => stepPos(p, delta, n, loops), delta === 1),
    [move, n, loops],
  );
  const atEnd = !loops && pos >= n;

  useEffect(() => {
    if (!running) return;
    // one timeout per position; a stuck run stops playing at its last step
    const t = setTimeout(() => (atEnd ? setPlaying(false) : step(1)), STEP_MS / speed);
    return () => clearTimeout(t);
  }, [running, speed, step, atEnd, at.seq]);

  const stepSeq = at.key === key && at.fwd && pos > 0 ? at.seq : null;
  // one object per state change, so memo'd consumers skip renders that change nothing
  return useMemo(
    () => ({
      trace,
      stuck,
      pos,
      stepSeq,
      stepMs: at.ms,
      playing: running,
      speed,
      toggle: () => {
        // playing a finished stuck run starts it over
        if (!playing && atEnd) move(() => 0);
        setPlaying((v) => !v);
      },
      play: () => {
        if (atEnd) move(() => 0);
        setPlaying(true);
      },
      stop: () => setPlaying(false),
      step: (d: 1 | -1) => {
        setPlaying(false);
        step(d);
      },
      reset: () => {
        setPlaying(false);
        move(() => 0);
      },
      seek: (p: number) => move(() => Math.max(0, Math.min(n, p))),
      setSpeed,
    }),
    [trace, stuck, pos, stepSeq, at.ms, running, speed, playing, atEnd, move, step, n],
  );
}

/** Strip fill per edge for this playback position; used as the fill before an animated step. */
export const fillAt = (model: SceneModel, trace: SimTrace, pos: number) =>
  simMarks(model, { trace, stuck: null, pos }).fill;

const add = (m: Map<string, string>, id: string, cls: string) =>
  m.set(id, m.has(id) ? `${m.get(id)} ${cls}` : cls);

/** What the diagram shows for the playback position or the failure: classes, strip fills, hover notes. */
export function simMarks(
  model: SceneModel,
  { trace, stuck, pos }: Pick<Simulation, 'trace' | 'stuck' | 'pos'>,
): SceneMarks {
  const marks: SceneMarks = {
    nodes: new Map(),
    edges: new Map(),
    fill: new Map(),
    notes: new Map(),
    step: pos,
  };
  const edgeOf = new Map(model.ir.signals.map((s) => [s.name, edgeId(s)]));
  if (trace) {
    const cur = pos > 0 ? trace.steps[pos - 1] : undefined;
    const counts = cur?.after ?? trace.initial;
    // a strip fills from the buffer its capacity comes from: a delay folds its
    // input and output signals into one buffer, whose tokens sit on the output
    const aliases = model.schedule.ok ? model.schedule.aliases : new Map<string, string>();
    const buf = (sig: string) => aliases.get(sig) ?? sig;
    const held = new Map<string, number>();
    for (const [sig, k] of Object.entries(counts))
      held.set(buf(sig), (held.get(buf(sig)) ?? 0) + k);
    for (const [sig, e] of edgeOf) marks.fill.set(e, held.get(buf(sig)) ?? 0);
    if (cur) {
      add(marks.nodes, cur.actor, 'firing');
      for (const c of [...cur.consumed, ...cur.drained]) {
        const e = edgeOf.get(c.signal);
        if (e) add(marks.edges, e, 'consumed');
      }
      for (const c of cur.produced) {
        const e = edgeOf.get(c.signal);
        if (e) add(marks.edges, e, 'produced');
      }
    }
  }
  if (stuck?.kind === 'deadlock') {
    for (const w of stuck.waiting) {
      add(marks.nodes, w.actor, 'waiting');
      marks.notes.set(
        w.actor,
        w.inputs.map((i) => `${i.signal}: needs ${i.needed}, has ${i.available}`),
      );
      for (const i of w.inputs) {
        const e = edgeOf.get(i.signal);
        if (!e) continue;
        add(marks.edges, e, 'short');
        marks.notes.set(e, [`${w.actor} needs ${i.needed} on ${i.signal}, has ${i.available}`]);
      }
    }
  } else if (stuck?.kind === 'unbounded') {
    for (const s of stuck.signals) {
      const e = edgeOf.get(s);
      if (!e) continue;
      add(marks.edges, e, 'unbounded');
      marks.notes.set(e, [`tokens accumulate on ${s} every period`]);
    }
  }
  return marks;
}
