import type { IRSystem } from '../core/ir';
import type { ScheduleResult } from '../core/schedule';

/**
 * The scene: every piece of diagram geometry as plain data. Layout produces
 * it; the live renderer, exporters and the metrics harness consume it. No
 * DOM, no React. All coordinates are absolute, y grows downward.
 */

export interface Pt {
  x: number;
  y: number;
}

/** Axis-aligned box, top-left corner plus size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'W' | 'E' | 'N' | 'S';

export interface ScenePort {
  /** `${node}.in.${signal}` or `${node}.out.${signal}`; the renderer's data-port-id. */
  id: string;
  node: string;
  signal: string;
  dir: 'in' | 'out';
  /** Function argument (in) or result tuple (out) position, 0-based. */
  index: number;
  side: Side;
  /** Where the edge attaches, on the node outline. */
  at: Pt;
  rate: number;
}

/**
 * strip: a modern-style delay drawn as its initial tokens on the edge (FIFO
 * in src/scene/measure.ts), one port at the middle of each short side.
 */
export type NodeShape = 'circle' | 'stadium' | 'pill' | 'strip';

export interface SceneNode {
  /** Process name, or the signal name for system inputs/outputs. */
  id: string;
  kind: 'actor' | 'delay' | 'io';
  shape: NodeShape;
  box: Rect;
  ports: ScenePort[];
  /** Layer (column) and position within it; the next layout uses them for stability. */
  layer: number;
  order: number;
}

/**
 * name: process name above the node. badge: repetition count. stack: text
 * inside the node (constructor, function, delay tokens). signal: signal name
 * on its edge. rate: token rate at a port. buffer: buffer size, 'buf N';
 * the modern style draws it as a FIFO strip of N slots.
 */
export type LabelKind = 'name' | 'badge' | 'stack' | 'signal' | 'rate' | 'buffer';

export interface SceneLabel {
  id: string;
  kind: LabelKind;
  /** Node id (name/badge/stack), edge id (signal/buffer) or port id (rate). */
  owner: string;
  text: string;
  box: Rect;
}

export interface SceneEdge {
  /** `e_${signal}_${source}_${target}`, as today's edge ids. */
  id: string;
  signal: string;
  /** Source port id, or the io node id for a system input. */
  source: string;
  /** Target port id, or the io node id for a system output. */
  target: string;
  /** Orthogonal polyline from the source attach point to the target attach point. */
  points: Pt[];
  /** Drawn against the flow direction (closes a cycle). */
  feedback: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  labels: SceneLabel[];
  /** Box enclosing every node, edge point and label. */
  bounds: Rect;
}

/** Which labels are visible; hidden labels take no space. */
export interface LabelFlags {
  signals: boolean;
  rates: boolean;
  /** Also show rates equal to 1. */
  unitRates: boolean;
  buffers: boolean;
  repetitions: boolean;
  constructors: boolean;
  functions: boolean;
}

export type DiagramStyle = 'modern' | 'lecture';

/** Text size for a label kind. Browser: canvas measureText; tests: estimate. */
export type Measure = (text: string, kind: LabelKind) => { w: number; h: number };

export interface LayoutInput {
  ir: IRSystem;
  schedule: ScheduleResult | null;
  flags: LabelFlags;
  measure: Measure;
  /** Delay notation: a circle (lecture, the default) or an on-edge token strip (modern). */
  style?: DiagramStyle;
  /** Previous scene: when scores tie, keep its layer/order (stability). */
  prev?: Scene;
}

export type Layout = (input: LayoutInput) => Scene;
