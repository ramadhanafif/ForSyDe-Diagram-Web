import { isDelay, type IRSystem } from '../core/ir';
import type { ScheduleResult } from '../core/schedule';
import { attachRef, edgeId, indexLabel, sceneLabels, type ExpectedLabel } from './labels';
import { pointSegmentDist, rectAxisSegmentDist, segments, shapeCore } from './metrics';
import type {
  DiagramStyle,
  LabelFlags,
  Measure,
  Pt,
  Rect,
  Scene,
  SceneLabel,
  SceneNode,
} from './types';

/** How far a port or io attach point may sit off the drawn outline. */
const ON_OUTLINE = 1;
/** Float slack for points that must coincide. */
const SAME = 0.01;
const EPS = 1e-6;
/**
 * How far a label may sit from what it annotates. Elk's worst was 31 px (a
 * buffer pushed right by a long signal name); the bound stops a layout from
 * parking labels in free space far away.
 */
const LABEL_REACH = 40;

export interface ExpectedPort {
  id: string;
  node: string;
  signal: string;
  dir: 'in' | 'out';
  index: number;
  rate: number;
}

/**
 * The ports every layout must produce, keyed by port id. The in-port index is
 * the argument position: the elaborator emits ir.signals binding by binding,
 * each binding's arguments in order, so the signals targeting a process are
 * already in argument order. The out-port index is the tuple position, which
 * ir.signals does not keep (it lists signals in consumption order); it is
 * recovered from the spans as the order of first occurrence inside the
 * process's system binding, where the left-hand tuple precedes the arguments.
 */
export function expectedPorts(ir: IRSystem): Map<string, ExpectedPort> {
  const ports = new Map<string, ExpectedPort>();
  for (const p of ir.processes) {
    ir.signals
      .filter((s) => s.target.name === p.name)
      .forEach((s, index) => {
        const id = `${p.name}.in.${s.name}`;
        ports.set(id, { id, node: p.name, signal: s.name, dir: 'in', index, rate: s.target.rate });
      });

    const binding = ir.spans.processes.get(p.name)?.systemBindings[0];
    const firstIn = (sig: string): number => {
      const occ = (ir.spans.signals.get(sig) ?? [])
        .filter((sp) => binding && sp.from >= binding.from && sp.to <= binding.to)
        .map((sp) => sp.from);
      return occ.length ? Math.min(...occ) : Infinity;
    };
    const outs = new Map<string, number>();
    for (const s of ir.signals) if (s.source.name === p.name) outs.set(s.name, s.source.rate);
    [...outs.keys()]
      .sort((a, b) => firstIn(a) - firstIn(b))
      .forEach((sig, index) => {
        const id = `${p.name}.out.${sig}`;
        ports.set(id, { id, node: p.name, signal: sig, dir: 'out', index, rate: outs.get(sig)! });
      });
  }
  return ports;
}

const labelKey = (l: ExpectedLabel) => `${l.kind} ${l.owner} ${JSON.stringify(l.text)}`;

function onBoxBorder(p: Pt, b: Rect): boolean {
  const inside =
    p.x >= b.x - ON_OUTLINE &&
    p.x <= b.x + b.w + ON_OUTLINE &&
    p.y >= b.y - ON_OUTLINE &&
    p.y <= b.y + b.h + ON_OUTLINE;
  const edgeDist = Math.min(
    Math.abs(p.x - b.x),
    Math.abs(p.x - b.x - b.w),
    Math.abs(p.y - b.y),
    Math.abs(p.y - b.y - b.h),
  );
  return inside && edgeDist <= ON_OUTLINE;
}

/** On the drawn outline: the circle, or the stadium/pill with its round caps. */
function onOutline(p: Pt, n: SceneNode): boolean {
  const c = shapeCore(n.box);
  return Math.abs(pointSegmentDist(p, c.a, c.b) - c.r) <= ON_OUTLINE;
}

