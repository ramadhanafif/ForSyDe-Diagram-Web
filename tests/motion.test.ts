import { describe, expect, it } from 'vitest';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { computeScheduleAndBuffers } from '../src/core/schedule';
import { layout } from '../src/layout';
import {
  ease,
  lengthAt,
  morph,
  pathLength,
  pointAtLength,
  resample,
  scaleScene,
  tweenScene,
} from '../src/render/motion';
import { estimateMeasureFor } from '../src/scene/measure';
import type { Rect, Scene } from '../src/scene/types';
import { DEFAULT_FLAGS } from './helpers/fixtures';

const MODEL = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor11SDF 1 2 f
d_d = delaySDF [0]
a_b = actor11SDF 2 1 g
`;

// a_c inserted on s_1, d_d deleted: a_b moves, a_c enters, d_d exits
const EDITED = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = a_c s_1
    s_out = a_b s_2
a_a = actor11SDF 1 2 f
a_c = actor11SDF 1 1 h
a_b = actor11SDF 2 1 g
`;

function sceneOf(src: string, prev?: Scene): Scene {
  const { ir } = elaborate(parse(src).module);
  if (!ir) throw new Error('model does not elaborate');
  const schedule = computeScheduleAndBuffers(ir);
  return layout({
    ir,
    schedule,
    flags: DEFAULT_FLAGS,
    measure: estimateMeasureFor('modern'),
    style: 'modern',
    prev,
  });
}

const between = (v: number, a: number, b: number) =>
  v >= Math.min(a, b) - 1e-9 && v <= Math.max(a, b) + 1e-9;
const inside = (r: Rect, a: Rect, b: Rect) =>
  between(r.x, a.x, b.x) && between(r.y, a.y, b.y) && between(r.w, a.w, b.w);

describe('ease', () => {
  it('is exact at the ends, monotonic and symmetric', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    for (let t = 0; t < 1; t += 0.05) expect(ease(t + 0.05)).toBeGreaterThanOrEqual(ease(t));
    expect(ease(0.2) + ease(0.8)).toBeCloseTo(1);
  });
});

describe('polylines', () => {
  const L = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
  ];
  it('measure length and points along it, clamped', () => {
    expect(pathLength(L)).toBe(15);
    expect(pointAtLength(L, 4)).toEqual({ x: 4, y: 0 });
    expect(pointAtLength(L, 12)).toEqual({ x: 10, y: 2 });
    expect(pointAtLength(L, -3)).toEqual({ x: 0, y: 0 });
    expect(pointAtLength(L, 99)).toEqual({ x: 10, y: 5 });
    expect(lengthAt(L, { x: 4, y: 3 })).toBe(4);
    expect(lengthAt(L, { x: 14, y: 3 })).toBe(13);
  });

  it('resample repeats vertices and keeps the ends', () => {
    const r = resample(L, 5);
    expect(r).toHaveLength(5);
    expect(r[0]).toBe(L[0]);
    expect(r[4]).toBe(L[2]);
    expect(new Set(r)).toEqual(new Set(L));
    expect(resample(L, 2)).toBe(L);
  });

  it('morph has the longer point count and hits both ends exactly', () => {
    const S = [
      { x: 0, y: 0.1 },
      { x: 20, y: 0.3 },
    ];
    expect(morph(S, L, 0)).toHaveLength(3);
    expect(morph(S, L, 1)).toEqual(L);
    expect(morph(L, S, 1)).toEqual([S[0], S[1], S[1]]);
    const m = morph(S, L, 0.5);
    expect(m[0]!.y).toBeCloseTo(0.05);
    expect(m[2]!.x).toBeCloseTo(15);
    expect(m[2]!.y).toBeCloseTo(2.65);
  });
});

