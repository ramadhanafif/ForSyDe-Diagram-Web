import { memo } from 'react';
import { FIFO } from '../scene/measure';
import type { DiagramStyle, Pt, Rect, Scene, SceneNode } from '../scene/types';

/** The dashed system boundary sits this far outside the scene bounds; its title above it. */
export const BOX_PAD = 16;
export const TITLE_H = 24;

/** Everything drawn: boundary box and its title included. Fit frames this. */
export const frameOf = (b: Rect): Rect => ({
  x: b.x - BOX_PAD,
  y: b.y - BOX_PAD - TITLE_H,
  w: b.w + 2 * BOX_PAD,
  h: b.h + 2 * BOX_PAD + TITLE_H,
});

/** What the pointer is on: a node or an edge, by id. */
export interface Hit {
  kind: 'node' | 'edge';
  id: string;
}

export const sameHit = (a: Hit | null, b: Hit | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);

export const pathD = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');

const PORT_R = 3.5;
const NEW_INPUT_R = 4.5;

/** The add-an-input handle: lower left on the outline, below every input port. */
function newInputAt(b: Rect): Pt {
  const r = b.w / 2;
  const cy = b.y + b.h - r;
  return { x: b.x + r - r * Math.SQRT1_2, y: cy + r * Math.SQRT1_2 };
}

const STRIP_H = 2 * FIFO.PAD + FIFO.SLOT_H;

/**
 * A FIFO strip with its top-left corner at (x, y), geometry as in FIFO:
 * capacity slots with the first `filled` filled; above MAX_SLOTS a bar filled
 * in proportion, and the capacity as a number.
 */
export function Strip({ x, y, capacity, filled }: Pt & { capacity: number; filled: number }) {
  const { SLOT_W, SLOT_H, GAP, PAD, MAX_SLOTS, BAR_W } = FIFO;
  if (capacity > MAX_SLOTS) {
    const f = Math.min(1, filled / capacity);
    return (
      <>
        <rect className="fifo-bar" x={x + PAD} y={y + PAD} width={BAR_W} height={SLOT_H} />
        {f > 0 && (
          <rect
            className="fifo-bar-fill"
            x={x + PAD}
            y={y + PAD}
            width={BAR_W * f}
            height={SLOT_H}
          />
        )}
        <text className="fifo-count" x={x + PAD + BAR_W + GAP} y={y + PAD + SLOT_H / 2}>
          {capacity}
        </text>
      </>
    );
  }
  return Array.from({ length: Math.max(1, capacity) }, (_, i) => (
    <rect
      key={i}
      className={`fifo-slot${i < filled ? ' filled' : ''}`}
      x={x + PAD + i * (SLOT_W + GAP)}
      y={y + PAD}
      width={SLOT_W}
      height={SLOT_H}
      rx={1.5}
    />
  ));
}

function Shape({ n, tokens }: { n: SceneNode; tokens: number }) {
  const b = n.box;
  // a delay in the modern style: its initial tokens sitting on the edge
  if (n.shape === 'strip')
    return (
      <>
        <rect className="node-shape" x={b.x} y={b.y} width={b.w} height={b.h} rx={3} ry={3} />
        <Strip x={b.x} y={b.y} capacity={tokens} filled={tokens} />
      </>
    );
  if (n.shape === 'circle')
    return <circle className="node-shape" cx={b.x + b.w / 2} cy={b.y + b.h / 2} r={b.w / 2} />;
  const r = Math.min(b.w, b.h) / 2;
  return <rect className="node-shape" x={b.x} y={b.y} width={b.w} height={b.h} rx={r} ry={r} />;
}

/** A drag-to-connect in progress, in scene coordinates. */
export interface ConnectState {
  from: Pt;
  to: Pt;
  /** Actors that accept the dragged signal as a new input. */
  valid: Set<string>;
  /** The actor under the pointer, if any. */
  over: string | null;
}

/** Simulation state on the diagram, by node or edge id. */
export interface SceneMarks {
  /** Extra classes: firing, waiting (nodes); consumed, produced, short, unbounded (edges). */
  nodes: Map<string, string>;
  edges: Map<string, string>;
  /** Tokens on each edge's signal, drawn in its buffer strip. */
  fill: Map<string, number>;
  /** Hover explanations, listed before what the SHOW toggles hide. */
  notes: Map<string, string[]>;
  /** Playback position; a new one restarts the consumed/produced pulse. */
  step: number;
}

export const NO_MARKS: SceneMarks = {
  nodes: new Map(),
  edges: new Map(),
  fill: new Map(),
  notes: new Map(),
  step: 0,
};

const BUF = /^buf (\d+)$/;

/** Half way along an edge by length, where an overflow marker goes (a middle vertex is a bend). */
function midpoint(pts: Pt[]): Pt {
  const segs = pts
    .slice(1)
    .map((b, i) => [pts[i]!, b, Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y)] as const);
  let rest = segs.reduce((sum, [, , len]) => sum + len, 0) / 2;
  for (const [a, b, len] of segs) {
    if (rest <= len && len > 0)
      return { x: a.x + ((b.x - a.x) * rest) / len, y: a.y + ((b.y - a.y) * rest) / len };
    rest -= len;
  }
  return pts[0]!;
}

interface Props {
  scene: Scene;
  style: DiagramStyle;
  /** Initial token count per delay, for a strip delay. */
  tokens: Map<string, number>;
  marks: SceneMarks;
  selected: Hit | null;
  hover: Hit | null;
  /** What the editor cursor is on. */
  linked?: { nodes: Set<string>; edges: Set<string> };
  flash: string[];
  connect: ConnectState | null;
}

