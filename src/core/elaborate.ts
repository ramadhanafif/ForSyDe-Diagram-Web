import type { Diagnostic, HsModule, Ident, ProcSpec, Span } from './ast';
import type { IRProcess, IRSignal, IRSystem, ProcessSpans, SpanIndex } from './ir';
import { isDelay } from './ir';

interface Producer {
  proc: string;
  outIdx: number;
}

function outCount(p: IRProcess): number {
  return isDelay(p) ? 1 : p.outRates.length;
}

function inCount(p: IRProcess): number {
  return isDelay(p) ? 1 : p.inRates.length;
}

function outRate(p: IRProcess, idx: number): number {
  return isDelay(p) ? 1 : (p.outRates[idx] ?? 1);
}

function inRate(p: IRProcess, idx: number): number {
  return isDelay(p) ? 1 : (p.inRates[idx] ?? 1);
}

function toProcess(spec: ProcSpec): IRProcess {
  if (spec.body.form === 'delay') {
    return { type: 'Delay', name: spec.name.name, tokens: spec.body.tokens };
  }
  const fn = spec.body.fn.name === 'undefined' ? 'NULL' : spec.body.fn.name;
  return {
    type: spec.body.actorType,
    name: spec.name.name,
    function: fn,
    inRates: spec.body.inRates.map((r) => r.value),
    outRates: spec.body.outRates.map((r) => r.value),
  };
}

