import { fifoSize } from '../scene/measure';
import type { DiagramStyle, LabelKind, Measure, NodeShape, Rect } from '../scene/types';
import type { ExpectedLabel } from '../scene/labels';
import type { GNode } from './graph';

/** Vertical distance between neighbouring ports; fits a signal label above each stub. */
export const PITCH = 22;
/** Labels on a stub sit this far off the node box, this far apart, this high above the line. */
const LABEL_PAD = 3;
const LABEL_GAP = 4;
const LIFT = 2;
const NAME_GAP = 4;
const BADGE_GAP = 6;
/** Furthest the badge may start right of the node box (validate allows 40 px). */
const BADGE_REACH = 20;
/** Where the baseline sits in a measured box: 1.25 x the font size high, ascent one font size. */
const BASELINE = 0.8;
const MIN_D = 36;
/** Keeps a widened pair of circle ports within 60 degrees of the horizontal. */
const MIN_D_PER_PITCH = 1.2;
/** Slack between the stack text's corners and the outline. */
const STACK_PAD = 6;
/** A strip's stack text sits this far below it. */
const STRIP_STACK_GAP = 4;
const IO_H = 20;
const IO_PAD = 16;
const MIN_IO_W = 30;

export type Side = 'E' | 'W';

/** Where an edge meets a node, relative to the node centre. */
export interface Attach {
  dx: number;
  dy: number;
  side: Side;
  /** Slot for crossing counts, in (0, 1). */
  frac: number;
}

export interface RelLabel {
  kind: LabelKind;
  owner: string;
  text: string;
  /** Relative to the node centre. */
  box: Rect;
}

/** A node's drawing relative to its centre, and the room it claims in its column. */
export interface Geom {
  w: number;
  h: number;
  shape: NodeShape;
  /** By port id, or ioKey() for an io pill's two sides. */
  attach: Map<string, Attach>;
  labels: RelLabel[];
  /** Vertical extent around the centre, labels included (top < 0). */
  top: number;
  bottom: number;
  /** Half the width the node needs in its column (shape, name, badge). */
  half: number;
  /** Reach of the stub labels right and left of the centre. */
  right: number;
  left: number;
}

/** Port spacing per side; wider than PITCH where a side faces stacked io pills. */
export interface Pitch {
  in: number;
  out: number;
}

export const ioKey = (id: string, side: Side) => `${id}|${side}`;

/** A modern delay with at most one port per side is drawn as its token strip. */
const isStrip = (n: GNode, style: DiagramStyle) =>
  style === 'modern' && n.kind === 'delay' && n.ins.length <= 1 && n.outs.length <= 1;

/** Shape, size and attach points; ports ride the outline `pitch` apart around the centre. */
function shapeOf(
  n: GNode,
  stack: string | undefined,
  measure: Measure,
  pitch: Pitch,
  style: DiagramStyle,
) {
  const attach = new Map<string, Attach>();
  // an io pill and a strip each have one attach point per side at mid height,
  // so an edge can run straight through a strip
  const io = n.kind === 'io';
  if (io || isStrip(n, style)) {
    const { w, h } = io
      ? { w: Math.max(MIN_IO_W, measure(n.id, 'stack').w + IO_PAD), h: IO_H }
      : fifoSize(n.tokens, measure(String(n.tokens), 'buffer').w);
    for (const id of io ? [ioKey(n.id, 'E')] : n.outs)
      attach.set(id, { dx: w / 2, dy: 0, side: 'E', frac: 0.5 });
    for (const id of io ? [ioKey(n.id, 'W')] : n.ins)
      attach.set(id, { dx: -w / 2, dy: 0, side: 'W', frac: 0.5 });
    return { w, h, shape: (io ? 'pill' : 'strip') as NodeShape, attach };
  }
  const k = Math.max(n.ins.length, n.outs.length, 1);
  const m = stack ? measure(stack, 'stack') : { w: 0, h: 0 };
  let w: number;
  let h: number;
  let dxAt: (dy: number) => number;
  let shape: NodeShape;
  if (k <= 2) {
    w = h = Math.max(
      MIN_D,
      Math.hypot(m.w, m.h) + STACK_PAD,
      MIN_D_PER_PITCH * Math.max(pitch.in, pitch.out),
    );
    dxAt = (dy) => Math.sqrt((w / 2) ** 2 - dy * dy);
    shape = 'circle';
  } else {
    // upright stadium: the ports sit on the straight sides, the text fits
    // between the round caps
    const f = Math.max((n.ins.length - 1) * pitch.in, (n.outs.length - 1) * pitch.out) / 2;
    w = Math.max(MIN_D, 2 * Math.hypot(m.w / 2, Math.max(0, m.h / 2 - f)) + STACK_PAD);
    h = w + 2 * f;
    dxAt = () => w / 2;
    shape = 'stadium';
  }
  const place = (ids: string[], side: Side, p: number) =>
    ids.forEach((id, i) => {
      const dy = (i - (ids.length - 1) / 2) * p;
      const dx = dxAt(dy);
      attach.set(id, { dx: side === 'E' ? dx : -dx, dy, side, frac: (i + 1) / (ids.length + 1) });
    });
  place(n.ins, 'W', pitch.in);
  place(n.outs, 'E', pitch.out);
  return { w, h, shape, attach };
}