/** During a connect, every actor is marked as a valid or invalid target. */
function connectCls(n: SceneNode, c: ConnectState | null) {
  if (!c || n.kind !== 'actor') return '';
  return (
    (c.valid.has(n.id) ? ' connect-valid' : ' connect-invalid') +
    (c.over === n.id ? ' connect-over' : '')
  );
}

const cls = (base: string, kind: Hit['kind'], id: string, p: Props) =>
  base +
  (p.selected?.kind === kind && p.selected.id === id ? ' selected' : '') +
  (p.hover?.kind === kind && p.hover.id === id ? ' hover' : '') +
  ((kind === 'node' ? p.linked?.nodes : p.linked?.edges)?.has(id) ? ' linked' : '');

/** The SVG layer: boundary, edges under nodes, ports on the outlines. */
export const SceneShapes = memo(function SceneShapes(p: Props) {
  const { scene } = p;
  const f = frameOf(scene.bounds);
  const box = { x: f.x, y: f.y + TITLE_H, w: f.w, h: f.h - TITLE_H };
  return (
    <svg
      className="scene-svg"
      style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
      viewBox={`${f.x} ${f.y} ${f.w} ${f.h}`}
    >
      <defs>
        <marker
          id="scene-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          // fixed size in user units: a wider line (pulse, drop target, error marks) keeps the
          // resting arrowhead instead of scaling it into the node or strip it points at
          markerUnits="userSpaceOnUse"
          markerWidth={p.style === 'modern' ? 12 : 8}
          markerHeight={p.style === 'modern' ? 9 : 6}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" />
        </marker>
      </defs>
      <rect className="system-boundary" x={box.x} y={box.y} width={box.w} height={box.h} />
      {scene.edges.map((e) => {
        const d = pathD(e.points);
        const mark = p.marks.edges.get(e.id);
        const m = mark?.includes('unbounded') ? midpoint(e.points) : null;
        return (
          <g
            key={e.id}
            className={cls('scene-edge', 'edge', e.id, p) + (mark ? ` ${mark}` : '')}
            data-edge-id={e.id}
          >
            <path className="edge-hit" d={d} />
            {/* keyed by step so the pulse replays when one edge is marked twice in a row */}
            <path
              key={mark ? `line-${p.marks.step}` : 'line'}
              className="edge-line"
              d={d}
              markerEnd="url(#scene-arrow)"
            />
            {m && (
              <g className="overflow-mark">
                <circle cx={m.x} cy={m.y} r={7} />
                <text x={m.x} y={m.y}>
                  +
                </text>
              </g>
            )}
          </g>
        );
      })}
      {p.style === 'modern' &&
        scene.labels.map((l) => {
          const cap = l.kind === 'buffer' ? BUF.exec(l.text)?.[1] : undefined;
          if (cap === undefined) return null;
          // the label box can be taller than the strip (the count's line height)
          const y = l.box.y + (l.box.h - STRIP_H) / 2;
          return (
            <g key={l.id} className="buffer-strip" data-owner-edge={l.owner} data-strip={l.id}>
              <rect
                className="fifo-outline"
                x={l.box.x}
                y={y}
                width={l.box.w}
                height={STRIP_H}
                rx={3}
              />
              <Strip
                x={l.box.x}
                y={y}
                capacity={Number(cap)}
                filled={p.marks.fill.get(l.owner) ?? 0}
              />
            </g>
          );
        })}
      {scene.nodes.map((n) => {
        const h = n.kind === 'actor' ? newInputAt(n.box) : null;
        return (
          <g
            key={n.id}
            className={
              cls(`scene-node kind-${n.kind}`, 'node', n.id, p) +
              (p.flash.includes(n.id) ? ' just-added' : '') +
              (p.marks.nodes.has(n.id) ? ` ${p.marks.nodes.get(n.id)}` : '') +
              connectCls(n, p.connect)
            }
            data-node-id={n.id}
            tabIndex={0}
            // processes open their popover on Enter; an io node is only a drag source
            role={n.kind === 'io' ? 'img' : 'button'}
            aria-label={`${n.kind === 'io' ? 'signal' : n.kind} ${n.id}`}
          >
            {/* the body scales and moves with the node box during a layout transition */}
            <g className="node-body">
              <Shape n={n} tokens={p.tokens.get(n.id) ?? 0} />
              {h && (
                <circle
                  className="new-input-handle"
                  data-new-input={n.id}
                  cx={h.x}
                  cy={h.y}
                  r={NEW_INPUT_R}
                >
                  <title>drag a signal here to add an input</title>
                </circle>
              )}
            </g>
            {n.kind === 'io' && (
              // an io pill's body drags to move it; its signal is dragged from here
              <circle
                className="io-handle"
                data-io-handle={n.id}
                cx={n.box.x + n.box.w}
                cy={n.box.y + n.box.h / 2}
                r={PORT_R + 1}
              >
                <title>drag onto an actor to feed it this signal</title>
              </circle>
            )}
            {n.ports.map((port) => (
              <circle
                key={port.id}
                className="scene-port"
                data-port-id={port.id}
                cx={port.at.x}
                cy={port.at.y}
                r={PORT_R}
              />
            ))}
          </g>
        );
      })}
      {/* on top of everything, empty: token travel draws its dots here */}
      <g className="token-layer" />
    </svg>
  );
});
