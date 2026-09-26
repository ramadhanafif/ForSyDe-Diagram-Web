/**
 * Node positions persisted inside a `.hs` file as a trailing comment block:
 *
 *     -- @layout <id> <x> <y>
 *
 * One line per node, integer coordinates, preceded by one blank line. GHC
 * ignores comments, so exported files still compile. Parsing accepts layout
 * lines anywhere; writing removes all of them and appends a fresh block.
 */
export interface Point {
  x: number;
  y: number;
}

/** Well-formed layout line. `\r?` tolerates CRLF sources split on `\n`. */
const LAYOUT_LINE_RE = /^[ \t]*--[ \t]*@layout[ \t]+([A-Za-z_][A-Za-z0-9_']*)[ \t]+(-?\d+)[ \t]+(-?\d+)[ \t]*\r?$/;
/** Any layout line, well-formed or not; these are what strip removes. */
const ANY_LAYOUT_RE = /^[ \t]*--[ \t]*@layout(\s|$)/;

const isBlank = (line: string) => line.trim() === '';

const MAX_COORD = 1e6;

/** Later lines win for a repeated id; malformed lines and |x| or |y| above 1e6 are ignored. */
export function parseLayoutBlock(source: string): Map<string, Point> {
  const positions = new Map<string, Point>();
  for (const line of source.split('\n')) {
    const m = LAYOUT_LINE_RE.exec(line);
    if (!m) continue;
    const x = Number(m[2]);
    const y = Number(m[3]);
    // far beyond any diagram: fit-to-view and PNG export would break on it
    if (Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD) positions.set(m[1]!, { x, y });
  }
  return positions;
}

/**
 * Remove every layout line. A trailing block also takes the blank separator
 * line `writeLayoutBlock` put before it, so strip(write(s, p)) === s for any
 * `s` that ends with a newline.
 */
export function stripLayoutBlock(source: string): string {
  const lines = source.split('\n');
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1]!)) end--;
  let start = end;
  while (start > 0 && ANY_LAYOUT_RE.test(lines[start - 1]!)) start--;
  if (start === end) return lines.filter((l) => !ANY_LAYOUT_RE.test(l)).join('\n');
  if (start > 0 && isBlank(lines[start - 1]!)) start--;
  if (start === 0) return '';
  return lines.slice(0, start).filter((l) => !ANY_LAYOUT_RE.test(l)).join('\n') + '\n';
}

/**
 * Strip, then append a fresh block (coordinates rounded). An empty map yields
 * the stripped source. Line endings follow the source's.
 * ponytail: a source without a trailing newline gains one on the round trip;
 * the separator is ambiguous otherwise.
 */
export function writeLayoutBlock(source: string, positions: Map<string, Point>): string {
  const base = stripLayoutBlock(source);
  if (positions.size === 0) return base;
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  const sep = base === '' ? '' : base.endsWith('\n') ? eol : eol + eol;
  const lines = [...positions].map(([id, p]) => `-- @layout ${id} ${Math.round(p.x)} ${Math.round(p.y)}`);
  return base + sep + lines.join(eol) + eol;
}