export function elaborate(mod: HsModule): {
  ir: IRSystem | null;
  diagnostics: Diagnostic[];
} {
  const diags: Diagnostic[] = [];
  const sys = mod.system;
  if (!sys) return { ir: null, diagnostics: diags };

  // pass 1: process table
  const processes: IRProcess[] = [];
  const procByName = new Map<string, IRProcess>();
  const procSpans = new Map<string, ProcessSpans>();
  for (const spec of mod.procSpecs) {
    if (procByName.has(spec.name.name)) {
      diags.push({
        severity: 'error',
        code: 'duplicate-process',
        message: `Process '${spec.name.name}' is defined more than once`,
        span: spec.name.span,
      });
      continue;
    }
    const p = toProcess(spec);
    processes.push(p);
    procByName.set(p.name, p);
    procSpans.set(p.name, {
      specBinding: spec.span,
      name: spec.name.span,
      constructorSpan: spec.body.form === 'actor' ? spec.body.ctorSpan : undefined,
      etaParams: spec.etaParams,
      inRates: spec.body.form === 'actor' ? spec.body.inRates.map((r) => r.span) : [],
      outRates: spec.body.form === 'actor' ? spec.body.outRates.map((r) => r.span) : [],
      fnName: spec.body.form === 'actor' ? spec.body.fn.span : undefined,
      tokens: spec.body.form === 'delay' ? spec.body.tokensSpan : undefined,
      systemBindings: [],
      bindingProcs: [],
    });
  }

  const inputs = sys.params.map((p) => p.name);
  const inputSet = new Set(inputs);

  // producers: signal name -> (process, output index)
  const producers = new Map<string, Producer>();
  const signalOccurrences = new Map<string, Span[]>();
  const noteOccurrence = (id: Ident) => {
    const list = signalOccurrences.get(id.name) ?? [];
    list.push(id.span);
    signalOccurrences.set(id.name, list);
  };
  sys.params.forEach(noteOccurrence);
  sys.outputs.forEach(noteOccurrence);

  const usedProcs = new Set<string>();
  for (const b of sys.bindings) {
    b.lhs.forEach(noteOccurrence);
    b.args.forEach(noteOccurrence);
    const p = procByName.get(b.proc.name);
    if (!p) {
      diags.push({
        severity: 'error',
        code: 'unknown-process',
        message: `'${b.proc.name}' is not a defined process (actor or delay)`,
        span: b.proc.span,
      });
      continue;
    }
    const ps = procSpans.get(p.name);
    ps?.systemBindings.push(b.span);
    ps?.bindingProcs.push(b.proc.span);
    if (usedProcs.has(p.name)) {
      diags.push({
        severity: 'error',
        code: 'process-reuse',
        message: `Process '${p.name}' is instantiated twice; each process may appear in one binding only`,
        span: b.proc.span,
      });
      continue;
    }
    usedProcs.add(p.name);
    if (b.lhs.length !== outCount(p)) {
      diags.push({
        severity: 'error',
        code: 'output-arity',
        message: `'${p.name}' produces ${outCount(p)} output(s) but the binding names ${b.lhs.length}`,
        span: b.span,
      });
      continue;
    }
    if (b.args.length !== inCount(p)) {
      diags.push({
        severity: 'error',
        code: 'input-arity',
        message: `'${p.name}' consumes ${inCount(p)} input(s) but is applied to ${b.args.length}`,
        span: b.span,
      });
      continue;
    }
    b.lhs.forEach((l, idx) => {
      if (producers.has(l.name)) {
        diags.push({
          severity: 'error',
          code: 'duplicate-signal',
          message: `Signal '${l.name}' is produced by more than one binding`,
          span: l.span,
        });
        return;
      }
      producers.set(l.name, { proc: p.name, outIdx: idx });
    });
  }

  if (diags.some((d) => d.severity === 'error')) {
    return { ir: null, diagnostics: diags };
  }

  // pass 2: wire signals
  const signals: IRSignal[] = [];
  const consumed = new Map<string, Span>();
  const resolveSource = (arg: Ident): { name: string; rate: number } | null => {
    if (inputSet.has(arg.name)) return { name: arg.name, rate: 1 };
    const prod = producers.get(arg.name);
    if (!prod) {
      diags.push({
        severity: 'error',
        code: 'unknown-signal',
        message: `Signal '${arg.name}' is neither a system input nor produced by any binding`,
        span: arg.span,
      });
      return null;
    }
    const p = procByName.get(prod.proc)!;
    return { name: prod.proc, rate: outRate(p, prod.outIdx) };
  };

  for (const b of sys.bindings) {
    const p = procByName.get(b.proc.name)!;
    b.args.forEach((arg, idx) => {
      const prev = consumed.get(arg.name);
      if (prev) {
        diags.push({
          severity: 'error',
          code: 'implicit-split',
          message: `Signal '${arg.name}' is consumed twice; signals cannot be split implicitly: duplicate it with an explicit split actor`,
          span: arg.span,
        });
        return;
      }
      consumed.set(arg.name, arg.span);
      const source = resolveSource(arg);
      if (!source) return;
      signals.push({
        name: arg.name,
        source,
        target: { name: p.name, rate: inRate(p, idx) },
        targetSpan: arg.span,
      });
    });
  }

  for (const out of sys.outputs) {
    const source = resolveSource(out);
    if (!source) continue;
    signals.push({
      name: out.name,
      source,
      target: { name: out.name, rate: 1 },
      targetSpan: out.span,
    });
  }

  if (diags.some((d) => d.severity === 'error')) {
    return { ir: null, diagnostics: diags };
  }

  const functions = [
    ...new Set(processes.flatMap((p) => (isDelay(p) || p.function === 'NULL' ? [] : [p.function]))),
  ].map((name) => ({ name }));

  const spans: SpanIndex = {
    processes: procSpans,
    signals: signalOccurrences,
    anchors: {
      whereEnd: sys.whereEnd,
      whereIndent: sys.whereIndent,
      procSpecsEnd: mod.procSpecsEnd,
      systemParams: sys.paramsSpan,
      systemOutputs: sys.outputsSpan,
    },
  };

  return {
    ir: {
      inputs,
      outputs: sys.outputs.map((o) => o.name),
      processes,
      signals,
      functions,
      spans,
    },
    diagnostics: diags,
  };
}
