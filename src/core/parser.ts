import type {
  ActorType,
  Diagnostic,
  HsModule,
  Ident,
  ProcBody,
  ProcSpec,
  RateLit,
  Span,
  SystemDecl,
  WhereBinding,
} from './ast';
import { tokenize, type Token } from './lexer';

const ACTOR_RE = /^actor([1-4])([1-4])SDF$/;

const CONSTRUCTORS = ['delaySDF'];
for (let n = 1; n <= 4; n++) for (let m = 1; m <= 4; m++) CONSTRUCTORS.push(`actor${n}${m}SDF`);

function isConstructor(name: string): boolean {
  return ACTOR_RE.test(name) || name === 'delaySDF';
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The constructor a misspelt head most likely meant (case-insensitive, edit distance <= 2). */
function nearConstructor(name: string): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const ctor of CONSTRUCTORS) {
    const d = levenshtein(name.toLowerCase(), ctor.toLowerCase());
    if (d < bestDist) {
      best = ctor;
      bestDist = d;
    }
  }
  return best;
}

interface Decl {
  offset: number;
  end: number;
  lines: { text: string; offset: number; indent: number }[];
}

/** Split source into top-level declarations (a decl starts at column 0). */
function splitDecls(source: string): Decl[] {
  const decls: Decl[] = [];
  let current: Decl | null = null;
  let offset = 0;
  let inBlockComment = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    const isBlank = trimmed === '' || trimmed.startsWith('--');
    if (inBlockComment) {
      if (trimmed.includes('-}')) inBlockComment = false;
    } else if (trimmed.startsWith('{-') && !trimmed.includes('-}')) {
      inBlockComment = true;
    } else if (!isBlank && indent === 0) {
      if (current) decls.push(current);
      current = { offset, end: offset + line.length, lines: [] };
    }
    if (current && !isBlank && !inBlockComment) {
      current.lines.push({ text: line, offset, indent });
      current.end = offset + line.length;
    }
    offset += line.length + 1;
  }
  if (current) decls.push(current);
  return decls;
}

function ident(t: Token): Ident {
  return { name: t.text, span: t.span };
}

/** Cursor over a token array. */
class Cursor {
  constructor(
    public tokens: Token[],
    public pos = 0,
  ) {}
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  atIdent(name?: string): boolean {
    const t = this.peek();
    return t?.kind === 'ident' && (name === undefined || t.text === name);
  }
  atPunct(text: string): boolean {
    const t = this.peek();
    return t?.kind === 'punct' && t.text === text;
  }
  expectPunct(text: string): Token | null {
    return this.atPunct(text) ? this.next()! : null;
  }
}

/** Parse `ident` or `(ident, ident, ...)`. Returns null on mismatch. */
function parseIdentOrTuple(c: Cursor): Ident[] | null {
  if (c.atIdent()) return [ident(c.next()!)];
  if (c.atPunct('(')) {
    c.next();
    const items: Ident[] = [];
    while (c.atIdent()) {
      items.push(ident(c.next()!));
      if (!c.expectPunct(',')) break;
    }
    if (!c.expectPunct(')') || items.length === 0) return null;
    return items;
  }
  return null;
}

/** An int literal JavaScript cannot hold exactly; Number() would round it silently. */
function tooBig(t: Token, diags: Diagnostic[]): boolean {
  if (t.kind !== 'int' || Number.isSafeInteger(Number(t.text))) return false;
  diags.push({
    severity: 'error',
    code: 'big-literal',
    message: `${t.text} is too large: the largest number this editor handles is ${Number.MAX_SAFE_INTEGER}`,
    span: t.span,
  });
  return true;
}

/** Parse a rate argument: bare int or tuple of ints. Floats are consumed so
 * the bad-rate check below can reject them with a clear message. */
function parseRates(c: Cursor, diags: Diagnostic[]): RateLit[] | null {
  const t = c.peek();
  if (t?.kind === 'int' || t?.kind === 'float') {
    c.next();
    return tooBig(t, diags) ? null : [{ value: Number(t.text), span: t.span }];
  }
  if (c.atPunct('(')) {
    c.next();
    const rates: RateLit[] = [];
    while (c.peek()?.kind === 'int' || c.peek()?.kind === 'float') {
      const tok = c.next()!;
      if (tooBig(tok, diags)) return null;
      rates.push({ value: Number(tok.text), span: tok.span });
      if (!c.expectPunct(',')) break;
    }
    if (!c.expectPunct(')') || rates.length === 0) return null;
    return rates;
  }
  return null;
}

