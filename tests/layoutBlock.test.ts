import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/core/parser';
import { elaborate } from '../src/core/elaborate';
import { parseLayoutBlock, stripLayoutBlock, writeLayoutBlock, type Point } from '../src/core/layoutBlock';

const EXAMPLES = fileURLToPath(new URL('../examples/shallow', import.meta.url));

const SRC = 'module M where\n\nf x = x\n';
const POS = new Map<string, Point>([
  ['mav', { x: 10.4, y: -20.6 }],
  ["s_in'", { x: -3, y: 0 }],
]);

describe('layout block', () => {
  it('writes rounded integers after one blank line', () => {
    expect(writeLayoutBlock(SRC, POS)).toBe(
      "module M where\n\nf x = x\n\n-- @layout mav 10 -21\n-- @layout s_in' -3 0\n",
    );
  });

  it('parses what it writes', () => {
    expect(parseLayoutBlock(writeLayoutBlock(SRC, POS))).toEqual(
      new Map([
        ['mav', { x: 10, y: -21 }],
        ["s_in'", { x: -3, y: 0 }],
      ]),
    );
  });

  it('is idempotent and strips back to the original', () => {
    const once = writeLayoutBlock(SRC, POS);
    expect(writeLayoutBlock(once, POS)).toBe(once);
    expect(stripLayoutBlock(once)).toBe(SRC);
    expect(writeLayoutBlock(SRC, new Map())).toBe(SRC);
  });

  it('keeps trailing blank lines of the original', () => {
    const src = SRC + '\n';
    expect(stripLayoutBlock(writeLayoutBlock(src, POS))).toBe(src);
  });

  it('tolerates CRLF and trailing whitespace', () => {
    const src = 'a = 1\r\n';
    const out = writeLayoutBlock(src, POS);
    expect(out).toBe("a = 1\r\n\r\n-- @layout mav 10 -21\r\n-- @layout s_in' -3 0\r\n");
    expect(parseLayoutBlock(out).get('mav')).toEqual({ x: 10, y: -21 });
    expect(stripLayoutBlock(out)).toBe(src);
    expect(parseLayoutBlock('-- @layout n 1 2   \n  \n').get('n')).toEqual({ x: 1, y: 2 });
    expect(stripLayoutBlock('a = 1\n\n-- @layout n 1 2   \n  \n')).toBe('a = 1\n');
  });

  it('ignores malformed lines but strips them, and reads lines anywhere', () => {
    const src = 'a = 1\n-- @layout mid 5 6\n-- @layout bad 1.5 2\n-- @layout 9x 1 2\n-- @layout\nb = 2\n';
    expect(parseLayoutBlock(src)).toEqual(new Map([['mid', { x: 5, y: 6 }]]));
    expect(stripLayoutBlock(src)).toBe('a = 1\nb = 2\n');
  });

  it('adds a newline to a source that lacks one', () => {
    expect(writeLayoutBlock('a = 1', POS).startsWith('a = 1\n\n-- @layout')).toBe(true);
    expect(stripLayoutBlock(writeLayoutBlock('a = 1', POS))).toBe('a = 1\n');
  });

  it('handles an empty source', () => {
    const out = writeLayoutBlock('', POS);
    expect(out.startsWith('-- @layout')).toBe(true);
    expect(stripLayoutBlock(out)).toBe('');
  });
});

describe('layout block over bundled examples', () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.hs'));
  expect(files.length).toBeGreaterThan(30);

  for (const file of files) {
    it(file, () => {
      const src = readFileSync(join(EXAMPLES, file), 'utf8');
      const before = elaborate(parse(src).module);
      expect(before.ir).not.toBeNull();
      const positions = new Map(before.ir!.processes.map((p, i) => [p.name, { x: i * 100, y: 50 - i * 30 }]));
      const out = writeLayoutBlock(src, positions);

      expect(stripLayoutBlock(out)).toBe(src);
      expect(writeLayoutBlock(out, positions)).toBe(out);
      expect(parseLayoutBlock(out)).toEqual(positions);

      const parsed = parse(out);
      expect(parsed.diagnostics).toEqual(parse(src).diagnostics);
      expect(elaborate(parsed.module)).toEqual(before);
    });
  }
});
