/** Absolute character offsets into the source, [from, to). */
export interface Span {
  from: number;
  to: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  span: Span;
}

export interface Ident {
  name: string;
  span: Span;
}

export type ActorType =
  | 'Actor11'
  | 'Actor12'
  | 'Actor13'
  | 'Actor14'
  | 'Actor21'
  | 'Actor22'
  | 'Actor23'
  | 'Actor24'
  | 'Actor31'
  | 'Actor32'
  | 'Actor33'
  | 'Actor34'
  | 'Actor41'
  | 'Actor42'
  | 'Actor43'
  | 'Actor44';

export interface RateLit {
  value: number;
  span: Span;
}

/** Body of a top-level process spec: an actorNMSDF or delaySDF call. */
export type ProcBody =
  | {
      form: 'actor';
      actorType: ActorType;
      /** Span of the `actorNMSDF` constructor token itself. */
      ctorSpan: Span;
      inRates: RateLit[];
      outRates: RateLit[];
      fn: Ident; // name may be 'undefined'
    }
  | {
      form: 'delay';
      tokens: number[];
      tokensSpan: Span;
    };

/** A binding inside the system where-block: `lhs = proc arg1 arg2`. */
export interface WhereBinding {
  lhs: Ident[]; // length > 1 means tuple destructure
  proc: Ident;
  args: Ident[];
  span: Span;
}

export interface SystemDecl {
  params: Ident[];
  outputs: Ident[]; // RHS identifier(s)
  bindings: WhereBinding[];
  paramsSpan: Span;
  outputsSpan: Span;
  whereIndent: string;
  whereEnd: number; // insertion offset for new bindings
  span: Span;
}

export interface ProcSpec {
  name: Ident;
  body: ProcBody;
  /** Number of explicit signal parameters (eta-expanded form); 0 if point-free. */
  etaParams: number;
  span: Span;
}

export interface HsModule {
  moduleName: string | null;
  system: SystemDecl | null;
  procSpecs: ProcSpec[];
  /** Names of top-level bindings that are neither system nor process specs (functions etc.). */
  otherBindings: string[];
  procSpecsEnd: number; // insertion offset for new process specs
}