function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= SAME && Math.abs(a.y - b.y) <= SAME;
}

function fmt(p: Pt | undefined): string {
  return p ? `(${p.x}, ${p.y})` : 'none';
}

function contains(outer: Rect, r: Rect): boolean {
  return (
    r.x >= outer.x - SAME &&
    r.y >= outer.y - SAME &&
    r.x + r.w <= outer.x + outer.w + SAME &&
    r.y + r.h <= outer.y + outer.h + SAME
  );
}

function hasNaN(v: unknown): boolean {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasNaN);
  if (v && typeof v === 'object') return Object.values(v).some(hasNaN);
  return false;
}

/** What the labels are checked against; without it only label placement is checked. */
export interface LabelContext {
  schedule: ScheduleResult | null;
  flags: LabelFlags;
  measure: Measure;
  /** The layout's style (default lecture); only the modern style draws strips. */
  style?: DiagramStyle;
}

/** Structural invariants of a scene for this IR; one message per violation. */
export function validateScene(scene: Scene, ir: IRSystem, ctx?: LabelContext): string[] {
  const errs: string[] = [];

  for (const n of scene.nodes) if (hasNaN(n)) errs.push(`node ${n.id}: non-finite number`);
  for (const e of scene.edges) if (hasNaN(e)) errs.push(`edge ${e.id}: non-finite number`);
  for (const l of scene.labels) if (hasNaN(l)) errs.push(`label ${l.id}: non-finite number`);
  if (hasNaN(scene.bounds)) errs.push('bounds: non-finite number');

  // nodes
  const expectedKind = new Map<string, SceneNode['kind']>();
  for (const p of ir.processes) expectedKind.set(p.name, isDelay(p) ? 'delay' : 'actor');
  for (const io of [...ir.inputs, ...ir.outputs]) expectedKind.set(io, 'io');
  const byId = new Map<string, SceneNode>();
  const count = new Map<string, number>();
  for (const n of scene.nodes) {
    byId.set(n.id, n);
    count.set(n.id, (count.get(n.id) ?? 0) + 1);
    const kind = expectedKind.get(n.id);
    if (!kind) errs.push(`node ${n.id}: not in the IR`);
    else if (kind !== n.kind) errs.push(`node ${n.id}: kind ${n.kind}, expected ${kind}`);
    // metrics test the shape the box implies, so the box must match the shape drawn
    if ((n.kind === 'io') !== (n.shape === 'pill'))
      errs.push(`node ${n.id}: ${n.kind} drawn as ${n.shape}`);
    if (n.shape === 'strip' && (n.kind !== 'delay' || (ctx && ctx.style !== 'modern')))
      errs.push(`node ${n.id}: ${n.kind} drawn as a strip in the ${ctx?.style ?? 'lecture'} style`);
    if (n.shape === 'circle' && Math.abs(n.box.w - n.box.h) > SAME)
      errs.push(`node ${n.id}: circle in a ${n.box.w} x ${n.box.h} box`);
  }
  for (const id of expectedKind.keys()) {
    const c = count.get(id) ?? 0;
    if (c !== 1) errs.push(`node ${id}: ${c} nodes, expected 1`);
  }

  // ports
  const expected = expectedPorts(ir);
  const portAt = new Map<string, Pt>();
  const tagged: ExpectedLabel[] = [];
  for (const n of scene.nodes) {
    for (const p of n.ports) {
      if (portAt.has(p.id)) errs.push(`port ${p.id}: duplicate`);
      portAt.set(p.id, p.at);
      const x = expected.get(p.id);
      if (!x || x.node !== n.id) {
        errs.push(`port ${p.id}: not expected on node ${n.id}`);
        continue;
      }
      if (p.node !== x.node || p.signal !== x.signal || p.dir !== x.dir)
        errs.push(`port ${p.id}: node/signal/dir do not match its id`);
      if (p.index !== x.index) errs.push(`port ${p.id}: index ${p.index}, expected ${x.index}`);
      if (p.rate !== x.rate) errs.push(`port ${p.id}: rate ${p.rate}, expected ${x.rate}`);
      if (!onOutline(p.at, n)) errs.push(`port ${p.id}: at ${fmt(p.at)} is off the node outline`);
      const cx = n.box.x + n.box.w / 2;
      const cy = n.box.y + n.box.h / 2;
      const sideOk =
        p.side === 'W'
          ? p.at.x <= cx
          : p.side === 'E'
            ? p.at.x >= cx
            : p.side === 'N'
              ? p.at.y <= cy
              : p.at.y >= cy;
      if (!sideOk) errs.push(`port ${p.id}: at ${fmt(p.at)} is not on side ${p.side}`);
    }
    // ports on a side may sit in any order; a side not in argument order
    // tags every port with its position
    for (const dir of ['in', 'out'] as const) {
      for (const side of ['W', 'E'] as const) {
        const group = n.ports
          .filter((p) => p.dir === dir && p.side === side)
          .sort((a, b) => a.index - b.index);
        const inOrder = group.every((p, i) => i === 0 || p.at.y > group[i - 1]!.at.y + EPS);
        if (!inOrder) for (const p of group) tagged.push(indexLabel(p.id, p.index));
        const ys = group.map((p) => p.at.y).sort((a, b) => a - b);
        for (let i = 1; i < ys.length; i++)
          if (!(ys[i]! > ys[i - 1]! + EPS))
            errs.push(`node ${n.id}: two ${dir} ports at y ${ys[i]}`);
      }
    }
  }
  for (const id of expected.keys()) if (!portAt.has(id)) errs.push(`port ${id}: missing`);

  // edges
  const attachOk = (ref: string, p: Pt | undefined): boolean => {
    if (!p) return false;
    const at = portAt.get(ref);
    if (at) return samePt(at, p);
    const io = byId.get(ref);
    return !!io && io.kind === 'io' && onBoxBorder(p, io.box);
  };
  const edgeCount = new Map<string, number>();
  for (const e of scene.edges) edgeCount.set(e.id, (edgeCount.get(e.id) ?? 0) + 1);
  const wanted = new Set<string>();
  for (const s of ir.signals) {
    const id = edgeId(s);
    wanted.add(id);
    const c = edgeCount.get(id) ?? 0;
    if (c !== 1) errs.push(`edge ${id}: ${c} edges, expected 1`);
    const e = scene.edges.find((x) => x.id === id);
    if (!e) continue;
    const src = attachRef(ir, s.source.name, s.name, 'out');
    const tgt = attachRef(ir, s.target.name, s.name, 'in');
    if (e.signal !== s.name) errs.push(`edge ${id}: signal ${e.signal}, expected ${s.name}`);
    if (e.source !== src) errs.push(`edge ${id}: source ${e.source}, expected ${src}`);
    if (e.target !== tgt) errs.push(`edge ${id}: target ${e.target}, expected ${tgt}`);
  }
  for (const e of scene.edges) {
    if (!wanted.has(e.id)) errs.push(`edge ${e.id}: not in the IR`);
    if (e.points.length < 2) {
      errs.push(`edge ${e.id}: ${e.points.length} points`);
      continue;
    }
    if (!attachOk(e.source, e.points[0]))
      errs.push(`edge ${e.id}: starts at ${fmt(e.points[0])}, not at ${e.source}`);
    if (!attachOk(e.target, e.points[e.points.length - 1]))
      errs.push(`edge ${e.id}: ends at ${fmt(e.points[e.points.length - 1])}, not at ${e.target}`);
    segments(e.points).forEach(([a, b], i) => {
      if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS)
        errs.push(`edge ${e.id}: segment ${i} ${fmt(a)}-${fmt(b)} is not orthogonal`);
    });
  }

  // layers
  const maxLayer = Math.max(0, ...scene.nodes.map((n) => n.layer));
  for (const io of ir.inputs) {
    const n = byId.get(io);
    if (n && n.layer !== 0) errs.push(`node ${io}: system input in layer ${n.layer}, not 0`);
  }
  for (const io of ir.outputs) {
    const n = byId.get(io);
    if (n && n.layer !== maxLayer)
      errs.push(`node ${io}: system output in layer ${n.layer}, not ${maxLayer}`);
  }
  // layers are columns left to right; a layer number alone proves nothing
  const cx = (n: SceneNode) => n.box.x + n.box.w / 2;
  for (const a of scene.nodes)
    for (const b of scene.nodes)
      if (a.layer < b.layer && cx(a) >= cx(b))
        errs.push(
          `node ${b.id}: layer ${b.layer} is not right of node ${a.id} in layer ${a.layer}`,
        );

  // labels: present as the flags say, as large as their text, near their owner
  if (ctx) {
    const want = new Set([...sceneLabels(ir, ctx.schedule, ctx.flags), ...tagged].map(labelKey));
    const have = new Set(scene.labels.map(labelKey));
    for (const k of want) if (!have.has(k)) errs.push(`label ${k}: missing`);
    for (const l of scene.labels) {
      if (!want.has(labelKey(l))) errs.push(`label ${l.id}: ${labelKey(l)} is not expected`);
      const m = ctx.measure(l.text, l.kind);
      if (l.box.w < m.w - SAME || l.box.h < m.h - SAME)
        errs.push(`label ${l.id}: ${l.box.w} x ${l.box.h} box, its text needs ${m.w} x ${m.h}`);
    }
  }
  const edgeById = new Map(scene.edges.map((e) => [e.id, e]));
  const ownerDist = (l: SceneLabel): number | undefined => {
    if (l.kind === 'signal' || l.kind === 'buffer') {
      const e = edgeById.get(l.owner);
      return e && Math.min(...segments(e.points).map(([a, b]) => rectAxisSegmentDist(l.box, a, b)));
    }
    const at = l.kind === 'rate' || l.kind === 'index' ? portAt.get(l.owner) : undefined;
    if (at) return rectAxisSegmentDist(l.box, at, at);
    const n = byId.get(l.owner);
    if (!n || (l.kind === 'rate' && n.kind !== 'io')) return undefined;
    const { x, y, w, h } = n.box;
    return rectAxisSegmentDist(l.box, { x, y }, { x: x + w, y: y + h });
  };
  for (const l of scene.labels) {
    const d = ownerDist(l);
    if (d === undefined || Number.isNaN(d))
      errs.push(`label ${l.id}: owner ${l.owner} is not a ${l.kind} owner in the scene`);
    else if (d > LABEL_REACH) errs.push(`label ${l.id}: ${d.toFixed(1)} px from ${l.owner}`);
  }

  // node boxes are disjoint
  for (let i = 0; i < scene.nodes.length; i++) {
    for (let j = i + 1; j < scene.nodes.length; j++) {
      const a = scene.nodes[i]!.box;
      const b = scene.nodes[j]!.box;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > EPS && h > EPS)
        errs.push(`node ${scene.nodes[i]!.id}: box intersects node ${scene.nodes[j]!.id}`);
    }
  }

  // bounds
  const b = scene.bounds;
  for (const n of scene.nodes)
    if (!contains(b, n.box)) errs.push(`bounds: node ${n.id} sticks out`);
  for (const l of scene.labels)
    if (!contains(b, l.box)) errs.push(`bounds: label ${l.id} sticks out`);
  for (const e of scene.edges)
    if (e.points.some((p) => !contains(b, { x: p.x, y: p.y, w: 0, h: 0 })))
      errs.push(`bounds: edge ${e.id} sticks out`);

  return errs;
}
