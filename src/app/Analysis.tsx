import {
  balanceEquation,
  loopedSchedule,
  type Analysis as Facts,
  type Channel,
} from '../core/analysis';
import type { Target } from '../core/links';
import type { ScheduleOk } from '../core/schedule';
import { selfTimed, type Timing } from '../sim/timed';

/** The other signals folded into buffer `name` (a delay's output signal). */
const aliasesOf = (sched: ScheduleOk, name: string) => [
  ...new Set([...sched.aliases].filter(([a, b]) => b === name && a !== name).map(([a]) => a)),
];

const rowName = (c: Channel) =>
  c.delay ? `${c.signal} (${c.delay}, ${c.tokens} token${c.tokens === 1 ? '' : 's'})` : c.signal;

/**
 * SDF in textbook notation: the topology matrix Γ, the rank test, the balance
 * equations, the repetition vector q, the schedule with repetition counts and
 * the buffer sizes. Rows of a rate conflict are marked. Signal names jump to
 * their text.
 */
export function Analysis({
  facts,
  sched,
  times,
  onJump,
}: {
  facts: Facts;
  sched: ScheduleOk | null;
  /** Execution times from `-- @time` lines; timing is shown only when there are some. */
  times: Map<string, number>;
  onJump?(t: Target): void;
}) {
  const timing = times.size ? selfTimed(facts, times) : null;
  const { actors, channels, gamma, rank, q, conflict, parts } = facts;
  const bad = new Set(conflict ? [...conflict.pathA, ...conflict.pathB] : []);
  const sig = (c: Channel) => (
    <button className="an-sig" onClick={() => onJump?.({ kind: 'edge', signal: c.signal })}>
      {rowName(c)}
    </button>
  );
  // a connected graph needs rank actors − 1; each unconnected part takes one more
  const want = actors.length - parts;
  return (
    <div className="analysis">
      {channels.length > 0 && (
        <section>
          <h4>topology matrix Γ</h4>
          <table className="an-gamma">
            <thead>
              <tr>
                <th />
                {actors.map((a) => (
                  <th key={a}>{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {channels.map((c, i) => (
                <tr key={c.signal} className={bad.has(c) ? 'an-bad' : ''}>
                  <th>{sig(c)}</th>
                  {gamma[i]!.map((v, j) => (
                    <td key={j} className={v === 0 ? 'an-zero' : ''}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className={rank === want ? 'an-ok' : 'an-fail'}>
            rank Γ = {rank}, {parts === 1 ? 'actors − 1' : `actors − ${parts} parts`} = {want}{' '}
            {rank === want ? '✓ consistent' : '✗ inconsistent'}
          </p>
        </section>
      )}
      {channels.length > 0 && (
        <section>
          <h4>balance equations</h4>
          <ul className="an-eqs">
            {channels.map((c) => (
              <li key={c.signal} className={bad.has(c) ? 'an-bad' : ''}>
                {sig(c)} <code>{balanceEquation(c, q)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4>repetition vector</h4>
        <p>
          <code>
            {q
              ? `q = (${actors.map((a) => `${a}: ${q.get(a)}`).join(', ')})`
              : 'no q: the balance equations have no positive solution'}
          </code>
        </p>
        {sched && (
          <>
            <h4>schedule</h4>
            <p>
              <code className="an-schedule">{loopedSchedule(sched.schedule)}</code>
            </p>
          </>
        )}
      </section>
      {timing ? (
        <Gantt timing={timing} actors={facts.actors} />
      ) : (
        sched && (
          <p className="an-note">
            timing: add lines like <code>-- @time {facts.actors[0]} 2</code> to give actors
            execution times, and see the period and a Gantt chart
          </p>
        )
      )}
      {sched && (
        <section>
          <h4>buffers for this schedule</h4>
          <p className="an-note">
            round robin: after a firing, the next ready actor in declaration order fires; another
            valid schedule can need less. Inputs: one iteration read up front.
          </p>
          <table className="an-buffers">
            <tbody>
              {sched.buffers.map(([name, size]) => (
                <tr key={name}>
                  {/* a delay's two signals share one buffer: name both, as the timeline does */}
                  <td>{[name, ...aliasesOf(sched, name)].join(' / ')}</td>
                  <td>{size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const GANTT_W = 360;
const ROW_H = 14;
const NAME_W = 70;

/** Self-timed firings over the first three iterations, one row per actor. */
function Gantt({ timing, actors }: { timing: Timing; actors: string[] }) {
  const { period, latency, completed, firings } = timing;
  const until = completed[2]!;
  const x = (t: number) => NAME_W + (t / until) * (GANTT_W - NAME_W);
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  return (
    <section>
      <h4>timing (self-timed, unbounded buffers: sources run ahead)</h4>
      <p>
        period <code>{fmt(period)}</code>: one iteration every {fmt(period)} time units; the first
        completes at <code>{fmt(latency)}</code>
      </p>
      <svg
        className="an-gantt"
        width={GANTT_W}
        height={actors.length * ROW_H + 4}
        role="img"
        aria-label={`firings over the first three iterations, period ${fmt(period)}`}
      >
        {actors.map((a, r) => (
          <text key={a} x={0} y={r * ROW_H + 11}>
            {a}
          </text>
        ))}
        {completed.map((t, i) => (
          <line key={i} className="an-iter" x1={x(t)} x2={x(t)} y1={0} y2={actors.length * ROW_H} />
        ))}
        {firings
          .filter((f) => f.start < until)
          .map((f, i) => (
            <rect
              key={i}
              x={x(f.start)}
              y={actors.indexOf(f.actor) * ROW_H + 2}
              width={Math.max(1, x(Math.min(f.end, until)) - x(f.start) - 1)}
              height={ROW_H - 4}
              rx={2}
            >
              <title>{`${f.actor}: ${fmt(f.start)} to ${fmt(f.end)}`}</title>
            </rect>
          ))}
      </svg>
    </section>
  );
}
