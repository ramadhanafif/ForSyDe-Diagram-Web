import {
  renameProcess,
  renameSignal,
  setFunction,
  setRates,
  setTokens,
  type Splice,
} from './edits';
import type { IRSystem } from './ir';
import { isDelay } from './ir';

/** Comma-separated integers, or null. */
export function parseInts(text: string): number[] | null {
  const parts = text.split(',').map((t) => t.trim());
  if (parts.some((p) => !/^-?\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** Delay initial tokens: comma-separated numbers, floats allowed, or null. */
export function parseTokens(text: string): number[] | null {
  const parts = text.split(',').map((t) => t.trim());
  if (parts.some((p) => !/^-?\d+(\.\d+)?$/.test(p))) return null;
  return parts.map(Number);
}

/** One field of the model that can be edited in place on the canvas. */
export type EditTarget =
  /** One rate: the port's argument (in) or tuple (out) position. */
  | { kind: 'rate'; node: string; dir: 'in' | 'out'; index: number }
  | { kind: 'tokens'; node: string }
  | { kind: 'name'; node: string }
  | { kind: 'signal'; signal: string }
  | { kind: 'fn'; node: string };

/** The field's current text, as the input starts out; null when it is not editable. */
export function editValue(ir: IRSystem, t: EditTarget): string | null {
  if (t.kind === 'signal') return ir.signals.some((s) => s.name === t.signal) ? t.signal : null;
  const p = ir.processes.find((q) => q.name === t.node);
  if (!p) return null;
  if (t.kind === 'name') return p.name;
  if (isDelay(p)) return t.kind === 'tokens' ? p.tokens.join(', ') : null;
  if (t.kind === 'fn') return p.function === 'NULL' ? '' : p.function;
  if (t.kind === 'rate') {
    const r = (t.dir === 'in' ? p.inRates : p.outRates)[t.index];
    return r === undefined ? null : String(r);
  }
  return null;
}

/**
 * The splices that set the field to `text`, or why not. A rate edit changes
 * only that rate; the actor's other rates stay as they are.
 */
export function inlineEdit(
  ir: IRSystem,
  source: string,
  t: EditTarget,
  text: string,
): Splice[] | string {
  const v = text.trim();
  if (t.kind === 'signal')
    return renameSignal(source, ir, t.signal, v) ?? 'that name is taken or not an identifier';
  if (t.kind === 'name')
    return renameProcess(source, ir, t.node, v) ?? 'that name is taken or not an identifier';
  if (t.kind === 'fn') return setFunction(ir, t.node, v) ?? 'not a function name';
  if (t.kind === 'tokens') {
    const tokens = parseTokens(v);
    if (!tokens || tokens.some((k) => k < 0)) return 'tokens are non-negative numbers, like 0, 1';
    return setTokens(ir, t.node, tokens) ?? 'not a delay';
  }
  const p = ir.processes.find((q) => q.name === t.node);
  if (!p || isDelay(p)) return 'not an actor';
  const r = parseInts(v);
  if (!r || r.length !== 1 || r[0]! < 1) return 'a rate is a whole number of tokens, 1 or more';
  const ins = [...p.inRates];
  const outs = [...p.outRates];
  (t.dir === 'in' ? ins : outs)[t.index] = r[0]!;
  return setRates(ir, p.name, ins, outs) ?? 'that rate cannot be set';
}