function parseProcBody(c: Cursor, diags: Diagnostic[], declSpan: Span): ProcBody | null {
  const head = c.next()!;
  const actorMatch = ACTOR_RE.exec(head.text);
  if (actorMatch) {
    const nIn = parseInt(actorMatch[1]!, 10);
    const nOut = parseInt(actorMatch[2]!, 10);
    // flat numeric run after the head, used to build the tuple example below
    const flat: string[] = [];
    for (let i = c.pos; c.tokens[i]?.kind === 'int'; i++) flat.push(c.tokens[i]!.text);
    const inBare = c.peek()?.kind === 'int';
    const before = diags.length;
    const inRates = parseRates(c, diags);
    const outBare = c.peek()?.kind === 'int';
    const outRates = parseRates(c, diags);
    if (diags.length > before) return null;
    const fnTok = c.atIdent() ? c.next()! : null;
    for (const r of [...(inRates ?? []), ...(outRates ?? [])]) {
      if (!Number.isInteger(r.value) || r.value < 1) {
        diags.push({
          severity: 'error',
          code: 'bad-rate',
          message: `Rates must be whole numbers of at least 1, got ${r.value}`,
          span: r.span,
        });
        return null;
      }
    }
    const bareIdx = nIn > 1 && inBare ? 0 : nOut > 1 && outBare && inRates ? inRates.length : -1;
    if (bareIdx !== -1) {
      const nums = [...flat, ...Array<string>(nIn + nOut).fill('1')].slice(0, nIn + nOut);
      const group = (xs: string[]) => (xs.length > 1 ? `(${xs.join(', ')})` : xs[0]!);
      let fnName = 'f';
      for (let i = c.pos; c.tokens[i]; i++) {
        if (c.tokens[i]!.kind === 'ident') {
          fnName = c.tokens[i]!.text;
          break;
        }
      }
      const example = `${head.text} ${group(nums.slice(0, nIn))} ${group(nums.slice(nIn))} ${fnName}`;
      const which = bareIdx === 0 ? `${nIn} input` : `${nOut} output`;
      diags.push({
        severity: 'error',
        code: 'rate-arity',
        message: `${head.text} takes its ${which} rates as a tuple: ${example}`,
        span: bareIdx === 0 ? inRates![0]!.span : outRates![0]!.span,
      });
      return null;
    }
    if (inRates && outRates && !fnTok && (c.atPunct('(') || c.peek()?.text === '\\')) {
      diags.push({
        severity: 'error',
        code: 'bad-actor-call',
        message: 'Name the function at top level and pass its name: f_1 [x] = [x]',
        span: c.peek()!.span,
      });
      return null;
    }
    if (!inRates || !outRates || !fnTok) {
      diags.push({
        severity: 'error',
        code: 'bad-actor-call',
        message: `Malformed ${head.text} call: expected rates and a function name`,
        span: head.span,
      });
      return null;
    }
    if (inRates.length !== nIn || outRates.length !== nOut) {
      diags.push({
        severity: 'error',
        code: 'rate-arity',
        message: `${head.text} expects ${nIn} input and ${nOut} output rates, got ${inRates.length} and ${outRates.length}`,
        span: head.span,
      });
      return null;
    }
    const actorType = `Actor${nIn}${nOut}` as ActorType;
    return { form: 'actor', actorType, ctorSpan: head.span, inRates, outRates, fn: ident(fnTok) };
  }
  if (head.text === 'delaySDF') {
    const open = c.expectPunct('[');
    const tokens: number[] = [];
    if (open) {
      while (c.peek()?.kind === 'int' || c.peek()?.kind === 'float') {
        const tok = c.next()!;
        if (tooBig(tok, diags)) return null;
        tokens.push(Number(tok.text));
        if (!c.expectPunct(',')) break;
      }
    }
    const close = c.expectPunct(']');
    if (!open || !close) {
      diags.push({
        severity: 'error',
        code: 'bad-delay-call',
        message: 'Malformed delaySDF call: expected an initial-token list like [0]',
        span: head.span,
      });
      return null;
    }
    return {
      form: 'delay',
      tokens,
      tokensSpan: { from: open.span.from, to: close.span.to },
    };
  }
  diags.push({
    severity: 'error',
    code: 'unknown-constructor',
    message: `Unknown process constructor '${head.text}'`,
    span: declSpan,
  });
  return null;
}

