import { Pause, Play, SkipBack, StepBack, StepForward, X } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { Analysis as Facts } from '../core/analysis';
import type { Target } from '../core/links';
import type { ScheduleOk } from '../core/schedule';
import { Analysis } from './Analysis';
import type { SimStep, SimTrace } from '../sim/simulate';
import { SPEEDS, type Simulation } from './useSimulation';

/** Width of one firing cell; the sparklines share the scale. */
const CELL_W = 44;
const SPARK_H = 20;
/** Cells rendered either side of the scrolled-to cell; the rest is padding. */
const CELL_RADIUS = 200;
/** The window moves in steps this many cells wide, so scrolling rarely re-renders. */
const SCROLL_STEP = 50;
/** Points per sparkline at most; longer series keep each bucket's minimum and maximum. */
const SPARK_POINTS = 2000;

/** The cells [from, to) to render out of `n`, `radius` either side of `center`. */
export function cellWindow(n: number, center: number, radius: number) {
  return { from: Math.max(0, center - radius), to: Math.min(n, center + radius) };
}

/** [index, value] pairs, at most about `max`: each bucket's minimum and maximum, in order. */
export function downsample(values: number[], max: number): [number, number][] {
  if (values.length <= max) return values.map((v, i) => [i, v]);
  const size = Math.ceil(values.length / Math.floor(max / 2));
  const out: [number, number][] = [];
  for (let start = 0; start < values.length; start += size) {
    let lo = start;
    let hi = start;
    for (let i = start; i < Math.min(values.length, start + size); i++) {
      if (values[i]! < values[lo]!) lo = i;
      if (values[i]! > values[hi]!) hi = i;
    }
    const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
    out.push([a, values[a]!]);
    if (a !== b) out.push([b, values[b]!]);
  }
  return out;
}

interface Series {
  sig: string;
  values: number[];
  max: number;
  /** The polyline's points attribute, downsampled. */
  points: string;
}

/** Tokens on each signal that ever holds one: the initial count, then after every firing. */
function occupancy(trace: SimTrace): Series[] {
  return Object.entries(trace.maxOccupancy)
    .filter(([, max]) => max > 0)
    .map(([sig, max]) => {
      const values = [trace.initial[sig] ?? 0, ...trace.steps.map((s) => s.after[sig] ?? 0)];
      const points = downsample(values, SPARK_POINTS)
        .map(([i, v]) => `${xAt(i)},${sparkY(v, max)}`)
        .join(' ');
      return { sig, values, max, points };
    });
}

/** How a step reads: an actor firing, or tokens entering or leaving the system. */
function stepText(s: SimStep): string {
  if (s.kind === 'input') return `${s.actor} produces ${s.produced[0]?.n ?? 0}`;
  if (s.kind === 'output') return `${s.actor} takes ${s.drained[0]?.n ?? 0}`;
  return s.actor;
}

/** Value i (after firing i) sits mid-cell under that firing; the initial value at x = 0. */
const xAt = (i: number) => (i === 0 ? 0 : (i - 0.5) * CELL_W);
const sparkY = (v: number, max: number) => SPARK_H - 3 - (v / max) * (SPARK_H - 6);

function Sparkline({
  series: { values, max, points },
  pos,
  from,
  to,
}: {
  series: Series;
  pos: number;
  /** The rendered cells; the maximum is marked only under them. */
  from: number;
  to: number;
}) {
  const w = (values.length - 1) * CELL_W;
  return (
    <svg
      className="tl-spark"
      aria-hidden="true"
      width={w}
      height={SPARK_H}
      viewBox={`0 0 ${w} ${SPARK_H}`}
    >
      <line className="tl-cursor" x1={xAt(pos)} x2={xAt(pos)} y1={0} y2={SPARK_H} />
      <polyline points={points} />
      {values
        .slice(from, to + 1)
        .map((v, k) =>
          v === max ? (
            <circle
              key={from + k}
              className="tl-max"
              cx={xAt(from + k)}
              cy={sparkY(v, max)}
              r={2.5}
            />
          ) : null,
        )}
    </svg>
  );
}

/**
 * The schedule as a playable timeline: one cell per step of one period (the
 * inputs producing, the actor firings, the outputs taking), the current one
 * highlighted, and under them each signal's token count over the period with
 * its maximum (the buffer size it needs) marked. Without a schedule it replays
 * how the model gets stuck, and with nothing to play it holds only the
 * analysis. Collapsed, it is a one-line summary chip.
 */
