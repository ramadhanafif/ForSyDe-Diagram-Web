import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/core/parser';
import { elaborate } from '../src/core/elaborate';
import { irToParityJson } from '../src/core/ir';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

/** Examples the playground subset intentionally rejects. Should stay empty. */
const SKIP: Record<string, string> = {};

interface ParityProcess {
  type: string;
  name: string;
  function?: string;
  tokens?: number[];
}
interface ParitySignal {
  name: string;
  source: { name: string; rate: number };
  target: { name: string; rate: number };
}
interface ParitySystem {
  system: {
    inputs: string[];
    outputs: string[];
    processes: ParityProcess[];
    signals: ParitySignal[];
  };
}

/** Order-insensitive normalization: processes and signals keyed by name. */
function normalize(json: ParitySystem) {
  const sys = json.system;
  return {
    inputs: [...sys.inputs].sort(),
    outputs: [...sys.outputs].sort(),
    processes: Object.fromEntries(
      sys.processes.map((p) => [
        p.name,
        p.type === 'Delay'
          ? { type: p.type, tokens: p.tokens ?? [] }
          : { type: p.type, function: p.function },
      ]),
    ),
    signals: Object.fromEntries(sys.signals.map((s) => [s.name, { source: s.source, target: s.target }])),
  };
}

const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.ir.json'))
  .map((f) => f.replace(/\.ir\.json$/, ''));

describe('parser parity with forsyde-compiler-exe', () => {
  expect(names.length).toBeGreaterThan(30);

  for (const name of names) {
    const skipReason = SKIP[name];
    (skipReason ? it.skip : it)(`${name}${skipReason ? ` (${skipReason})` : ''}`, () => {
      const source = readFileSync(join(FIXTURES, `${name}.hs`), 'utf8');
      const expected = JSON.parse(
        readFileSync(join(FIXTURES, `${name}.ir.json`), 'utf8'),
      ) as ParitySystem;

      const { module: mod, diagnostics: parseDiags } = parse(source);
      expect(parseDiags.filter((d) => d.severity === 'error')).toEqual([]);
      const { ir, diagnostics: elabDiags } = elaborate(mod);
      expect(elabDiags.filter((d) => d.severity === 'error')).toEqual([]);
      expect(ir).not.toBeNull();

      expect(normalize(irToParityJson(ir!) as ParitySystem)).toEqual(normalize(expected));
    });
  }
});