function parseSystem(
  source: string,
  decl: Decl,
  tokens: Token[],
  diags: Diagnostic[],
  stranded: Set<string>,
  inlineSpecs: ProcSpec[],
): SystemDecl | null {
  const c = new Cursor(tokens);
  c.next(); // 'system'
  const params: Ident[] = [];
  while (c.atIdent() && !c.atIdent('where')) params.push(ident(c.next()!));
  const paramsSpan: Span = params.length
    ? { from: params[0]!.span.from, to: params[params.length - 1]!.span.to }
    : { from: tokens[0]!.span.to, to: tokens[0]!.span.to };
  if (!c.expectPunct('=')) {
    diags.push({
      severity: 'error',
      code: 'bad-system',
      message: "Could not parse the 'system' definition (expected '=')",
      span: tokens[0]!.span,
    });
    return null;
  }
  const outputs = parseIdentOrTuple(c);
  if (!outputs) {
    diags.push({
      severity: 'error',
      code: 'bad-system-output',
      message: 'System output must be a signal name or a tuple of signal names',
      span: c.peek()?.span ?? tokens[0]!.span,
    });
    return null;
  }
  const outputsSpan: Span = {
    from: outputs[0]!.span.from,
    to: outputs[outputs.length - 1]!.span.to,
  };

  // Locate the where-block by lines: everything after the line containing 'where'.
  const whereTok = tokens.find((t) => t.kind === 'ident' && t.text === 'where');
  const bindings: WhereBinding[] = [];
  let whereIndent = '    ';
  let whereEnd = decl.end;
  if (whereTok) {
    // group binding lines: the first line after 'where' sets the base indent
    const afterWhere = decl.lines.filter((l) => l.offset > whereTok.span.to);
    let bindIndent = -1;
    let group: { from: number; to: number } | null = null;
    const groups: { from: number; to: number }[] = [];
    for (const l of afterWhere) {
      if (bindIndent === -1) {
        bindIndent = l.indent;
        whereIndent = ' '.repeat(l.indent);
      }
      if (l.indent <= bindIndent) {
        if (group) groups.push(group);
        group = { from: l.offset, to: l.offset + l.text.length };
      } else if (group) {
        group.to = l.offset + l.text.length;
      }
    }
    if (group) groups.push(group);
    whereEnd = groups.length ? groups[groups.length - 1]!.to : decl.end;

    for (const g of groups) {
      const btokens = tokenize(source, g.from, g.to);
      const binding = parseBinding(
        btokens,
        { from: g.from, to: g.to },
        diags,
        stranded,
        inlineSpecs,
      );
      if (binding) bindings.push(binding);
    }
  }

  return {
    params,
    outputs,
    bindings,
    paramsSpan,
    outputsSpan,
    whereIndent,
    whereEnd,
    span: { from: decl.offset, to: decl.end },
  };
}

/** Parse one where-binding. When it fails after the lhs parsed, the lhs
 * signals go into `stranded` so elaboration does not also call them unknown.
 * An inline `x = delaySDF [..] y` becomes a named delay in `inlineSpecs`. */
function parseBinding(
  tokens: Token[],
  span: Span,
  diags: Diagnostic[],
  stranded: Set<string>,
  inlineSpecs: ProcSpec[],
): WhereBinding | null {
  const c = new Cursor(tokens);
  if (tokens.some((t) => t.kind === 'ident' && t.text === 'where')) {
    diags.push({
      severity: 'error',
      code: 'nested-where',
      message: "Nested 'where' blocks inside the system are not supported",
      span,
    });
    return null;
  }
  const lhs = parseIdentOrTuple(c);
  if (!lhs || !c.expectPunct('=')) {
    diags.push({
      severity: 'error',
      code: 'bad-binding',
      message: 'Expected a binding like `s_out = proc s_in` or `(a, b) = proc s`',
      span,
    });
    return null;
  }
  const strand = () => lhs.forEach((l) => stranded.add(l.name));
  const procTok = c.atIdent() ? c.next()! : null;
  if (!procTok) {
    strand();
    diags.push({
      severity: 'error',
      code: 'bad-binding',
      message: 'Expected a process name on the right-hand side',
      span,
    });
    return null;
  }
  let proc = ident(procTok);
  if (procTok.text === 'delaySDF') {
    c.pos--;
    const body = parseProcBody(c, diags, span);
    if (!body) {
      strand();
      return null;
    }
    proc = { name: `delay_${lhs[0]!.name}`, span: procTok.span };
    inlineSpecs.push({ name: proc, body, etaParams: 0, span, inline: true });
  } else if (isConstructor(procTok.text)) {
    strand();
    diags.push({
      severity: 'error',
      code: 'inline-constructor',
      message: `Inline ${procTok.text} calls are not allowed in the system block; define a named process at top level`,
      span: procTok.span,
    });
    return null;
  }
  const args: Ident[] = [];
  while (c.atIdent()) args.push(ident(c.next()!));
  if (c.peek()) {
    strand();
    diags.push({
      severity: 'error',
      code: 'unsupported-binding',
      message: 'Only applications of a named process to signal names are supported here',
      span: c.peek()!.span,
    });
    return null;
  }
  return { lhs, proc, args, span };
}

