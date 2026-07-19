import type { Span } from './ast';

export type TokenKind = 'ident' | 'int' | 'punct' | 'op';

export interface Token {
  kind: TokenKind;
  text: string;
  span: Span;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_.']/;

/**
 * Tokenize a source region. Comments are skipped. Unknown characters become
 * 'op' tokens so opaque declarations can be scanned without errors.
 */
export function tokenize(source: string, offset = 0, end = source.length): Token[] {
  const tokens: Token[] = [];
  let i = offset;
  while (i < end) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // line comment
    if (c === '-' && source[i + 1] === '-') {
      while (i < end && source[i] !== '\n') i++;
      continue;
    }
    // block comment (no nesting needed for the subset)
    if (c === '{' && source[i + 1] === '-') {
      const close = source.indexOf('-}', i + 2);
      i = close === -1 ? end : close + 2;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < end && IDENT_CHAR.test(source[i]!)) i++;
      tokens.push({ kind: 'ident', text: source.slice(start, i), span: { from: start, to: i } });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < end && /[0-9]/.test(source[i]!)) i++;
      tokens.push({ kind: 'int', text: source.slice(start, i), span: { from: start, to: i } });
      continue;
    }
    // negative integer literal (only valid where a literal is expected;
    // the parser decides, the lexer just glues '-' to digits)
    if (c === '-' && /[0-9]/.test(source[i + 1] ?? '')) {
      const start = i;
      i++;
      while (i < end && /[0-9]/.test(source[i]!)) i++;
      tokens.push({ kind: 'int', text: source.slice(start, i), span: { from: start, to: i } });
      continue;
    }
    if ('()[],='.includes(c)) {
      // '=' might be '==' or '=>', treat those as op
      if (c === '=' && (source[i + 1] === '=' || source[i + 1] === '>')) {
        tokens.push({ kind: 'op', text: source.slice(i, i + 2), span: { from: i, to: i + 2 } });
        i += 2;
        continue;
      }
      tokens.push({ kind: 'punct', text: c, span: { from: i, to: i + 1 } });
      i++;
      continue;
    }
    if (c === ':' && source[i + 1] === ':') {
      tokens.push({ kind: 'op', text: '::', span: { from: i, to: i + 2 } });
      i += 2;
      continue;
    }
    // anything else (operators, backticks, string chars...), single-char op
    tokens.push({ kind: 'op', text: c, span: { from: i, to: i + 1 } });
    i++;
  }
  return tokens;
}
