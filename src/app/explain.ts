import type { Analysis, Channel } from '../core/analysis';
import type { Span } from '../core/ast';
import { applySplices, insertOnEdge, setTokens, type Splice } from '../core/edits';
import { elaborate } from '../core/elaborate';
import { isDelay, type IRSystem } from '../core/ir';
import { parse } from '../core/parser';
import { computeScheduleAndBuffers, type ScheduleResult } from '../core/schedule';
import type { StuckReport } from '../sim/simulate';

/** Why a model has no schedule, in its own names and numbers, with a checked fix when one exists. */
export interface Explanation {
  /** The one verdict: what the editor warning, the banner and the toasts say. */
  message: string;
  /** Per-channel detail under the verdict. */
  lines: string[];
  /** Where the editor warning goes. */
  span: Span;
  fix: { label: string; splices: Splice[] } | null;
}

/** Initial tokens a fix may add to one channel. */
const MAX_FIX_TOKENS = 4;

const times = ([n, d]: [number, number]) => (n === d ? '' : d === 1 ? `${n}·` : `${n}/${d}·`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sigName = (c: Channel) => (c.delay ? `${c.signal} (through ${c.delay})` : c.signal);
const rateLine = (c: Channel) =>
  `${c.src} writes ${plural(c.prod, 'token')} to ${sigName(c)} per firing, ${c.dst} reads ${c.cons}`;

function nameSpan(ir: IRSystem, name: string | undefined): Span {
  return (name && ir.spans.processes.get(name)?.name) || ir.spans.anchors.systemParams;
}

const schedules = (source: string) => {
  const { ir } = elaborate(parse(source).module);
  return !!ir && computeScheduleAndBuffers(ir).ok;
};

/**
 * The fewest initial tokens that make the model schedulable, placed on one of
 * the channels an actor is stuck on: more tokens in the delay already there,
 * else a new delay. Each candidate is checked by scheduling the edited text.
 */
function tokenFix(source: string, ir: IRSystem, stuck: StuckReport): Explanation['fix'] {
  const short = stuck.kind === 'deadlock' ? stuck.waiting.flatMap((w) => w.inputs) : [];
  const sigs = short.flatMap((s) => ir.signals.filter((x) => x.name === s.signal));
  for (let k = 1; k <= MAX_FIX_TOKENS; k++) {
    for (const sig of sigs) {
      const from = ir.processes.find((p) => p.name === sig.source.name);
      let fix: Explanation['fix'] = null;
      if (from && isDelay(from)) {
        const tokens = [...from.tokens, ...Array<number>(k).fill(0)];
        const splices = setTokens(ir, from.name, tokens);
        if (splices)
          fix = { label: `Give ${from.name} ${plural(tokens.length, 'initial token')}`, splices };
      } else {
        const r = insertOnEdge(source, ir, sig, 'delay');
        const zeros = Array<number>(k).fill(0).join(', ');
        const splices = r.splices.map((s) => ({
          ...s,
          insert: s.insert.replace('delaySDF [0]', `delaySDF [${zeros}]`),
        }));
        fix = {
          label: `Insert a delay with ${plural(k, 'initial token')} on ${sig.name}`,
          splices,
        };
      }
      if (fix && schedules(applySplices(source, fix.splices))) return fix;
    }
  }
  return null;
}

export function explain(
  source: string,
  ir: IRSystem,
  sched: Extract<ScheduleResult, { ok: false }>,
  facts: Analysis | null,
  stuck: StuckReport | null,
  parts: number,
): Explanation {
  if (sched.kind === 'rank' && parts > 1)
    return {
      message: `the graph has ${parts} disconnected parts; every process must be connected to the rest of the system before a schedule exists`,
      lines: [],
      span: ir.spans.anchors.systemParams,
      fix: null,
    };

  const c = facts?.conflict;
  if (c) {
    const via = (p: Channel[]) => p.map(sigName).join(', ');
    const message =
      c.from === c.to
        ? `inconsistent rates: around the loop ${via(c.pathB)}, q(${c.to}) = ${times(c.ratioB)}q(${c.to}), which no number of firings satisfies. Change one of the rates on the loop.`
        : `inconsistent rates: via ${via(c.pathA)}, q(${c.to}) = ${times(c.ratioA)}q(${c.from}), but via ${via(c.pathB)}, q(${c.to}) = ${times(c.ratioB)}q(${c.from}). Change one of the rates on these paths.`;
    return {
      message,
      lines: [...c.pathA, ...c.pathB].map(rateLine),
      span: nameSpan(ir, c.to),
      fix: null,
    };
  }

  if (stuck?.kind === 'deadlock' && (sched.kind === 'deadlock' || sched.kind === 'rank')) {
    const who = stuck.waiting.map((w) => w.actor);
    const delays = new Set(ir.processes.filter(isDelay).map((p) => p.name));
    const onLoop = stuck.waiting.some((w) =>
      w.inputs.some((i) =>
        ir.signals.some((s) => s.name === i.signal && delays.has(s.source.name)),
      ),
    );
    return {
      message: `deadlock: ${who.join(' and ')} ${who.length === 1 ? 'waits' : 'wait'} for tokens that never arrive${onLoop ? ': the delay on the loop holds too few initial tokens' : ': no initial token is on the loop'}.`,
      lines: stuck.waiting.flatMap((w) =>
        w.inputs.map((i) => `${w.actor} needs ${i.needed} on ${i.signal}, has ${i.available}`),
      ),
      span: nameSpan(ir, who[0]),
      fix: tokenFix(source, ir, stuck),
    };
  }

  // the scheduler's own words; it names the process at fault in quotes
  const named = [...sched.message.matchAll(/'([^']+)'/g)].find(([, n]) =>
    ir.spans.processes.has(n!),
  )?.[1];
  return { message: sched.message, lines: [], span: nameSpan(ir, named), fix: null };
}
