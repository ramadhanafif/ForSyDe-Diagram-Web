import type { Pt, Rect, Scene, SceneLabel, SceneNode } from './types';

/** Layout quality counts; overlaps is the hard gate (must be 0). */
export interface Metrics {
  /** Label pairs whose boxes intersect by more than 0.5 px in both x and y. */
  labelLabel: number;
  /** (label, node) pairs where the label reaches into the node's drawn shape. */
  labelNode: number;
  /** (label, edge) pairs where the edge crosses the label box. */
  labelEdge: number;
  /** (edge, node) pairs where the edge runs through the node's drawn shape. */
  edgeNode: number;
  /**
   * Segment pairs of two edges running on top of each other for more than 1 px,
   * except the shared trunk of two edges leaving one port.
   */
  edgeEdgeOverlap: number;
  overlaps: number;
  /** Proper crossings between segments of different edges. */
  crossings: number;
  bends: number;
  /** Area of the box around every node, edge point and label (not the declared bounds). */
  area: number;
}

/** How far a label may reach into another label, an edge or a node. */
const LABEL_SLACK = 0.5;
/** Edge ends are trimmed by this so an edge may touch its own attach point. */
const ATTACH_TRIM = 1;
/** Parallel centre lines closer than this draw as one line (strokes are up to 1.5 px). */
export const COLLINEAR_TOL = 2;
const MIN_OVERLAP = 1;
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// geometry

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function sign(v: number): number {
  return v > EPS ? 1 : v < -EPS ? -1 : 0;
}

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** Closed segments share at least one point. */
function segmentsTouch(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = sign(cross(b1, b2, a1));
  const d2 = sign(cross(b1, b2, a2));
  const d3 = sign(cross(a1, a2, b1));
  const d4 = sign(cross(a1, a2, b2));
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (
    (d1 === 0 && onSegment(a1, b1, b2)) ||
    (d2 === 0 && onSegment(a2, b1, b2)) ||
    (d3 === 0 && onSegment(b1, a1, a2)) ||
    (d4 === 0 && onSegment(b2, a1, a2))
  );
}

/** Interiors cross at a single point; touching at an endpoint does not count. */
export function segmentsCrossProperly(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = sign(cross(b1, b2, a1));
  const d2 = sign(cross(b1, b2, a2));
  const d3 = sign(cross(a1, a2, b1));
  const d4 = sign(cross(a1, a2, b2));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function pointSegmentDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentSegmentDist(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  if (segmentsTouch(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDist(a1, b1, b2),
    pointSegmentDist(a2, b1, b2),
    pointSegmentDist(b1, a1, a2),
    pointSegmentDist(b2, a1, a2),
  );
}

/**
 * Every node shape is a rounded rectangle with corner radius min(w, h) / 2:
 * a circle (w = h), a stadium or an io pill. Such a shape is the set of points
 * within r of its core segment, which makes every shape test a distance test.
 */
export function shapeCore(box: Rect): { a: Pt; b: Pt; r: number } {
  const r = Math.min(box.w, box.h) / 2;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return box.w >= box.h
    ? { a: { x: box.x + r, y: cy }, b: { x: box.x + box.w - r, y: cy }, r }
    : { a: { x: cx, y: box.y + r }, b: { x: cx, y: box.y + box.h - r }, r };
}

function shrink(r: Rect, by: number): Rect | null {
  const w = r.w - 2 * by;
  const h = r.h - 2 * by;
  return w > 0 && h > 0 ? { x: r.x + by, y: r.y + by, w, h } : null;
}

/** Boxes overlap by more than `by` in both x and y. */
function rectsOverlap(a: Rect, b: Rect, by: number): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > by && h > by;
}

/** Distance between an axis-aligned box and an axis-aligned segment. */
export function rectAxisSegmentDist(r: Rect, a: Pt, b: Pt): number {
  const dx = Math.max(0, r.x - Math.max(a.x, b.x), Math.min(a.x, b.x) - (r.x + r.w));
  const dy = Math.max(0, r.y - Math.max(a.y, b.y), Math.min(a.y, b.y) - (r.y + r.h));
  return Math.hypot(dx, dy);
}

function rectTouchesShape(r: Rect, node: SceneNode): boolean {
  const c = shapeCore(node.box);
  return rectAxisSegmentDist(r, c.a, c.b) < c.r;
}

function rectInsideShape(r: Rect, node: SceneNode): boolean {
  const c = shapeCore(node.box);
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x, y: r.y + r.h },
    { x: r.x + r.w, y: r.y + r.h },
  ];
  return corners.every((p) => pointSegmentDist(p, c.a, c.b) <= c.r + LABEL_SLACK);
}

/** Liang-Barsky: does the closed segment meet the closed box? */
function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - r.x) &&
    clip(dx, r.x + r.w - a.x) &&
    clip(-dy, a.y - r.y) &&
    clip(dy, r.y + r.h - a.y)
  );
}

export function segments(points: Pt[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i]!, points[i + 1]!]);
  return out;
}

/**
 * The polyline as drawn: repeated points and points a straight run passes
 * through are dropped. Without this a redundant point counts as a bend, and a
 * crossing placed exactly on one is no longer proper and goes uncounted.
 */
