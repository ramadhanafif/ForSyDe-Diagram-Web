import type {
  ActorType,
  Diagnostic,
  HsModule,
  Ident,
  ProcBody,
  RateLit,
  Span,
  SystemDecl,
  WhereBinding,
} from './ast';
import { tokenize, type Token } from './lexer';

const ACTOR_RE = /^actor([1-4])([1-4])SDF$/;

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

/** Parse a rate argument: bare int or tuple of ints. */
function parseRates(c: Cursor): RateLit[] | null {
  const t = c.peek();
  if (t?.kind === 'int') {
    c.next();
    return [{ value: parseInt(t.text, 10), span: t.span }];
  }
  if (c.atPunct('(')) {
    c.next();
    const rates: RateLit[] = [];
    while (c.peek()?.kind === 'int') {
      const tok = c.next()!;
      rates.push({ value: parseInt(tok.text, 10), span: tok.span });
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
    const inRates = parseRates(c);
    const outRates = parseRates(c);
    const fnTok = c.atIdent() ? c.next()! : null;
    for (const r of [...(inRates ?? []), ...(outRates ?? [])]) {
      if (r.value < 1) {
        diags.push({
          severity: 'error',
          code: 'bad-rate',
          message: `Rates must be positive integers, got ${r.value}`,
          span: r.span,
        });
        return null;
      }
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
      while (c.peek()?.kind === 'int') {
        tokens.push(parseInt(c.next()!.text, 10));
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
      const binding = parseBinding(btokens, { from: g.from, to: g.to }, diags);
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

function parseBinding(tokens: Token[], span: Span, diags: Diagnostic[]): WhereBinding | null {
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
  const procTok = c.atIdent() ? c.next()! : null;
  if (!procTok) {
    diags.push({
      severity: 'error',
      code: 'bad-binding',
      message: 'Expected a process name on the right-hand side',
      span,
    });
    return null;
  }
  if (ACTOR_RE.test(procTok.text) || procTok.text === 'delaySDF') {
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
    diags.push({
      severity: 'error',
      code: 'unsupported-binding',
      message: 'Only applications of a named process to signal names are supported here',
      span: c.peek()!.span,
    });
    return null;
  }
  return { lhs, proc: ident(procTok), args, span };
}

export function parse(source: string): { module: HsModule; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const mod: HsModule = {
    moduleName: null,
    system: null,
    procSpecs: [],
    otherBindings: [],
    procSpecsEnd: source.length,
  };

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
      mod.system = parseSystem(source, decl, tokens, diags);
      continue;
    }

    // top-level binding: proc spec if RHS head is an actor/delay constructor
    const rhsHead = tokens
      .slice(eqIdx + 1)
      .find((t) => t.kind === 'ident' && (ACTOR_RE.test(t.text) || t.text === 'delaySDF'));
    const rhsFirst = tokens[eqIdx + 1];
    if (rhsHead && rhsFirst && rhsHead.span.from === rhsFirst.span.from) {
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
      }
      continue;
    }

    mod.otherBindings.push(head.text);
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