export const Timeline = memo(function Timeline({
  sched,
  facts,
  sim,
  open,
  onToggle,
  onJump,
  times,
}: {
  sched: ScheduleOk | null;
  facts: Facts | null;
  sim: Simulation;
  open: boolean;
  onToggle(): void;
  onJump?(t: Target): void;
  times: Map<string, number>;
}) {
  const [tablesOn, setTables] = useState(false);
  // nothing to play: the analysis is all there is to show
  const tables = tablesOn || !sim.trace;
  const { trace, pos } = sim;
  const n = trace?.steps.length ?? 0;
  // an inconsistent model does not get stuck: its buffers grow without bound
  const unbounded = sim.stuck?.kind === 'unbounded';
  const series = useMemo(() => (trace ? occupancy(trace) : []), [trace]);
  // only the cells near the scrolled-to one are in the DOM
  const [scrolled, setScrolled] = useState(0);
  // collapsing drops the scroller, which comes back scrolled to the start
  if (!open && scrolled !== 0) setScrolled(0);
  const { from, to } = cellWindow(n, scrolled, CELL_RADIUS);
  if (!open) {
    const maxBuffer = Math.max(0, ...(sched?.buffers.map(([, size]) => size) ?? []));
    return (
      <button className="schedule-chip" title="Show the schedule timeline" onClick={onToggle}>
        {sched
          ? `iteration: ${n} steps, max buffer ${maxBuffer}`
          : trace
            ? `${unbounded ? 'unbounded' : 'stuck'} run: ${n} steps`
            : 'analysis'}
      </button>
    );
  }
  return (
    <div className="timeline">
      <div className="tl-bar">
        {trace && (
          <>
            <button aria-label="reset" title="Back to the initial state" onClick={sim.reset}>
              <SkipBack size={14} />
            </button>
            <button
              aria-label="step back"
              title="Undo the last firing"
              onClick={() => sim.step(-1)}
            >
              <StepBack size={14} />
            </button>
            <button
              aria-label={sim.playing ? 'pause' : 'play'}
              className="tl-play"
              title="Play one iteration; it loops"
              onClick={sim.toggle}
            >
              {sim.playing ? (
                <Pause size={14} fill="currentColor" />
              ) : (
                <Play size={14} fill="currentColor" />
              )}
            </button>
            <button
              aria-label="step forward"
              title="Fire the next actor"
              onClick={() => sim.step(1)}
            >
              <StepForward size={14} />
            </button>
            <span
              className="tl-speed"
              role="group"
              aria-label="playback speed"
              title="Playback speed"
            >
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={sim.speed === s ? 'active' : ''}
                  aria-pressed={sim.speed === s}
                  onClick={() => sim.setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </span>
          </>
        )}
        <span className="tl-pos">
          {!trace
            ? 'nothing to play: no schedule and no run to replay'
            : pos === 0
              ? !trace.periodic && n === 0
                ? 'stuck from the start: no actor can fire'
                : 'initial state'
              : `step ${pos}/${n}: ${stepText(trace!.steps[pos - 1]!)}${
                  !trace!.periodic && !unbounded && pos === n ? ' (stuck from here)' : ''
                }`}
        </span>
        <span className="tl-spacer" />
        {facts && trace && (
          <button
            className={tables ? 'active' : ''}
            aria-pressed={tables}
            title="Topology matrix, balance equations, repetition vector, schedule and buffers"
            onClick={() => setTables((v) => !v)}
          >
            analysis
          </button>
        )}
        <button aria-label="collapse" title="Collapse to a summary" onClick={onToggle}>
          <X size={14} />
        </button>
      </div>
      {trace && (
        <div
          className="tl-scroll"
          onScroll={(e) => {
            const cell = e.currentTarget.scrollLeft / CELL_W;
            setScrolled(Math.round(cell / SCROLL_STEP) * SCROLL_STEP);
          }}
        >
          <div className="tl-row">
            <span className="tl-name">
              {trace.periodic ? 'iteration' : unbounded ? 'unbounded run' : 'stuck run'}
            </span>
            <span
              className="tl-cells"
              style={{ paddingLeft: from * CELL_W, paddingRight: (n - to) * CELL_W }}
            >
              {trace.steps.slice(from, to).map((s, k) => {
                const i = from + k;
                return (
                  <button
                    key={i}
                    className={`tl-cell${s.kind === 'actor' ? '' : ` ${s.kind}`}${i === pos - 1 ? ' current' : ''}`}
                    aria-current={i === pos - 1 ? 'step' : undefined}
                    style={{ width: CELL_W }}
                    title={`step ${i + 1}: ${stepText(s)}`}
                    onClick={() => sim.seek(i + 1)}
                  >
                    {s.kind === 'input'
                      ? `${s.actor} ↦`
                      : s.kind === 'output'
                        ? `↦ ${s.actor}`
                        : s.actor}
                  </button>
                );
              })}
            </span>
          </div>
          {series.map((sr) => (
            <div key={sr.sig} className="tl-row" data-signal={sr.sig}>
              <span
                className="tl-name"
                title={`${sr.sig} holds at most ${sr.max} tokens in one iteration of this schedule`}
              >
                {sr.sig} <b>{sr.max}</b>
              </span>
              <Sparkline series={sr} pos={pos} from={from} to={to} />
            </div>
          ))}
        </div>
      )}
      {tables && facts && <Analysis facts={facts} sched={sched} times={times} onJump={onJump} />}
    </div>
  );
});
