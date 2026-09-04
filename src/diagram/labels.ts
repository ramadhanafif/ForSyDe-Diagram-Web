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
