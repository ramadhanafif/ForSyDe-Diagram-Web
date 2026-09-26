import type { Pt, Rect, Scene, SceneLabel, SceneNode } from '../scene/types';

/**
 * Pure motion math: easing, scene in-betweens for layout transitions, and
 * distance along a polyline for token travel. No DOM.
 */

/** Cubic ease in and out: slow start, slow finish, exact at 0 and 1. */
export const ease = (t: number) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

// a * (1 - t) + b * t is exact at both ends, unlike a + (b - a) * t
export const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
const mixPt = (a: Pt, b: Pt, t: number): Pt => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const mixRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: mix(a.x, b.x, t),
  y: mix(a.y, b.y, t),
  w: mix(a.w, b.w, t),
  h: mix(a.h, b.h, t),
});

/** `r` scaled by `s` about its centre. */
const scaleRect = (r: Rect, s: number): Rect => ({
  x: r.x + (r.w * (1 - s)) / 2,
  y: r.y + (r.h * (1 - s)) / 2,
  w: r.w * s,
  h: r.h * s,
});

/**
 * `pts` stretched to `n` points by repeating vertices, the repeats spread
 * evenly so the bends of both polylines line up by position; the ends stay
 * the ends.
 */
export function resample(pts: Pt[], n: number): Pt[] {
  if (pts.length >= n || pts.length < 2) return pts;
  return Array.from({ length: n }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (n - 1))]!);
}

/** Polyline `a` morphed toward `b`: both brought to the same point count, then mixed pointwise. */
export function morph(a: Pt[], b: Pt[], t: number): Pt[] {
  const n = Math.max(a.length, b.length);
  const ra = resample(a, n);
  const rb = resample(b, n);
  return rb.map((p, i) => mixPt(ra[i] ?? p, p, t));
}

/** A node grown from (s = 0) or shrunk to its centre: entering and exiting nodes. */
function scaleNode(n: SceneNode, s: number): SceneNode {
  const c = { x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h / 2 };
  return {
    ...n,
    box: scaleRect(n.box, s),
    ports: n.ports.map((p) => ({ ...p, at: mixPt(c, p.at, s) })),
  };
}

function tweenNode(a: SceneNode, b: SceneNode, t: number): SceneNode {
  const box = mixRect(a.box, b.box, t);
  const was = new Map(a.ports.map((p) => [p.id, p.at]));
  return {
    ...b,
    box,
    ports: b.ports.map((p) => {
      const from = was.get(p.id);
      if (from) return { ...p, at: mixPt(from, p.at, t) };
      // a new port keeps its place relative to the moving box
      const sx = b.box.w ? box.w / b.box.w : 1;
      const sy = b.box.h ? box.h / b.box.h : 1;
      return {
        ...p,
        at: { x: box.x + (p.at.x - b.box.x) * sx, y: box.y + (p.at.y - b.box.y) * sy },
      };
    }),
  };
}

const scaleLabel = (l: SceneLabel, s: number): SceneLabel => ({ ...l, box: scaleRect(l.box, s) });

const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));

/**
 * The scene a fraction `t` of the way from `from` to `to`. Elements are
 * matched by id: nodes and labels mix their boxes (ports their attach
 * points), edges morph their polylines. Elements only in `to` are entering:
 * grown from their centre by `t` (edges keep their place and only fade, which
 * the renderer does). Elements only in `from` are exiting: shrunk by 1 - t
 * and listed after the others. At t <= 0 this is `from` and at t >= 1 it is
 * `to`, so a settled renderer shows the layout's own geometry.
 */
export function tweenScene(from: Scene, to: Scene, t: number): Scene {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const fn = byId(from.nodes);
  const fe = byId(from.edges);
  const fl = byId(from.labels);
  const tn = byId(to.nodes);
  const te = byId(to.edges);
  const tl = byId(to.labels);
  return {
    nodes: [
      ...to.nodes.map((n) => {
        const a = fn.get(n.id);
        return a ? tweenNode(a, n, t) : scaleNode(n, t);
      }),
      ...from.nodes.filter((n) => !tn.has(n.id)).map((n) => scaleNode(n, 1 - t)),
    ],
    edges: [
      ...to.edges.map((e) => {
        const a = fe.get(e.id);
        return a ? { ...e, points: morph(a.points, e.points, t) } : e;
      }),
      ...from.edges.filter((e) => !te.has(e.id)),
    ],
    labels: [
      ...to.labels.map((l) => {
        const a = fl.get(l.id);
        return a ? { ...l, box: mixRect(a.box, l.box, t) } : scaleLabel(l, t);
      }),
      ...from.labels.filter((l) => !tl.has(l.id)).map((l) => scaleLabel(l, 1 - t)),
    ],
    bounds: mixRect(from.bounds, to.bounds, t),
  };
}

/** `s` with every coordinate mapped by p -> p * k + d: a scene seen through another view. */
export function scaleScene(s: Scene, k: number, d: Pt): Scene {
  const pt = (p: Pt): Pt => ({ x: p.x * k + d.x, y: p.y * k + d.y });
  const rect = (r: Rect): Rect => ({ ...pt(r), w: r.w * k, h: r.h * k });
  return {
    nodes: s.nodes.map((n) => ({
      ...n,
      box: rect(n.box),
      ports: n.ports.map((p) => ({ ...p, at: pt(p.at) })),
    })),
    edges: s.edges.map((e) => ({ ...e, points: e.points.map(pt) })),
    labels: s.labels.map((l) => ({ ...l, box: rect(l.box) })),
    bounds: rect(s.bounds),
  };
}

const segLen = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

export function pathLength(points: Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += segLen(points[i - 1]!, points[i]!);
  return len;
}

/** The point at distance `d` along the polyline, clamped to its ends. */
export function pointAtLength(points: Pt[], d: number): Pt {
  if (!points.length) return { x: 0, y: 0 };
  let rest = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = segLen(a, b);
    if (rest <= len && len > 0) return mixPt(a, b, rest / len);
    rest -= len;
  }
  return points[points.length - 1]!;
}

/** Distance along the polyline to its point nearest `p`. */
export function lengthAt(points: Pt[], p: Pt): number {
  let best = Infinity;
  let at = 0;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = segLen(a, b);
    const u = len
      ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len ** 2))
      : 0;
    const d = segLen(mixPt(a, b, u), p);
    if (d < best) {
      best = d;
      at = walked + u * len;
    }
    walked += len;
  }
  return at;
}

/** The stretch of the polyline between distances `a` and `b` along it (a <= b). */
export function slicePath(points: Pt[], a: number, b: number): Pt[] {
  const out = [pointAtLength(points, a)];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    walked += segLen(points[i - 1]!, points[i]!);
    if (walked > a && walked < b) out.push(points[i]!);
  }
  out.push(pointAtLength(points, b));
  return out;
}
