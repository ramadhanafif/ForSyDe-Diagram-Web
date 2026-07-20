import type { Edge, Node } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { EdgeMeta, NodeMeta } from './toElk';

/** A handle (elk port) position relative to its node. */
export interface PortPos {
  id: string;
  kind: 'in' | 'out';
  x: number;
  y: number;
}

export interface FlowNodeData extends Record<string, unknown> {
  meta: NodeMeta;
  ports: PortPos[];
  width: number;
  height: number;
}

export interface FlowEdgeData extends Record<string, unknown> {
  meta: EdgeMeta;
  /** Elk's routed points (absolute flow coordinates), start to end. */
  points: { x: number; y: number }[];
  showUnitRates: boolean;
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge<FlowEdgeData>;

interface Section {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  bendPoints?: { x: number; y: number }[];
}

/** Laid-out elk graph -> React Flow nodes and edges. Elk owns all geometry. */
export function toFlow(
  graph: ElkNode,
  meta: Map<string, NodeMeta>,
  edgeMeta: Map<string, EdgeMeta>,
  showUnitRates: boolean,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  for (const child of graph.children ?? []) {
    const m = meta.get(child.id);
    if (!m) continue;
    const width = child.width ?? 0;
    const height = child.height ?? 0;
    const ports: PortPos[] = (child.ports ?? []).map((p) => ({
      id: p.id,
      kind: p.id.includes('.in.') ? 'in' : 'out',
      x: p.x ?? 0,
      y: p.y ?? 0,
    }));
    nodes.push({
      id: child.id,
      type: m.kind,
      position: { x: child.x ?? 0, y: child.y ?? 0 },
      width,
      height,
      draggable: false,
      data: { meta: m, ports, width, height },
    });
  }

  const edges: FlowEdge[] = [];
  for (const e of graph.edges ?? []) {
    const m = edgeMeta.get(e.id);
    if (!m) continue;
    const section = (e as { sections?: Section[] }).sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const [srcRef, tgtRef] = [e.sources[0] ?? '', e.targets[0] ?? ''];
    edges.push({
      id: e.id,
      type: 'elk',
      source: srcRef.split('.')[0]!,
      target: tgtRef.split('.')[0]!,
      sourceHandle: srcRef.includes('.') ? srcRef : undefined,
      targetHandle: tgtRef.includes('.') ? tgtRef : undefined,
      interactionWidth: 14,
      data: { meta: m, points, showUnitRates },
    });
  }
  return { nodes, edges };
}