export function drawnPoints(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && Math.abs(p.x - b.x) < EPS && Math.abs(p.y - b.y) < EPS) continue;
    const straight =
      a &&
      b &&
      Math.abs(cross(a, b, p)) < EPS * Math.hypot(p.x - a.x, p.y - a.y) &&
      (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) > 0;
    if (straight) out.pop();
    out.push(p);
  }
  return out;
}

/** Move the start of a -> b toward b by d (or return null when shorter than d). */
function trimStart(a: Pt, b: Pt, d: number): Pt | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len <= d) return null;
  return { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
}

/** The polyline's segments with the first and last ATTACH_TRIM px removed. */
function trimmedSegments(points: Pt[]): [Pt, Pt][] {
  const segs = segments(points);
  const out: [Pt, Pt][] = [];
  segs.forEach(([a, b], i) => {
    let s: Pt | null = a;
    let t: Pt | null = b;
    if (i === 0) s = trimStart(a, b, ATTACH_TRIM);
    if (s && i === segs.length - 1) t = trimStart(b, s, ATTACH_TRIM);
    if (s && t) out.push([s, t]);
  });
  return out;
}

/** Length over which two axis-parallel segments lie on the same line (0 if not). */
function collinearOverlap([a1, a2]: [Pt, Pt], [b1, b2]: [Pt, Pt]): number {
  const aH = Math.abs(a1.y - a2.y) < EPS;
  const aV = Math.abs(a1.x - a2.x) < EPS;
  const bH = Math.abs(b1.y - b2.y) < EPS;
  const bV = Math.abs(b1.x - b2.x) < EPS;
  const span = (p: number, q: number, r: number, s: number) =>
    Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s));
  // a zero-length segment is both horizontal and vertical; it overlaps nothing
  if (aH && aV) return 0;
  if (bH && bV) return 0;
  if (aH && bH && Math.abs(a1.y - b1.y) < COLLINEAR_TOL) return span(a1.x, a2.x, b1.x, b2.x);
  if (aV && bV && Math.abs(a1.x - b1.x) < COLLINEAR_TOL) return span(a1.y, a2.y, b1.y, b2.y);
  return 0;
}

/** Leading points two polylines have in common. */
function sharedPrefix(p: Pt[], q: Pt[]): number {
  let k = 0;
  while (
    k < p.length &&
    k < q.length &&
    Math.abs(p[k]!.x - q[k]!.x) < EPS &&
    Math.abs(p[k]!.y - q[k]!.y) < EPS
  )
    k++;
  return k;
}

/** Box around every node, label and edge point; 0 x 0 at the origin for an empty scene. */
export function contentBox(nodes: SceneNode[], labels: SceneLabel[], points: Pt[][]): Rect {
  let x = Infinity;
  let y = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const add = (r: Rect) => {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  };
  nodes.forEach((n) => add(n.box));
  labels.forEach((l) => add(l.box));
  points.flat().forEach((p) => add({ ...p, w: 0, h: 0 }));
  return x > x2 ? { x: 0, y: 0, w: 0, h: 0 } : { x, y, w: x2 - x, h: y2 - y };
}

// ---------------------------------------------------------------------------

export function scoreScene(scene: Scene): Metrics {
  const { nodes, edges, labels } = scene;
  const pts = edges.map((e) => drawnPoints(e.points));
  const segs = pts.map(segments);

  let labelLabel = 0;
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      if (rectsOverlap(labels[i]!.box, labels[j]!.box, LABEL_SLACK)) labelLabel++;

  let labelNode = 0;
  let labelEdge = 0;
  for (const l of labels) {
    const box = shrink(l.box, LABEL_SLACK);
    if (!box) continue;
    for (const n of nodes) {
      const own = l.kind === 'stack' && l.owner === n.id;
      if (rectTouchesShape(box, n) && !(own && rectInsideShape(l.box, n))) labelNode++;
    }
    for (const es of segs) if (es.some(([a, b]) => segmentHitsRect(a, b, box))) labelEdge++;
  }

  let edgeNode = 0;
  for (const p of pts) {
    const ts = trimmedSegments(p);
    for (const n of nodes) {
      const c = shapeCore(n.box);
      if (ts.some(([a, b]) => segmentSegmentDist(a, b, c.a, c.b) < c.r - EPS)) edgeNode++;
    }
  }

  let edgeEdgeOverlap = 0;
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      // two edges leaving one port run together up to where they part; that
      // trunk is by design, any later overlap is not
      const trunk = edges[i]!.source === edges[j]!.source ? sharedPrefix(pts[i]!, pts[j]!) : 0;
      segs[i]!.forEach((a, ia) => {
        segs[j]!.forEach((b, ib) => {
          const inTrunk = ia < trunk && ib < trunk;
          if (!inTrunk && collinearOverlap(a, b) > MIN_OVERLAP) edgeEdgeOverlap++;
          // with repeated and straight-through points dropped, orthogonal
          // polylines meeting at a bend either overlap there or only touch
          if (segmentsCrossProperly(a[0], a[1], b[0], b[1])) crossings++;
        });
      });
    }
  }

  const bends = pts.reduce((s, p) => s + Math.max(0, p.length - 2), 0);
  const box = contentBox(nodes, labels, pts);
  return {
    labelLabel,
    labelNode,
    labelEdge,
    edgeNode,
    edgeEdgeOverlap,
    overlaps: labelLabel + labelNode + labelEdge + edgeNode + edgeEdgeOverlap,
    crossings,
    bends,
    area: box.w * box.h,
  };
}