export function parse(source: string): { module: HsModule; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const mod: HsModule = {
    moduleName: null,
    system: null,
    procSpecs: [],
    procSpecsEnd: source.length,
    brokenSpecs: new Set(),
    strandedSignals: new Set(),
  };
  let systemTokens: Token[] = [];
  // top-level `lhs = name args` decls after the system; checked for lost indentation below
  const afterSystem: { tokens: Token[]; span: Span }[] = [];

  for (const decl of splitDecls(source)) {
    const tokens = tokenize(source, decl.offset, decl.end);
    const head = tokens[0];
    if (!head || head.kind !== 'ident') continue;

    if (head.text === 'module') {
      mod.moduleName = tokens[1]?.text ?? null;
      continue;
    }
    if (head.text === 'import') continue;
    if (tokens[1]?.text === '::') continue; // type signature, opaque

    // find '=' at top level
    const eqIdx = tokens.findIndex((t) => t.kind === 'punct' && t.text === '=');
    if (eqIdx === -1) continue;

    if (head.text === 'system') {
      mod.system = parseSystem(source, decl, tokens, diags, mod.strandedSignals, mod.procSpecs);
      systemTokens = tokens;
      continue;
    }

    // top-level binding: proc spec if RHS head is an actor/delay constructor
    const rhsFirst = tokens[eqIdx + 1];
    if (rhsFirst?.kind === 'ident' && !isConstructor(rhsFirst.text)) {
      const near = nearConstructor(rhsFirst.text);
      if (near) {
        diags.push({
          severity: 'error',
          code: 'unknown-constructor',
          message: `Unknown constructor '${rhsFirst.text}': did you mean ${near}?`,
          span: rhsFirst.span,
        });
        mod.brokenSpecs.add(head.text);
      } else if (mod.system) {
        afterSystem.push({ tokens, span: { from: decl.offset, to: decl.end } });
      }
      continue;
    }
    if (rhsFirst?.kind === 'ident') {
      const c = new Cursor(tokens, eqIdx + 1);
      const etaParams = tokens.slice(1, eqIdx).filter((t) => t.kind === 'ident').length;
      const body = parseProcBody(c, diags, { from: decl.offset, to: decl.end });
      if (body) {
        mod.procSpecs.push({
          name: ident(head),
          body,
          etaParams,
          span: { from: decl.offset, to: decl.end },
        });
        mod.procSpecsEnd = decl.end;
      } else {
        mod.brokenSpecs.add(head.text);
      }
      continue;
    }
  }

  // A top-level decl applying a known process to signals is a where-binding
  // that lost its indentation. ponytail: only spec names count as processes.
  const procNames = new Set([...mod.procSpecs.map((p) => p.name.name), ...mod.brokenSpecs]);
  const unindented: Span[] = [];
  for (const d of afterSystem) {
    const binding = parseBinding(d.tokens, d.span, [], new Set(), []);
    if (!binding || !procNames.has(binding.proc.name)) continue;
    unindented.push(d.span);
    binding.lhs.forEach((l) => mod.strandedSignals.add(l.name));
  }

  const sys = mod.system;
  const hasWhere = systemTokens.some((t) => t.kind === 'ident' && t.text === 'where');
  // a second '=' in the system decl means binding lines follow the output
  const inlineBindings =
    systemTokens.filter((t) => t.kind === 'punct' && t.text === '=').length > 1;
  if (
    sys &&
    !hasWhere &&
    (unindented.length > 0 || inlineBindings) &&
    sys.outputs.some((o) => !sys.params.some((p) => p.name === o.name))
  ) {
    sys.outputs.forEach((o) => mod.strandedSignals.add(o.name));
    diags.push({
      severity: 'error',
      code: 'no-where',
      message:
        "The system's bindings need a 'where' block: system s_in = s_out, then 'where' and the bindings indented below",
      span: systemTokens[0]!.span,
    });
  } else {
    // with no 'where' at all, the no-where error above already covers these lines
    for (const span of unindented) {
      diags.push({
        severity: 'error',
        code: 'unindented-binding',
        message: "This binding is not indented, so it is outside the system's 'where' block",
        span,
      });
    }
  }

  if (!mod.system) {
    diags.push({
      severity: 'error',
      code: 'no-system',
      message: "No 'system' netlist found (the netlist must be named 'system')",
      span: { from: 0, to: 0 },
    });
  }
  return { module: mod, diagnostics: diags };
}
