import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { estimateMeasureFor } from '../../src/scene/measure';
import { scoreScene, type Metrics } from '../../src/scene/metrics';
import type { DiagramStyle, LabelFlags, Layout } from '../../src/scene/types';
import { validateScene } from '../../src/scene/validate';
import { ALL_FLAGS, DEFAULT_FLAGS, loadFixtures } from './fixtures';

export const OUT_DIR = fileURLToPath(new URL('../../layout-out', import.meta.url));

export interface RunRef {
  fixture: string;
  flags: LabelFlags;
}

export interface Evaluation {
  /** Metrics per fixture with DEFAULT_FLAGS. */
  perFixture: Record<string, Metrics>;
  /** Summed over every fixture x flag set run. */
  totals: Metrics;
  runs: number;
  errors: (RunRef & { errors: string[] })[];
  /** Per call, after one untimed warm-up pass, so JIT and module setup are not counted. */
  ms: { avg: number; max: number };
  /**
   * Runs where the same input gave different scenes: twice in a row, or (for
   * DEFAULT_FLAGS) in the sweep versus the warm-up pass, which ran before the
   * other fixtures and catches state leaking from one call into the next.
   */
  nondeterministic: RunRef[];
}

export const ZERO_METRICS: Metrics = {
  labelLabel: 0,
  labelNode: 0,
  labelEdge: 0,
  edgeNode: 0,
  edgeEdgeOverlap: 0,
  overlaps: 0,
  crossings: 0,
  bends: 0,
  area: 0,
};

export function addMetrics(a: Metrics, b: Metrics): Metrics {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof Metrics)[]) out[k] += b[k];
  return out;
}

/**
 * Run the layout over every fixture x flag set (all 128 unless given) in one
 * style (lecture unless given); DEFAULT_FLAGS always runs.
 */
export function evaluateLayout(
  layout: Layout,
  opts?: { flags?: LabelFlags[]; style?: DiagramStyle },
): Evaluation {
  const style = opts?.style ?? 'lecture';
  const measure = estimateMeasureFor(style);
  const given = opts?.flags ?? ALL_FLAGS;
  const flagSets = given.some((f) => isDeepStrictEqual(f, DEFAULT_FLAGS))
    ? given
    : [DEFAULT_FLAGS, ...given];
  const result: Evaluation = {
    perFixture: {},
    totals: { ...ZERO_METRICS },
    runs: 0,
    errors: [],
    ms: { avg: 0, max: 0 },
    nondeterministic: [],
  };
  let msSum = 0;
  let calls = 0;
  const timed = (input: Parameters<Layout>[0]) => {
    const t0 = performance.now();
    const scene = layout(input);
    const dt = performance.now() - t0;
    msSum += dt;
    calls++;
    result.ms.max = Math.max(result.ms.max, dt);
    return scene;
  };

  const fixtures = loadFixtures();
  const inputOf = (fx: (typeof fixtures)[number], flags: LabelFlags) => ({
    ir: fx.ir,
    schedule: fx.schedule,
    flags,
    measure,
    style,
  });
  const warm = new Map(fixtures.map((fx) => [fx.name, layout(inputOf(fx, DEFAULT_FLAGS))]));

  for (const fx of fixtures) {
    for (const flags of flagSets) {
      const scene = timed(inputOf(fx, flags));
      const isDefault = isDeepStrictEqual(flags, DEFAULT_FLAGS);
      if (
        !isDeepStrictEqual(scene, timed(inputOf(fx, flags))) ||
        (isDefault && !isDeepStrictEqual(scene, warm.get(fx.name)))
      )
        result.nondeterministic.push({ fixture: fx.name, flags });
      const m = scoreScene(scene);
      result.totals = addMetrics(result.totals, m);
      result.runs++;
      if (isDefault) result.perFixture[fx.name] = m;
      const errors = validateScene(scene, fx.ir, {
        schedule: fx.schedule,
        flags,
        measure,
        style,
      });
      if (errors.length) result.errors.push({ fixture: fx.name, flags, errors });
    }
  }
  result.ms.avg = calls ? msSum / calls : 0;
  return result;
}

/** layout-out/<name>/report.json */
export function writeReport(name: string, result: unknown): string {
  const dir = join(OUT_DIR, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return file;
}
