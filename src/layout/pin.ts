import type { Point } from '../core/layoutBlock';
import { contentBox, drawnPoints } from '../scene/metrics';
import type { Pt, Scene, SceneLabel, SceneNode } from '../scene/types';

/**
 * The scene with user-placed nodes: every node in `positions` (its top-left
 * corner) moves there with its ports and the labels that belong to it, and
 * every edge is re-routed orthogonally between the moved ports. The layout's
 * own routing assumes its layers, which dragged nodes no longer respect, so
 * pinned edges take the plain route: out of the port, one vertical run, into
 * the port, or round below both nodes when the target is not to the right.
 *
 * Unlike the layout, this does not keep labels clear of every edge: a
 * heavily dragged diagram can cross itself. Tidy is the fix.
 */

/** Minimum straight run out of a port before an edge may turn. */
const STUB = 12;
/** Clearance kept past the labels riding a port stub. */
const STUB_PAD = 6;
/** How far below the lower of two nodes a backward edge loops round. */
const LOOP_GAP = 24;

const shift = (p: Pt, d: Pt): Pt => ({ x: p.x + d.x, y: p.y + d.y });

/** Where an edge label was laid out: riding the source port's stub, else the target's. */
function riderEnd(l: SceneLabel, s: Pt, t: Pt): 'source' | 'target' {
  const cx = l.box.x + l.box.w / 2;
  return Math.abs(cx - s.x) <= Math.abs(cx - t.x) ? 'source' : 'target';
}

export function pinScene(scene: Scene, positions: Map<string, Point>): Scene {
  if (!positions.size) return scene;
  const delta = new Map<string, Pt>();
  for (const n of scene.nodes) {
    const p = positions.get(n.id);
    if (p) delta.set(n.id, { x: p.x - n.box.x, y: p.y - n.box.y });
  }
  const zero = { x: 0, y: 0 };
  const moveOf = (node: string) => delta.get(node) ?? zero;

  const nodes: SceneNode[] = scene.nodes.map((n) => {
    const d = moveOf(n.id);
    return {
      ...n,
      box: { ...n.box, x: n.box.x + d.x, y: n.box.y + d.y },
      ports: n.ports.map((q) => ({ ...q, at: shift(q.at, d) })),
    };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const portNode = new Map(scene.nodes.flatMap((n) => n.ports.map((q) => [q.id, n.id])));
  /** The node a port or io reference belongs to. */
  const nodeOfRef = (ref: string) => portNode.get(ref) ?? ref;

  // edge labels ride a stub: they move with that end's node
  const riders = new Map<string, string>();
  for (const e of scene.edges) {
    const s = e.points[0]!;
    const t = e.points[e.points.length - 1]!;
    for (const l of scene.labels)
      if (l.owner === e.id)
        riders.set(l.id, nodeOfRef(riderEnd(l, s, t) === 'source' ? e.source : e.target));
  }
  const labels: SceneLabel[] = scene.labels.map((l) => {
    const node = riders.get(l.id) ?? nodeOfRef(l.owner);
    const d = moveOf(node);
    return { ...l, box: { ...l.box, x: l.box.x + d.x, y: l.box.y + d.y } };
  });

  /** How far the labels riding a stub reach from its port, so the edge turns past them. */
  const reach = (ref: string, at: Pt, dir: 1 | -1, edgeId: string) => {
    let far = STUB;
    for (const l of labels) {
      const mine = l.owner === ref || (l.owner === edgeId && riders.get(l.id) === nodeOfRef(ref));
      if (!mine || l.kind === 'name' || l.kind === 'badge' || l.kind === 'stack') continue;
      const edge = dir === 1 ? l.box.x + l.box.w - at.x : at.x - l.box.x;
      far = Math.max(far, edge + STUB_PAD);
    }
    return far;
  };

  const edges = scene.edges.map((e) => {
    const src = nodeById.get(nodeOfRef(e.source));
    const tgt = nodeById.get(nodeOfRef(e.target));
    const s = shift(e.points[0]!, moveOf(nodeOfRef(e.source)));
    const t = shift(e.points[e.points.length - 1]!, moveOf(nodeOfRef(e.target)));
    const out = s.x + reach(e.source, s, 1, e.id);
    const into = t.x - reach(e.target, t, -1, e.id);
    let points: Pt[];
    if (into >= out) {
      // forward with room: turn once, past the labels riding either stub
      const mid = Math.min(into, Math.max(out, (s.x + t.x) / 2));
      points = [s, { x: mid, y: s.y }, { x: mid, y: t.y }, t];
    } else if (t.x - s.x >= 2 * STUB) {
      // forward but the labels fill the gap: turn half way, across them if it must
      // (a loop round the nodes would be longer and cross more)
      const mid = (s.x + t.x) / 2;
      points = [s, { x: mid, y: s.y }, { x: mid, y: t.y }, t];
    } else {
      // backward (or overlapping): round below both nodes
      const bottom = Math.max(
        (src?.box.y ?? s.y) + (src?.box.h ?? 0),
        (tgt?.box.y ?? t.y) + (tgt?.box.h ?? 0),
        s.y,
        t.y,
      );
      const low = bottom + LOOP_GAP;
      points = [
        s,
        { x: out, y: s.y },
        { x: out, y: low },
        { x: into, y: low },
        { x: into, y: t.y },
        t,
      ];
    }
    return { ...e, points: drawnPoints(points) };
  });

  return {
    nodes,
    edges,
    labels,
    bounds: contentBox(
      nodes,
      labels,
      edges.map((e) => e.points),
    ),
  };
}
