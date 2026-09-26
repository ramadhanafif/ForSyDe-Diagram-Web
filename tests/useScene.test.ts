import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeModel, EMPTY_SCENE_STATE } from '../src/app/useScene';
import { sceneLabels } from '../src/scene/labels';
import { canvasMeasure, estimateMeasure } from '../src/scene/measure';
import { validateScene } from '../src/scene/validate';
import { DEFAULT_FLAGS } from './helpers/fixtures';

const src = readFileSync(new URL('../fixtures/SDF_example_026.hs', import.meta.url), 'utf8');
const measure = estimateMeasure;

describe('computeModel', () => {
  it('lays out a valid source into a scene the validator accepts', () => {
    const s = computeModel(src, DEFAULT_FLAGS, measure, EMPTY_SCENE_STATE);
    expect(s.stale).toBe(false);
    expect(s.errorCount).toBe(0);
    const m = s.model!;
    expect(m.source).toBe(src);
    expect(s.schedule).toBe(m.schedule);
    expect([...m.edgeSignals.keys()].sort()).toEqual(m.scene.edges.map((e) => e.id).sort());
    expect(m.meta.nodes.get('a_2')?.repetitions).toBeGreaterThan(0);
    const ctx = { schedule: m.schedule, flags: DEFAULT_FLAGS, measure };
    expect(validateScene(m.scene, m.ir, ctx)).toEqual([]);
  });

  it('keeps the last good model, marked stale, while the source has errors', () => {
    const good = computeModel(src, DEFAULT_FLAGS, measure, EMPTY_SCENE_STATE);
    const bad = computeModel(
      src.replace('s_3 = a_2 s_1', 's_3 = a_2 ('),
      DEFAULT_FLAGS,
      measure,
      good,
    );
    expect(bad.stale).toBe(true);
    expect(bad.errorCount).toBeGreaterThan(0);
    expect(bad.model).toBe(good.model);
    const fixed = computeModel(src, DEFAULT_FLAGS, measure, bad);
    expect(fixed.stale).toBe(false);
    expect(fixed.model!.scene.nodes).toEqual(good.model!.scene.nodes);
  });

  it('re-lays out for new flags: hidden labels are absent', () => {
    const flags = { ...DEFAULT_FLAGS, rates: false, signals: false };
    const s = computeModel(src, flags, measure, EMPTY_SCENE_STATE);
    expect(s.model!.scene.labels.filter((l) => l.kind === 'rate' || l.kind === 'signal')).toEqual(
      [],
    );
  });
});

describe('sceneLabels', () => {
  it('keeps rates out of the stack', () => {
    const s = computeModel(src, DEFAULT_FLAGS, measure, EMPTY_SCENE_STATE).model!;
    const stack = (owner: string) =>
      sceneLabels(s.ir, s.schedule, DEFAULT_FLAGS).find(
        (l) => l.kind === 'stack' && l.owner === owner,
      )?.text;
    expect(stack('a_1')).toBe('actor22SDF\nf_1');
    expect(stack('d_1')).toBe('delaySDF\n[0]');
  });
});

describe('canvasMeasure', () => {
  it('falls back to the estimate without a DOM', () => {
    const m = canvasMeasure('lecture');
    expect(m('a_1', 'name')).toEqual(estimateMeasure('a_1', 'name'));
  });
});