describe('tweenScene', () => {
  const a = sceneOf(MODEL);
  const b = sceneOf(EDITED, a);

  it('is exactly from at 0 and deep-equal to to at 1', () => {
    expect(tweenScene(a, b, 0)).toBe(a);
    expect(tweenScene(a, b, 1)).toEqual(b);
    // just short of the end, only exiting elements and rounding separate it from `to`
    const near = tweenScene(a, b, 1 - 1e-12);
    expect(near.nodes.slice(0, b.nodes.length).map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
  });

  it('moves surviving nodes, ports, labels and bounds between their two places', () => {
    const mid = tweenScene(a, b, 0.5);
    const moved = b.nodes.filter((n) => {
      const was = a.nodes.find((m) => m.id === n.id);
      return was && was.box.x !== n.box.x;
    });
    expect(moved.map((n) => n.id)).toContain('a_b');
    for (const n of b.nodes) {
      const was = a.nodes.find((m) => m.id === n.id);
      if (!was) continue;
      const got = mid.nodes.find((m) => m.id === n.id)!;
      expect(inside(got.box, was.box, n.box)).toBe(true);
      for (const p of n.ports) {
        const q = was.ports.find((r) => r.id === p.id);
        const g = got.ports.find((r) => r.id === p.id)!;
        if (q)
          expect(between(g.at.x, q.at.x, p.at.x) && between(g.at.y, q.at.y, p.at.y)).toBe(true);
      }
    }
    for (const l of b.labels) {
      const was = a.labels.find((m) => m.id === l.id);
      if (was)
        expect(inside(mid.labels.find((m) => m.id === l.id)!.box, was.box, l.box)).toBe(true);
    }
    expect(inside(mid.bounds, a.bounds, b.bounds)).toBe(true);
  });

  it('morphs matched edges from the source end to the target end', () => {
    const mid = tweenScene(a, b, 0.5);
    for (const e of b.edges) {
      const was = a.edges.find((f) => f.id === e.id);
      if (!was) continue;
      const got = mid.edges.find((f) => f.id === e.id)!;
      expect(got.points).toHaveLength(Math.max(was.points.length, e.points.length));
      expect(got.points[0]!.x).toBeCloseTo((was.points[0]!.x + e.points[0]!.x) / 2);
    }
  });

  it('grows entering and shrinks exiting elements about their centres', () => {
    const q = tweenScene(a, b, 0.25);
    const entering = q.nodes.find((n) => n.id === 'a_c')!;
    const final = b.nodes.find((n) => n.id === 'a_c')!;
    expect(entering.box.w).toBeCloseTo(final.box.w * 0.25);
    expect(entering.box.x + entering.box.w / 2).toBeCloseTo(final.box.x + final.box.w / 2);
    const exiting = q.nodes.find((n) => n.id === 'd_d')!;
    const was = a.nodes.find((n) => n.id === 'd_d')!;
    expect(exiting.box.w).toBeCloseTo(was.box.w * 0.75);
    // exiting elements come after the target's own, edges included
    expect(q.nodes.slice(0, b.nodes.length).map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(q.edges.some((e) => e.id === 'e_s_2_d_d_a_b')).toBe(true);
    expect(tweenScene(a, b, 1).nodes.some((n) => n.id === 'd_d')).toBe(false);
  });

  it('scaleScene maps every coordinate, so a rebased transition keeps its screen path', () => {
    // view 0: k 2, t (10, 0); view 1: k 1, t (0, 0); rebase maps p -> p * 2 + (10, 0)
    const m = scaleScene(a, 2, { x: 10, y: 0 });
    const i = a.nodes.findIndex((q) => q.id === 'a_a');
    const n = a.nodes[i]!;
    const got = m.nodes[i]!;
    expect(got.box).toEqual({
      x: n.box.x * 2 + 10,
      y: n.box.y * 2,
      w: n.box.w * 2,
      h: n.box.h * 2,
    });
    expect(got.ports[0]!.at).toEqual({ x: n.ports[0]!.at.x * 2 + 10, y: n.ports[0]!.at.y * 2 });
    expect(m.edges[0]!.points[0]!.x).toBe(a.edges[0]!.points[0]!.x * 2 + 10);
    expect(m.labels[0]!.box.w).toBe(a.labels[0]!.box.w * 2);
    expect(m.bounds.x).toBe(a.bounds.x * 2 + 10);
    // on screen (view 1) the start of the rebased tween is where view 0 drew `a`
    expect(tweenScene(m, b, 0).nodes[i]!.box.x).toBe(n.box.x * 2 + 10);
  });
});
