import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../examples/shallow', import.meta.url));

const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.hs'))
  .sort();

describe('fixture drift from examples/shallow', () => {
  expect(names.length).toBeGreaterThan(30);

  for (const name of names) {
    it(`${name} is byte-identical`, () => {
      const fixture = readFileSync(join(FIXTURES, name));
      const example = readFileSync(join(EXAMPLES, name));
      expect(fixture.equals(example)).toBe(true);
    });
  }
});
