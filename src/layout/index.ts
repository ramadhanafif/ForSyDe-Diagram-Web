import type {
  DiagramStyle,
  Layout,
  Measure,
  Pt,
  Scene,
  SceneEdge,
  SceneLabel,
  SceneNode,
} from '../scene/types';
import { contentBox, drawnPoints } from '../scene/metrics';
import { sceneLabels, type ExpectedLabel } from '../scene/labels';
import { geometry, ioKey, PITCH, type Geom } from './geometry';
import { buildGraph, type GEdge, type Graph } from './graph';
import { orderLayers, type End, type Item, type Piece } from './order';
import { IO_SEP, placeY } from './place';
import { routeGap, type GapRoute } from './route';

/**
 * Layered (Sugiyama) layout, left to right:
 *
 * 1. graph.ts breaks cycles at the edges leaving a delay and assigns layers.
 * 2. geometry.ts sizes every node around its labels.
 * 3. Long edges become one dummy item per layer they pass; a feedback edge
 *    runs back through every layer between its ends, with a hook in the gap
 *    where it turns.
 * 4. order.ts orders each layer to minimise crossings, place.ts assigns y,
 *    route.ts gives each bent piece a vertical track in its gap.
 * 5. Columns and gaps get their widths here, and the scene is assembled.
 */

const TRACK_SP = 12;
const MIN_TRACK_ZONE = 20;
const ZONE_PAD = 4;

const srcKey = (g: Graph, e: GEdge) => (g.ports.has(e.source) ? e.source : ioKey(e.from, 'E'));
const tgtKey = (g: Graph, e: GEdge) => (g.ports.has(e.target) ? e.target : ioKey(e.to, 'W'));

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * The labels to place, split into rows riding a stub (keyed like
 * Geom.attach) and labels owned by a node. Which labels exist and what they
 * say is the validator's call, so the two cannot drift apart.
 */
