/**
 * Offset of the line-start definition `fn` in doc text: the first index where
 * fn starts a line and is followed by a non-identifier character, or -1.
 * Plain indexOf scanning — fn is user input and must never become a RegExp.
 */
export function findDefinitionOffset(doc: string, fn: string): number {
  if (!fn) return -1;
  let from = 0;
  for (;;) {
    const idx = doc.indexOf(fn, from);
    if (idx < 0) return -1;
    const atLineStart = idx === 0 || doc[idx - 1] === '\n';
    const next = doc[idx + fn.length] ?? '';
    if (atLineStart && !/[A-Za-z0-9_']/.test(next)) return idx;
    from = idx + fn.length;
  }
}

/**
 * Split an identifier into base + subscript at the first underscore:
 * "s_in_1" -> ["s", "in,1"] (later underscores become commas).
 * Returns null when there is no usable subscript part: no underscore,
 * a leading underscore (empty base), or a trailing underscore (empty sub).
 */
export function splitSubscript(name: string): [base: string, sub: string] | null {
  const idx = name.indexOf('_');
  if (idx <= 0 || idx === name.length - 1) return null;
  return [name.slice(0, idx), name.slice(idx + 1).replace(/_/g, ',')];
}
