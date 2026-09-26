import { isDelay, type IRSignal, type IRSystem } from '../core/ir';
import type { ScheduleResult } from '../core/schedule';
import type { LabelFlags, LabelKind } from './types';

/** A label's identity and text, before layout gives it a box. */
export interface ExpectedLabel {
  kind: LabelKind;
  owner: string;
  text: string;
}

/**
 * One line of a node's stack text. ctor: the constructor (actorNMSDF,
 * delaySDF), hidden by flags.constructors. fn: the actor's function ('⊥' for
 * NULL), hidden by flags.functions. tokens: a delay's initial tokens, always
 * shown. Rates are not stack lines; they are port labels.
 */
export interface StackLine {
  kind: 'ctor' | 'fn' | 'tokens';
  text: string;
}

/** Per process, what the renderer shows inside the node and in its tooltips. */
export interface NodeMeta {
  /** Every stack line, flags ignored. */
  stack: StackLine[];
  /** Firings per schedule iteration; actors with a consistent schedule only. */
  repetitions?: number;
}

/** Per edge: the buffer size the schedule reserves for its signal. */
export interface EdgeMeta {
  buffer?: number;
}

export interface SceneMeta {
  /** By process name (io nodes have no meta). */
  nodes: Map<string, NodeMeta>;
  /** By edge id. */
  edges: Map<string, EdgeMeta>;
}

/** Scene edge id; system-output signals target their own name, which is also a node id. */
export const edgeId = (s: IRSignal): string => `e_${s.name}_${s.source.name}_${s.target.name}`;

/** Edge end: the port id, or the io node id for a system input/output. */
export function attachRef(ir: IRSystem, proc: string, sig: string, dir: 'in' | 'out'): string {
  return ir.processes.some((p) => p.name === proc) ? `${proc}.${dir}.${sig}` : proc;
}

export function sceneMeta(ir: IRSystem, schedule: ScheduleResult | null): SceneMeta {
  const ok = schedule?.ok ? schedule : null;
  const nodes = new Map<string, NodeMeta>();
  for (const p of ir.processes)
    nodes.set(
      p.name,
      isDelay(p)
        ? {
            stack: [
              { kind: 'ctor', text: 'delaySDF' },
              { kind: 'tokens', text: `[${p.tokens.join(',')}]` },
            ],
          }
        : {
            stack: [
              { kind: 'ctor', text: `actor${p.type.slice(5)}SDF` },
              { kind: 'fn', text: p.function === 'NULL' ? '⊥' : p.function },
            ],
            repetitions: ok?.repetitions.get(p.name),
          },
    );
  const edges = new Map<string, EdgeMeta>();
  for (const s of ir.signals) {
    // delays merge signals into one buffer; the schedule keys it by the alias
    const key = ok?.aliases.get(s.name) ?? s.name;
    edges.set(edgeId(s), { buffer: ok?.buffers.find(([name]) => name === key)?.[1] });
  }
  return { nodes, edges };
}

/**
 * The labels a scene shows for these flags: hidden labels are absent, so they
 * take no space. Layout places exactly these and validateScene checks them.
 */
export function sceneLabels(
  ir: IRSystem,
  schedule: ScheduleResult | null,
  flags: LabelFlags,
): ExpectedLabel[] {
  const meta = sceneMeta(ir, schedule);
  const out: ExpectedLabel[] = [];
  const add = (kind: LabelKind, owner: string, text: string) => out.push({ kind, owner, text });
  const lineShown = { ctor: flags.constructors, fn: flags.functions, tokens: true };
  for (const [id, m] of meta.nodes) {
    add('name', id, id);
    if (m.repetitions !== undefined && flags.repetitions) add('badge', id, `×${m.repetitions}`);
    const lines = m.stack.filter((l) => lineShown[l.kind]).map((l) => l.text);
    if (lines.length) add('stack', id, lines.join('\n'));
  }
  const rateShown = (r: number) => flags.rates && (r !== 1 || flags.unitRates);
  for (const s of ir.signals) {
    const id = edgeId(s);
    if (rateShown(s.source.rate))
      add('rate', attachRef(ir, s.source.name, s.name, 'out'), String(s.source.rate));
    if (rateShown(s.target.rate))
      add('rate', attachRef(ir, s.target.name, s.name, 'in'), String(s.target.rate));
    if (flags.signals) add('signal', id, s.name);
    const buffer = meta.edges.get(id)?.buffer;
    if (buffer !== undefined && flags.buffers) add('buffer', id, `buf ${buffer}`);
  }
  return out;
}
