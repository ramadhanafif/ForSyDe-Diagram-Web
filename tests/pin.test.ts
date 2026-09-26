import { describe, expect, it } from 'vitest';
import { layout } from '../src/layout';
import { pinScene } from '../src/layout/pin';
import { estimateMeasureFor } from '../src/scene/measure';
import type { Pt, Scene } from '../src/scene/types';
import { DEFAULT_FLAGS, loadFixtures } from './helpers/fixtures';

const fixtures = loadFixtures();
const sceneOf = (name: string): Scene => {
  const fx = fixtures.find((f) => f.name === name)!;
  return layout({
    ir: fx.ir,
    schedule: fx.schedule,
    flags: DEFAULT_FLAGS,
    measure: estimateMeasureFor('modern'),
    style: 'modern',
  });
};
const at = (s: Scene) => new Map(s.nodes.map((n) => [n.id, { x: n.box.x, y: n.box.y }]));
// the layout's own coordinates carry float noise (about 1e-13)
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const orthogonal = (pts: Pt[]) =>
  pts.slice(1).every((b, i) => same(b.x, pts[i]!.x) || same(b.y, pts[i]!.y));

describe('pinScene', () => {
  it('leaves a scene alone without positions', () => {
    const s = sceneOf('SDF_example_002');
    expect(pinScene(s, new Map())).toBe(s);
  });

  it('routes every edge orthogonally between its ports, on every fixture', () => {
    for (const fx of fixtures) {
      const s = sceneOf(fx.name);
      // everything pinned where it is, then one node moved well away
      const pos = at(s);
      const moved = s.nodes.find((n) => n.kind !== 'io');
      if (moved) pos.set(moved.id, { x: moved.box.x + 137, y: moved.box.y - 91 });
      const p = pinScene(s, pos);
      const ports = new Map(p.nodes.flatMap((n) => n.ports.map((q) => [q.id, q.at])));
      for (const e of p.edges) {
        expect(orthogonal(e.points), `${fx.name} ${e.id}`).toBe(true);
        const src = ports.get(e.source);
        const tgt = ports.get(e.target);
        if (src) expect(e.points[0], `${fx.name} ${e.id} start`).toEqual(src);
        if (tgt) expect(e.points.at(-1), `${fx.name} ${e.id} end`).toEqual(tgt);
      }
    }
  });

  it('moves a node with its ports and its labels', () => {
    const s = sceneOf('SDF_example_002');
    const n = s.nodes.find((x) => x.id === 'a_c')!;
    const d = { x: 40, y: -25 };
    const p = pinScene(s, new Map([['a_c', { x: n.box.x + d.x, y: n.box.y + d.y }]]));
    const m = p.nodes.find((x) => x.id === 'a_c')!;
    expect(m.box).toEqual({ ...n.box, x: n.box.x + d.x, y: n.box.y + d.y });
    n.ports.forEach((q, i) => expect(m.ports[i]!.at).toEqual({ x: q.at.x + d.x, y: q.at.y + d.y }));
    const own = (sc: Scene) =>
      sc.labels.filter((l) => l.owner === 'a_c' || l.owner.startsWith('a_c.'));
    expect(own(s).length).toBeGreaterThan(0);
    own(s).forEach((l, i) =>
      expect(own(p)[i]!.box).toEqual({ ...l.box, x: l.box.x + d.x, y: l.box.y + d.y }),
    );
    // other nodes stay
    for (const o of s.nodes.filter((x) => x.id !== 'a_c'))
      expect(p.nodes.find((x) => x.id === o.id)!.box).toEqual(o.box);
  });

  it('loops a backward edge below both of its nodes', () => {
    const s = sceneOf('SDF_example_003');
    const pos = at(s);
    // put the consumer of s_1 far left of its producer
    const e = s.edges.find((x) => x.source.startsWith('a_a.out.'))!;
    const tgt = e.target.split('.')[0]!;
    const src = s.nodes.find((n) => n.id === 'a_a')!;
    pos.set(tgt, { x: src.box.x - 300, y: src.box.y });
    const p = pinScene(s, pos);
    const r = p.edges.find((x) => x.id === e.id)!;
    const low = Math.max(...r.points.map((q) => q.y));
    const bottoms = p.nodes
      .filter((n) => n.id === tgt || n.id === 'a_a')
      .map((n) => n.box.y + n.box.h);
    expect(low).toBeGreaterThan(Math.max(...bottoms));
    expect(orthogonal(r.points)).toBe(true);
  });
});
