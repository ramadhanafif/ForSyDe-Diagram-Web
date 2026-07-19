import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { IRSystem } from '../core/ir';
import { isDelay } from '../core/ir';
import type { ScheduleResult } from '../core/schedule';

export const NODE_KIND = { actor: 'actor', delay: 'delay', io: 'io' } as const;

/** Extra data render.ts reads back from the laid-out graph. */
export interface NodeMeta {
  kind: (typeof NODE_KIND)[keyof typeof NODE_KIND];
  label: string;
  sublabel?: string;
  badge?: string;
}

export interface EdgeMeta {
  signal: string;
  sourceRate: number;
  targetRate: number;
  buffer?: number;
}

const CHAR_W = 8.2;

function nodeSize(label: string, sublabel?: string): { width: number; height: number } {
  const chars = Math.max(label.length, (sublabel ?? '').length);
  return { width: Math.max(72, chars * CHAR_W + 24), height: sublabel ? 52 : 40 };
}

export function buildElkGraph(ir: IRSystem, sched: ScheduleResult | null): ElkNode {
  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];
  const scheduled = sched?.ok ? sched : null;

  const meta = new Map<string, NodeMeta>();
  const edgeMeta = new Map<string, EdgeMeta>();

  for (const p of ir.processes) {
    if (isDelay(p)) {
      meta.set(p.name, { kind: 'delay', label: `[${p.tokens.join(', ')}]` });
      children.push({
        id: p.name,
        width: Math.max(44, p.tokens.join(', ').length * CHAR_W + 20),
        height: 28,
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
        ports: portList(p.name, ir),
      });
    } else {
      const badge = scheduled?.repetitions.get(p.name);
      meta.set(p.name, {
        kind: 'actor',
        label: p.name,
        sublabel: p.function === 'NULL' ? '⊥' : p.function,
        badge: badge !== undefined ? `×${badge}` : undefined,
      });
      children.push({
        id: p.name,
        ...nodeSize(p.name, p.function),
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
        ports: portList(p.name, ir),
      });
    }
  }

  for (const io of ir.inputs) {
    meta.set(io, { kind: 'io', label: io });
    children.push({
      id: io,
      ...nodeSize(io),
      height: 28,
      layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST' },
    });
  }
  for (const io of ir.outputs) {
    meta.set(io, { kind: 'io', label: io });
    children.push({
      id: io,
      ...nodeSize(io),
      height: 28,
      layoutOptions: { 'elk.layered.layering.layerConstraint': 'LAST' },
    });
  }

  const bufferFor = (signal: string): number | undefined => {
    if (!scheduled) return undefined;
    const key = scheduled.aliases.get(signal) ?? signal;
    return scheduled.buffers.find(([name]) => name === key)?.[1];
  };

  for (const s of ir.signals) {
    // system-output signals target their own name, which is also a node id
    const id = `e_${s.name}_${s.source.name}_${s.target.name}`;
    edgeMeta.set(id, {
      signal: s.name,
      sourceRate: s.source.rate,
      targetRate: s.target.rate,
      buffer: bufferFor(s.name),
    });
    edges.push({
      id,
      sources: [portId(s.source.name, s.name, 'out', ir)],
      targets: [portId(s.target.name, s.name, 'in', ir)],
    });
  }

  const graph: ElkNode = {
    id: '$root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.edgeNode': '16',
    },
    children,
    edges,
  };
  return Object.assign(graph, { $meta: meta, $edgeMeta: edgeMeta });
}

function isProcess(name: string, ir: IRSystem): boolean {
  return ir.processes.some((p) => p.name === name);
}

function portId(node: string, signal: string, dir: 'in' | 'out', ir: IRSystem): string {
  return isProcess(node, ir) ? `${node}.${dir}.${signal}` : node;
}

function portList(name: string, ir: IRSystem): ElkNode['ports'] {
  const ports: NonNullable<ElkNode['ports']> = [];
  for (const s of ir.signals) {
    if (s.target.name === name) {
      ports.push({
        id: `${name}.in.${s.name}`,
        width: 2,
        height: 2,
        layoutOptions: { 'elk.port.side': 'WEST' },
      });
    }
    if (s.source.name === name) {
      ports.push({
        id: `${name}.out.${s.name}`,
        width: 2,
        height: 2,
        layoutOptions: { 'elk.port.side': 'EAST' },
      });
    }
  }
  return ports;
}
