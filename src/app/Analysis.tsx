import {
  balanceEquation,
  loopedSchedule,
  type Analysis as Facts,
  type Channel,
} from '../core/analysis';
import type { Target } from '../core/links';
import type { ScheduleOk } from '../core/schedule';

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
  onJump,
}: {
  facts: Facts;
  sched: ScheduleOk | null;
  onJump?(t: Target): void;
}) {
  const { actors, channels, gamma, rank, q, conflict } = facts;
  const bad = new Set(conflict ? [...conflict.pathA, ...conflict.pathB] : []);
  const sig = (c: Channel) => (
    <button className="an-sig" onClick={() => onJump?.({ kind: 'edge', signal: c.signal })}>
      {rowName(c)}
    </button>
  );
  const want = actors.length - 1;
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
            rank Γ = {rank}, actors − 1 = {want} {rank === want ? '✓ consistent' : '✗ inconsistent'}
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
      {sched && (
        <section>
          <h4>buffers for this schedule</h4>
          <p className="an-note">
            the first ready actor fires, in declaration order; another valid schedule can need less
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
