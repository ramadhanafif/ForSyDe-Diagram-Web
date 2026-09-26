import type { Span } from './ast';
import type { IRSystem } from './ir';
import { isDelay } from './ir';

/**
 * The links between the source text and the diagram, both ways: which
 * diagram elements the text at an offset is about, and which source spans a
 * diagram element comes from. Diagram elements are named as the scene names
 * them: a node by process or io signal name, an edge by its edge id.
 */

const inside = (s: Span, at: number) => at >= s.from && at <= s.to;

/** The edge ids of the edges drawing signal `name`. */
function edgesOf(ir: IRSystem, name: string, edgeId: (s: IRSystem['signals'][number]) => string) {
  return ir.signals.filter((s) => s.name === name).map(edgeId);
}

/** Line spans of the top-level equations and signatures of function `fn`. */
export function definitionSpans(source: string, fn: string): Span[] {
  const out: Span[] = [];
  let from = 0;
  for (const line of source.split('\n')) {
    const next = line[fn.length] ?? '';
    if (line.startsWith(fn) && !/[A-Za-z0-9_']/.test(next))
      out.push({ from, to: from + line.length });
    from += line.length + 1;
  }
  return out;
}

export interface Linked {
  nodes: Set<string>;
  edges: Set<string>;
}

/**
 * What the text at `at` is about. A signal name marks its edges; otherwise a
 * system binding or a process spec marks the process; otherwise a function
 * definition marks every actor that applies the function.
 */
export function linkedAt(
  ir: IRSystem,
  source: string,
  at: number,
  edgeId: (s: IRSystem['signals'][number]) => string,
): Linked {
  const out: Linked = { nodes: new Set(), edges: new Set() };
  for (const [sig, spans] of ir.spans.signals)
    if (spans.some((s) => inside(s, at))) {
      for (const e of edgesOf(ir, sig, edgeId)) out.edges.add(e);
      // an io signal is also its pill
      if (ir.inputs.includes(sig) || ir.outputs.includes(sig)) out.nodes.add(sig);
      return out;
    }
  for (const [name, ps] of ir.spans.processes)
    if (ps.systemBindings.some((s) => inside(s, at)) || inside(ps.specBinding, at)) {
      out.nodes.add(name);
      return out;
    }
  for (const p of ir.processes) {
    if (isDelay(p) || p.function === 'NULL') continue;
    if (definitionSpans(source, p.function).some((s) => inside(s, at)))
      for (const q of ir.processes)
        if (!isDelay(q) && q.function === p.function) out.nodes.add(q.name);
  }
  return out;
}

/** A diagram element under the pointer, as precise as the pointer is. */
export type Target =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; signal: string }
  /** A port, or the rate label at it: `index` is its argument or tuple position. */
  | { kind: 'rate'; node: string; dir: 'in' | 'out'; index: number }
  /** A line inside a node: its constructor, function or delay tokens. */
  | { kind: 'stack'; node: string; line: 'ctor' | 'fn' | 'tokens' };

/** A span without its surrounding whitespace (a binding's span starts at its indentation). */
function trim(source: string, s: Span): Span {
  let { from, to } = s;
  while (from < to && /\s/.test(source[from]!)) from++;
  while (to > from && /\s/.test(source[to - 1]!)) to--;
  return { from, to };
}

/** The source spans a diagram element comes from, most specific first, whitespace trimmed. */
export function sourceSpans(ir: IRSystem, source: string, t: Target): Span[] {
  return rawSpans(ir, source, t).map((s) => trim(source, s));
}

function rawSpans(ir: IRSystem, source: string, t: Target): Span[] {
  if (t.kind === 'edge') return ir.spans.signals.get(t.signal) ?? [];
  const ps = ir.spans.processes.get(t.kind === 'node' ? t.id : t.node);
  if (t.kind === 'node') {
    // an io pill is its signal
    if (!ps) return ir.spans.signals.get(t.id) ?? [];
    return [ps.specBinding, ...ps.systemBindings];
  }
  if (!ps) return [];
  if (t.kind === 'rate') {
    const r = (t.dir === 'in' ? ps.inRates : ps.outRates)[t.index];
    return r ? [r] : [];
  }
  if (t.line === 'ctor') return ps.constructorSpan ? [ps.constructorSpan] : [];
  if (t.line === 'tokens') return ps.tokens ? [ps.tokens] : [];
  const p = ir.processes.find((q) => q.name === t.node);
  const fn = p && !isDelay(p) ? p.function : '';
  return [...(ps.fnName ? [ps.fnName] : []), ...definitionSpans(source, fn)];
}