function distributeLabels(g: Graph, labels: ExpectedLabel[]) {
  // two edges can leave one port (a signal consumed and also a system
  // output); the second one carries its names at its target instead
  const slot = new Map<string, string>();
  const used = new Set<string>();
  for (const e of g.edges) {
    const s = srcKey(g, e);
    slot.set(e.id, used.has(s) ? tgtKey(g, e) : s);
    used.add(s);
  }
  const rows = new Map<string, ExpectedLabel[]>();
  const byNode = new Map<string, ExpectedLabel[]>();
  const seen = new Set<string>();
  for (const l of labels) {
    const key = `${l.kind} ${l.owner} ${l.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (l.kind === 'rate') {
      const io = g.nodes.get(l.owner);
      push(rows, g.ports.has(l.owner) ? l.owner : ioKey(l.owner, io?.input ? 'E' : 'W'), l);
    } else if (l.kind === 'signal' || l.kind === 'buffer') {
      const s = slot.get(l.owner);
      if (s) push(rows, s, l);
    } else push(byNode, l.owner, l);
  }
  return { rows, byNode };
}

function geometries(
  g: Graph,
  labels: ReturnType<typeof distributeLabels>,
  measure: Measure,
  style: DiagramStyle,
) {
  const geo = new Map<string, Geom>();
  const nodes = [...g.nodes.values()];
  for (const n of nodes)
    if (n.kind === 'io')
      geo.set(n.id, geometry(n, labels.byNode.get(n.id) ?? [], labels.rows, measure));
  // A node side wired only to io pills spaces its ports like stacked pills,
  // so every pill sits level with its port (taken from the grid-search
  // candidate: it straightens the input fans of 004, 008, 010, 015 to 019).
  const pitch = (ends: string[]) => {
    if (ends.length < 2 || ends.some((id) => g.nodes.get(id)!.kind !== 'io')) return PITCH;
    const pills = ends.map((id) => geo.get(id)!);
    const below = Math.max(...pills.map((p) => p.bottom));
    const above = Math.max(...pills.map((p) => -p.top));
    return Math.max(PITCH, below + IO_SEP + above);
  };
  for (const n of nodes)
    if (n.kind !== 'io')
      geo.set(
        n.id,
        geometry(
          n,
          labels.byNode.get(n.id) ?? [],
          labels.rows,
          measure,
          {
            in: pitch(g.edges.filter((e) => e.to === n.id).map((e) => e.from)),
            out: pitch(g.edges.filter((e) => e.from === n.id).map((e) => e.to)),
          },
          style,
        ),
      );
  return geo;
}

export const layout: Layout = ({ ir, schedule, flags, measure, style = 'lecture', prev }) => {
  const g = buildGraph(ir);
  const geo = geometries(g, distributeLabels(g, sceneLabels(ir, schedule, flags)), measure, style);

  // initial order: the previous scene's where a node kept its layer, else
  // DFS discovery, which keeps a chain's members at the same height
  const prevNode = new Map(prev?.nodes.map((n) => [n.id, n]) ?? []);
  const dfsRank = new Map<string, number>();
  const visit = (v: string) => {
    dfsRank.set(v, dfsRank.size);
    for (const e of g.edges) if (e.from === v && !e.feedback && !dfsRank.has(e.to)) visit(e.to);
  };
  for (const v of g.nodes.keys()) if (!dfsRank.has(v)) visit(v);

  const items: Item[] = [];
  const itemOf = new Map<string, number>();
  for (const n of g.nodes.values()) {
    const L = g.layer.get(n.id)!;
    const p = prevNode.get(n.id);
    const gm = geo.get(n.id)!;
    itemOf.set(n.id, items.length);
    items.push({
      node: n.id,
      light: n.kind === 'io',
      io: n.kind === 'io',
      layer: L,
      order: 0,
      rank: p && p.layer === L ? p.order : 1000 + dfsRank.get(n.id)!,
      top: gm.top,
      bottom: gm.bottom,
      y: 0,
    });
  }
  const dummy = (L: number, rank: number): End => {
    items.push({
      light: true,
      io: false,
      layer: L,
      order: 0,
      rank,
      top: 0,
      bottom: 0,
      y: 0,
    });
    return { item: items.length - 1, dy: 0, frac: 0.5 };
  };
  const endOf = (node: string, key: string): End => {
    const a = geo.get(node)!.attach.get(key)!;
    return { item: itemOf.get(node)!, dy: a.dy, frac: a.frac };
  };

  const edgePieces: Piece[][] = g.edges.map((e, ei) => {
    const from = g.layer.get(e.from)!;
    const to = g.layer.get(e.to)!;
    const src = endOf(e.from, srcKey(g, e));
    const tgt = endOf(e.to, tgtKey(g, e));
    const ps: Piece[] = [];
    const piece = (gap: number, a: End, b: End, sa: 'L' | 'R', sb: 'L' | 'R') =>
      ps.push({ edge: ei, gap, a, b, sa, sb });
    if (to > from) {
      // dummies start just below their source, in edge order
      const rank = items[src.item]!.rank + 0.5 + ei * 1e-3;
      let a = src;
      for (let gap = from; gap < to; gap++) {
        const b = gap + 1 === to ? tgt : dummy(gap + 1, rank);
        piece(gap, a, b, 'L', 'R');
        a = b;
      }
    } else {
      // back through every column from the source's to the target's,
      // starting at the bottom of each
      const ds = new Map<number, End>();
      for (let L = to; L <= from; L++) ds.set(L, dummy(L, 1e6 + ei));
      piece(from, src, ds.get(from)!, 'L', 'L');
      for (let gap = from - 1; gap >= to; gap--)
        piece(gap, ds.get(gap + 1)!, ds.get(gap)!, 'R', 'L');
      piece(to - 1, ds.get(to)!, tgt, 'R', 'R');
    }
    return ps;
  });

  const layers: number[][] = Array.from({ length: g.last + 1 }, () => []);
  items.forEach((it, i) => layers[it.layer]!.push(i));
  const byGap = new Map<number, Piece[]>();
  for (const p of edgePieces.flat()) push(byGap, p.gap, p);
  orderLayers(items, layers, byGap);
  placeY(items, layers, edgePieces.flat());
  const routes = new Map<number, GapRoute>();
  const pieceRuns = new Map<Piece, GapRoute['runs'][number]>();
  for (const [gap, ps] of byGap) {
    const r = routeGap(items, ps);
    routes.set(gap, r);
    ps.forEach((p, i) => pieceRuns.set(p, r.runs[i]!));
  }

  // x: each column is as wide as its widest node; each gap holds the stub
  // labels of its left column, the tracks, then the stub labels of its right
  // column (gap -1, left of the inputs, holds only hooks)
  const pos = (v: number) => (v > 0 ? v + ZONE_PAD : 0);
  const colW = layers.map((l) =>
    Math.max(0, ...l.map((i) => (items[i]!.node ? 2 * geo.get(items[i]!.node!)!.half : 0))),
  );
  const need = (L: number, side: 'right' | 'left') =>
    pos(
      Math.max(
        0,
        ...layers[L]!.map((i) =>
          items[i]!.node ? geo.get(items[i]!.node!)![side] - colW[L]! / 2 : 0,
        ),
      ),
    );
  const trackZone = (gap: number) =>
    Math.max(MIN_TRACK_ZONE, TRACK_SP * ((routes.get(gap)?.tracks ?? 0) + 1));
  const colX: number[] = [];
  const trackStart = new Map<number, number>();
  let x = 0;
  if (byGap.has(-1)) {
    trackStart.set(-1, 0);
    x = trackZone(-1) + need(0, 'left');
  }
  for (let L = 0; L <= g.last; L++) {
    colX.push(x);
    x += colW[L]!;
    const out = need(L, 'right');
    trackStart.set(L, x + out);
    if (L < g.last) x += out + trackZone(L) + need(L + 1, 'left');
  }

  const center = (i: number): Pt => {
    const it = items[i]!;
    return { x: colX[it.layer]! + colW[it.layer]! / 2, y: it.y };
  };

  const nodes: SceneNode[] = [];
  const labels: SceneLabel[] = [];
  const attachAt = new Map<string, Pt>();
  for (const [L, layer] of layers.entries()) {
    let order = 0;
    for (const i of layer) {
      const id = items[i]!.node;
      if (!id) continue;
      const n = g.nodes.get(id)!;
      const gm = geo.get(id)!;
      const c = center(i);
      for (const [k, a] of gm.attach) attachAt.set(k, { x: c.x + a.dx, y: c.y + a.dy });
      const ports = [...n.ins, ...n.outs].map((pid) => {
        const p = g.ports.get(pid)!;
        return {
          id: pid,
          node: id,
          signal: p.signal,
          dir: p.dir,
          index: p.index,
          side: p.dir === 'in' ? ('W' as const) : ('E' as const),
          at: attachAt.get(pid)!,
          rate: p.rate,
        };
      });
      nodes.push({
        id,
        kind: n.kind,
        shape: gm.shape,
        box: { x: c.x - gm.w / 2, y: c.y - gm.h / 2, w: gm.w, h: gm.h },
        ports,
        layer: L,
        order: order++,
      });
      for (const l of gm.labels)
        labels.push({
          id: `${l.owner}#${l.kind}`,
          kind: l.kind,
          owner: l.owner,
          text: l.text,
          box: { x: c.x + l.box.x, y: c.y + l.box.y, w: l.box.w, h: l.box.h },
        });
    }
  }

  const edges: SceneEdge[] = g.edges.map((e, ei) => {
    const pts: Pt[] = [attachAt.get(srcKey(g, e))!];
    for (const p of edgePieces[ei]!)
      for (const r of pieceRuns.get(p)!) {
        const tx = trackStart.get(p.gap)! + TRACK_SP * (r.track + 1);
        pts.push({ x: tx, y: r.y0 }, { x: tx, y: r.y1 });
      }
    pts.push(attachAt.get(tgtKey(g, e))!);
    return {
      id: e.id,
      signal: e.signal,
      source: e.source,
      target: e.target,
      points: drawnPoints(pts),
      feedback: g.layer.get(e.to)! <= g.layer.get(e.from)!,
    };
  });

  const bounds = contentBox(
    nodes,
    labels,
    edges.map((e) => e.points),
  );
  return { nodes, edges, labels, bounds } satisfies Scene;
};
