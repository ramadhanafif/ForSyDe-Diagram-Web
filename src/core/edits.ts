import type { Span } from './ast';
import type { IRSignal, IRSystem } from './ir';
import { isDelay } from './ir';

/**
 * Diagram-driven editing: every operation compiles to a list of text splices
 * against the current source. The source stays the single source of truth;
 * callers apply the splices (one CodeMirror transaction) and the normal
 * parse/elaborate/render pipeline picks up the change.
 *
 * All positions refer to the ORIGINAL source; splices never overlap.
 */
export interface Splice {
  from: number;
  to: number;
  insert: string;
}

/** Apply splices to a string (tests and non-CodeMirror callers). */
export function applySplices(source: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.from - a.from);
  let out = source;
  for (const s of sorted) out = out.slice(0, s.from) + s.insert + out.slice(s.to);
  return out;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_']*/g;

/** First name `<prefix>_1`, `<prefix>_2`, ... not appearing anywhere in the source. */
export function freshName(source: string, prefix: string): string {
  const taken = new Set(source.match(IDENT_RE) ?? []);
  for (let i = 1; ; i++) {
    const name = `${prefix}_${i}`;
    if (!taken.has(name)) return name;
  }
}

export function isValidFreshIdent(source: string, name: string): boolean {
  if (!/^[a-z_][A-Za-z0-9_']*$/.test(name)) return false;
  return !new Set(source.match(IDENT_RE) ?? []).has(name);
}

/** Runnable stub for a new actor function: consumes anything, emits zeros at the out rates. */
function functionStub(fn: string, nIn: number, outRates: number[]): string {
  const argTypes = Array(nIn).fill('[Int]').join(' -> ');
  const retType = outRates.length === 1 ? '[Int]' : `(${outRates.map(() => '[Int]').join(', ')})`;
  const args = Array(nIn).fill('_').join(' ');
  const bodies = outRates.map((r) => `replicate ${r} 0`);
  const body = bodies.length === 1 ? bodies[0]! : `(${bodies.join(', ')})`;
  return `${fn} :: ${argTypes} -> ${retType}\n${fn} ${args} = ${body}\n`;
}

function replaceSpan(span: Span, insert: string): Splice {
  return { from: span.from, to: span.to, insert };
}

/** Delete a whole line group (spec or binding), including the preceding newline. */
function deleteLines(span: Span): Splice {
  return span.from > 0
    ? { from: span.from - 1, to: span.to, insert: '' }
    : { from: span.from, to: span.to + 1, insert: '' };
}

export interface EditResult {
  splices: Splice[];
  /** Names created by the operation (for UI feedback). */
  created: string[];
}

/**
 * Insert a new 1-in-1-out process in the middle of an edge: the new process
 * consumes the edge's signal and the old consumer is rewired to a fresh signal.
 */
export function insertOnEdge(
  source: string,
  ir: IRSystem,
  edge: IRSignal,
  kind: 'actor' | 'delay',
): EditResult {
  const a = ir.spans.anchors;
  const splices: Splice[] = [];
  const created: string[] = [];
  const sig = freshName(source, 's');
  let proc: string;
  if (kind === 'actor') {
    proc = freshName(source, 'a');
    const fn = freshName(source, 'f');
    splices.push({
      from: a.procSpecsEnd,
      to: a.procSpecsEnd,
      insert: `\n${proc} = actor11SDF 1 1 ${fn}`,
    });
    splices.push({
      from: source.length,
      to: source.length,
      insert: `\n${functionStub(fn, 1, [1])}`,
    });
    created.push(proc, sig, fn);
  } else {
    proc = freshName(source, 'd');
    splices.push({
      from: a.procSpecsEnd,
      to: a.procSpecsEnd,
      insert: `\n${proc} = delaySDF [0]`,
    });
    created.push(proc, sig);
  }
  splices.push({
    from: a.whereEnd,
    to: a.whereEnd,
    insert: `\n${a.whereIndent}${sig} = ${proc} ${edge.name}`,
  });
  splices.push(replaceSpan(edge.targetSpan, sig));
  return { splices, created };
}

/**
 * Add a new actor fed by a fresh system input; its output becomes a new
 * system output so the model stays fully connected.
 */
export function addSourceActor(source: string, ir: IRSystem): EditResult {
  const a = ir.spans.anchors;
  const proc = freshName(source, 'a');
  const fn = freshName(source, 'f');
  const inSig = freshName(source, 's');
  // freshName scans the source only, so exclude the first pick explicitly
  const outSig = freshName(`${source} ${inSig}`, 's');
  const splices: Splice[] = [
    { from: a.systemParams.to, to: a.systemParams.to, insert: ` ${inSig}` },
    { from: a.procSpecsEnd, to: a.procSpecsEnd, insert: `\n${proc} = actor11SDF 1 1 ${fn}` },
    {
      from: a.whereEnd,
      to: a.whereEnd,
      insert: `\n${a.whereIndent}${outSig} = ${proc} ${inSig}`,
    },
    { from: source.length, to: source.length, insert: `\n${functionStub(fn, 1, [1])}` },
  ];
  const outText = source.slice(a.systemOutputs.from, a.systemOutputs.to);
  if (ir.outputs.length === 1) {
    splices.push(replaceSpan(a.systemOutputs, `(${outText}, ${outSig})`));
  } else {
    splices.push({ from: a.systemOutputs.to, to: a.systemOutputs.to, insert: `, ${outSig}` });
  }
  return { splices, created: [proc, inSig, outSig, fn] };
}

/** Replace the rate literals of an actor. Lengths must match the actor arity. */
export function setRates(
  ir: IRSystem,
  name: string,
  inRates: number[],
  outRates: number[],
): Splice[] | null {
  const spans = ir.spans.processes.get(name);
  if (!spans) return null;
  if (spans.inRates.length !== inRates.length || spans.outRates.length !== outRates.length)
    return null;
  if ([...inRates, ...outRates].some((r) => !Number.isInteger(r) || r < 1)) return null;
  return [
    ...spans.inRates.map((s, i) => replaceSpan(s, String(inRates[i]))),
    ...spans.outRates.map((s, i) => replaceSpan(s, String(outRates[i]))),
  ];
}

export function setFunction(ir: IRSystem, name: string, fn: string): Splice[] | null {
  const spans = ir.spans.processes.get(name);
  if (!spans?.fnName || !/^[a-z_][A-Za-z0-9_']*$/.test(fn)) return null;
  return [replaceSpan(spans.fnName, fn)];
}

export function setTokens(ir: IRSystem, name: string, tokens: number[]): Splice[] | null {
  const spans = ir.spans.processes.get(name);
  if (!spans?.tokens || tokens.some((t) => !Number.isInteger(t))) return null;
  return [replaceSpan(spans.tokens, `[${tokens.join(',')}]`)];
}

export function renameProcess(
  source: string,
  ir: IRSystem,
  oldName: string,
  newName: string,
): Splice[] | null {
  const spans = ir.spans.processes.get(oldName);
  if (!spans || !isValidFreshIdent(source, newName)) return null;
  return [spans.name, ...spans.bindingProcs].map((s) => replaceSpan(s, newName));
}

export function renameSignal(
  source: string,
  ir: IRSystem,
  oldName: string,
  newName: string,
): Splice[] | null {
  const occ = ir.spans.signals.get(oldName);
  if (!occ || !isValidFreshIdent(source, newName)) return null;
  return occ.map((s) => replaceSpan(s, newName));
}

/**
 * Feed an existing produced-or-input signal into an additional input of an
 * actor (drag-to-connect). Bumps the constructor arity, adds a rate of 1 and
 * appends the signal to the actor's binding. Point-free specs only: an
 * eta-expanded spec would also need its params, application tail and type
 * signature rewritten.
 * ponytail: the actor's function is left untouched (bodies are opaque), so a
 * regenerated fixture would need a manual function-arity fix.
 */
export function addInput(
  source: string,
  ir: IRSystem,
  procName: string,
  signalName: string,
): Splice[] | null {
  const spans = ir.spans.processes.get(procName);
  const p = ir.processes.find((q) => q.name === procName);
  if (!spans?.constructorSpan || !p || isDelay(p)) return null;
  if (spans.etaParams > 0 || spans.systemBindings.length !== 1) return null;
  if (p.inRates.length >= 4) return null;
  // the signal must exist and must not already be consumed by a process
  const isInput = ir.inputs.includes(signalName);
  const produced = ir.signals.some((s) => s.name === signalName);
  const signalOccurs = ir.spans.signals.has(signalName);
  if (!isInput && !produced && !signalOccurs) return null;
  const consumedByProc = ir.signals.some(
    (s) => s.name === signalName && ir.processes.some((q) => q.name === s.target.name),
  );
  if (consumedByProc) return null;
  // no direct self-loop
  const producer = ir.signals.find((s) => s.name === signalName)?.source.name;
  if (producer === procName) return null;

  const nIn = p.inRates.length;
  const nOut = p.outRates.length;
  const splices: Splice[] = [
    replaceSpan(spans.constructorSpan, `actor${nIn + 1}${nOut}SDF`),
    nIn === 1
      ? replaceSpan(spans.inRates[0]!, `(${p.inRates[0]}, 1)`)
      : { from: spans.inRates[nIn - 1]!.to, to: spans.inRates[nIn - 1]!.to, insert: ', 1' },
    {
      from: spans.systemBindings[0]!.to,
      to: spans.systemBindings[0]!.to,
      insert: ` ${signalName}`,
    },
  ];
  return splices;
}

/**
 * Remove a process. Supported cases: a 1-in-1-out process bound in the system
 * (consumers are rewired to its input signal) or an unbound spec.
 * Returns null when deletion would need cascading edits.
 */
export function deleteProcess(source: string, ir: IRSystem, name: string): Splice[] | null {
  const spans = ir.spans.processes.get(name);
  const p = ir.processes.find((q) => q.name === name);
  if (!spans || !p) return null;

  const splices: Splice[] = [deleteLines(spans.specBinding)];
  if (spans.systemBindings.length === 0) return splices;

  const oneInOneOut = isDelay(p) || (p.inRates.length === 1 && p.outRates.length === 1);
  if (!oneInOneOut || spans.systemBindings.length !== 1) return null;

  const inEdge = ir.signals.find((s) => s.target.name === name);
  if (!inEdge) return null;
  if (inEdge.source.name === name) return null; // self-loop, nothing to rewire to
  splices.push(deleteLines(spans.systemBindings[0]!));
  for (const s of ir.signals) {
    if (s.source.name === name) splices.push(replaceSpan(s.targetSpan, inEdge.name));
  }
  return splices;
}
