import { useState } from 'react';
import type { ScheduleOk } from '../core/schedule';
import type { SimStep, SimTrace } from '../sim/simulate';
import { SPEEDS, type Simulation } from './useSimulation';

/** Width of one firing cell; the sparklines share the scale. */
const CELL_W = 44;
const SPARK_H = 20;

/** Tokens on each signal that ever holds one: the initial count, then after every firing. */
function occupancy(trace: SimTrace): [string, number[], number][] {
  return Object.entries(trace.maxOccupancy)
    .filter(([, max]) => max > 0)
    .map(([sig, max]) => [
      sig,
      [trace.initial[sig] ?? 0, ...trace.steps.map((s) => s.after[sig] ?? 0)],
      max,
    ]);
}

/** How a step reads: an actor firing, or tokens entering or leaving the system. */
function stepText(s: SimStep): string {
  if (s.kind === 'input') return `${s.actor} produces ${s.produced[0]?.n ?? 0}`;
  if (s.kind === 'output') return `${s.actor} takes ${s.drained[0]?.n ?? 0}`;
  return s.actor;
}

/** Value i (after firing i) sits mid-cell under that firing; the initial value at x = 0. */
const xAt = (i: number) => (i === 0 ? 0 : (i - 0.5) * CELL_W);

function Sparkline({ values, max, pos }: { values: number[]; max: number; pos: number }) {
  const y = (v: number) => SPARK_H - 3 - (v / max) * (SPARK_H - 6);
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
      <polyline points={values.map((v, i) => `${xAt(i)},${y(v)}`).join(' ')} />
      {values.map((v, i) =>
        v === max ? <circle key={i} className="tl-max" cx={xAt(i)} cy={y(v)} r={2.5} /> : null,
      )}
    </svg>
  );
}

function Tables({ sched }: { sched: ScheduleOk }) {
  return (
    <div className="schedule-tables">
      <table>
        <thead>
          <tr>
            <th>actor</th>
            <th>reps</th>
          </tr>
        </thead>
        <tbody>
          {[...sched.repetitions].map(([name, q]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{q}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th>signal</th>
            <th>buffer</th>
          </tr>
        </thead>
        <tbody>
          {sched.buffers.map(([name, size]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{size}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The schedule as a playable timeline: one cell per step of one period (the
 * inputs producing, the actor firings, the outputs taking), the current one
 * highlighted, and under them each signal's token count over the period with
 * its maximum (the buffer size it needs) marked. Without a schedule it replays
 * how the model gets stuck. Collapsed, it is a one-line summary chip.
 */
export function Timeline({
  sched,
  sim,
  open,
  onToggle,
}: {
  sched: ScheduleOk | null;
  sim: Simulation;
  open: boolean;
  onToggle(): void;
}) {
  const [tables, setTables] = useState(false);
  const { trace, pos } = sim;
  const n = trace?.steps.length ?? 0;
  if (!open) {
    const maxBuffer = Math.max(0, ...(sched?.buffers.map(([, size]) => size) ?? []));
    return (
      <button className="schedule-chip" title="Show the schedule timeline" onClick={onToggle}>
        {sched
          ? `schedule: ${sched.schedule.length} firings, max buffer ${maxBuffer}`
          : `stuck run: ${n} steps`}
      </button>
    );
  }
  return (
    <div className="timeline">
      <div className="tl-bar">
        <button aria-label="reset" title="Back to the initial state" onClick={sim.reset}>
          ⏮
        </button>
        <button aria-label="step back" title="Undo the last firing" onClick={() => sim.step(-1)}>
          ◀
        </button>
        <button
          aria-label={sim.playing ? 'pause' : 'play'}
          className="tl-play"
          title="Play the period; it loops"
          onClick={sim.toggle}
        >
          {sim.playing ? '❚❚' : '▶'}
        </button>
        <button aria-label="step forward" title="Fire the next actor" onClick={() => sim.step(1)}>
          ▶|
        </button>
        <span className="tl-speed" role="group" aria-label="playback speed" title="Playback speed">
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
        <span className="tl-pos">
          {pos === 0
            ? trace && !trace.periodic && n === 0
              ? 'stuck from the start: no actor can fire'
              : 'initial state'
            : `step ${pos}/${n}: ${stepText(trace!.steps[pos - 1]!)}${
                !trace!.periodic && pos === n ? ' (stuck from here)' : ''
              }`}
        </span>
        <span className="tl-spacer" />
        {sched && (
          <button
            className={tables ? 'active' : ''}
            aria-pressed={tables}
            title="Repetitions and buffer sizes"
            onClick={() => setTables((v) => !v)}
          >
            tables
          </button>
        )}
        <button aria-label="collapse" title="Collapse to a summary" onClick={onToggle}>
          ×
        </button>
      </div>
      {trace && (
        <div className="tl-scroll">
          <div className="tl-row">
            <span className="tl-name">{trace.periodic ? 'period' : 'stuck run'}</span>
            <span className="tl-cells">
              {trace.steps.map((s, i) => (
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
              ))}
            </span>
          </div>
          {occupancy(trace).map(([sig, values, max]) => (
            <div key={sig} className="tl-row" data-signal={sig}>
              <span className="tl-name" title={`${sig} holds at most ${max} tokens in one period`}>
                {sig} <b>{max}</b>
              </span>
              <Sparkline values={values} max={max} pos={pos} />
            </div>
          ))}
        </div>
      )}
      {tables && sched && <Tables sched={sched} />}
    </div>
  );
}
