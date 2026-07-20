import type { ActorType, Span } from './ast';

export interface IRActor {
  type: ActorType;
  name: string;
  function: string;
  inRates: number[];
  outRates: number[];
}

export interface IRDelay {
  type: 'Delay';
  name: string;
  tokens: number[];
}

export type IRProcess = IRActor | IRDelay;

export interface IREndpoint {
  name: string;
  rate: number;
}

export interface IRSignal {
  name: string;
  source: IREndpoint;
  target: IREndpoint;
  /** Span of the identifier at the consumption site (binding arg or system output). */
  targetSpan: Span;
}

/** Source location index enabling phase-2 text patches. */
export interface ProcessSpans {
  specBinding: Span;
  /** The process name identifier in its top-level spec. */
  name: Span;
  inRates: Span[];
  outRates: Span[];
  fnName?: Span;
  tokens?: Span;
  systemBindings: Span[];
  /** The process name identifier inside each system binding. */
  bindingProcs: Span[];
}

export interface SpanIndex {
  processes: Map<string, ProcessSpans>;
  /** Every textual occurrence of each signal name inside the system block. */
  signals: Map<string, Span[]>;
  anchors: {
    whereEnd: number;
    whereIndent: string;
    procSpecsEnd: number;
    systemParams: Span;
    systemOutputs: Span;
  };
}

export interface IRSystem {
  inputs: string[];
  outputs: string[];
  processes: IRProcess[];
  signals: IRSignal[];
  functions: { name: string }[];
  spans: SpanIndex;
}

export function isDelay(p: IRProcess): p is IRDelay {
  return p.type === 'Delay';
}

/**
 * Strip spans/rates and produce the exact JSON shape emitted by
 * forsyde-compiler-exe --output-forsyde-ir-json, for fixture parity tests.
 * The `functions` array is intentionally omitted: the reference compiler
 * injects GHC-generated `fail` bindings there, and the actor->function
 * mapping is already covered by `processes`.
 */
export function irToParityJson(ir: IRSystem): unknown {
  return {
    system: {
      inputs: ir.inputs,
      outputs: ir.outputs,
      processes: ir.processes.map((p) =>
        isDelay(p)
          ? { type: 'Delay', name: p.name, tokens: p.tokens }
          : { type: p.type, name: p.name, function: p.function },
      ),
      signals: ir.signals.map((s) => ({
        name: s.name,
        source: { name: s.source.name, rate: s.source.rate },
        target: { name: s.target.name, rate: s.target.rate },
      })),
    },
  };
}