/**
 * Order of a stub's labels outward from the node: the argument tag, the rate,
 * then the signal name and buffer reading left to right.
 */
const ROW_RANK: Record<Side, Record<string, number>> = {
  E: { index: 0, rate: 1, signal: 2, buffer: 3 },
  W: { index: 0, rate: 1, buffer: 2, signal: 3 },
};

/**
 * Size a node and place its labels. `rows` holds the labels riding each
 * attach point's stub (rate, signal, buffer), keyed like Geom.attach; they sit
 * in a row just above the stub, outside the node box. The name and badge sit
 * above everything, the stack text inside the outline.
 */
export function geometry(
  n: GNode,
  labels: ExpectedLabel[],
  rows: Map<string, ExpectedLabel[]>,
  measure: Measure,
  pitch: Pitch = { in: PITCH, out: PITCH },
  style: DiagramStyle = 'lecture',
): Geom {
  const stack = labels.find((l) => l.kind === 'stack');
  const { w, h, shape, attach } = shapeOf(n, stack?.text, measure, pitch, style);
  const rel: RelLabel[] = [];
  let top = -h / 2;
  let right = w / 2;
  let left = w / 2;
  for (const [key, a] of attach) {
    const rank = ROW_RANK[a.side];
    const row = [...(rows.get(key) ?? [])].sort((p, q) => rank[p.kind]! - rank[q.kind]!);
    let x = w / 2 + LABEL_PAD;
    for (const l of row) {
      const m = measure(l.text, l.kind);
      const y = a.dy - LIFT - m.h;
      rel.push({ ...l, box: { x: a.side === 'E' ? x : -x - m.w, y, w: m.w, h: m.h } });
      x += m.w + LABEL_GAP;
      top = Math.min(top, y);
    }
    if (row.length) {
      if (a.side === 'E') right = Math.max(right, x - LABEL_GAP);
      else left = Math.max(left, x - LABEL_GAP);
    }
  }
  let half = w / 2;
  let bottom = h / 2;
  if (stack) {
    const m = measure(stack.text, 'stack');
    // a strip has no room inside: its stack text hangs below it
    const y = shape === 'strip' ? h / 2 + STRIP_STACK_GAP : -m.h / 2;
    rel.push({ ...stack, box: { x: -m.w / 2, y, w: m.w, h: m.h } });
    if (shape === 'strip') {
      bottom = y + m.h;
      half = Math.max(half, m.w / 2);
    }
  }
  const name = labels.find((l) => l.kind === 'name');
  if (name) {
    const nm = measure(name.text, 'name');
    const badge = labels.find((l) => l.kind === 'badge');
    const bm = badge ? measure(badge.text, 'badge') : null;
    const total = nm.w + (bm ? BADGE_GAP + bm.w : 0);
    const y = top - NAME_GAP - nm.h;
    // a long name over a small node would carry the badge out of its reach;
    // slide the name left so the badge stays over the node
    const x0 = bm ? Math.min(-total / 2, w / 2 + BADGE_REACH - nm.w - BADGE_GAP) : -total / 2;
    rel.push({ ...name, box: { x: x0, y, w: nm.w, h: nm.h } });
    if (badge && bm) {
      const baseline = y + BASELINE * nm.h;
      rel.push({
        ...badge,
        box: { x: x0 + nm.w + BADGE_GAP, y: baseline - BASELINE * bm.h, w: bm.w, h: bm.h },
      });
    }
    top = y;
    half = Math.max(half, -x0, x0 + total);
  }
  return { w, h, shape, attach, labels: rel, top, bottom, half, right, left };
}
