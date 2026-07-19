import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { IRSystem } from '../core/ir';
import { isDelay } from '../core/ir';
import type { ScheduleResult } from '../core/schedule';

/** Extra data render.ts reads back from the laid-out graph. */
export interface NodeMeta {
  kind: 'actor' | 'delay' | 'io';
  /** Process name, shown outside above the circle (math-italic style). */
  label: string;
  /** Stacked lines inside the circle: constructor / rates / function. */
  stack?: string[];
  badge?: string;
}

export interface EdgeMeta {
  signal: string;
  sourceRate: number;
  targetRate: number;
  buffer?: number;
}

const CHAR_W = 7.5;

/** Circle diameter fitting the widest stacked line (forsyde figure style). */
function circleSize(stack: string[]): { width: number; height: number } {
  const chars = Math.max(...stack.map((s) => s.length), 4);
  const d = Math.max(56, chars * CHAR_W + 18);
  return { width: d, height: d };
}

function rateGroup(rates: number[]): string {
  return rates.length === 1 ? String(rates[0]) : `(${rates.join(',')})`;
}

export function buildElkGraph(ir: IRSystem, sched: ScheduleResult | null): ElkNode {
  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];
  const scheduled = sched?.ok ? sched : null;

  const meta = new Map<string, NodeMeta>();
  const edgeMeta = new Map<string, EdgeMeta>();

  for (const p of ir.processes) {
    const badge = scheduled?.repetitions.get(p.name);
    const stack = isDelay(p)
      ? ['delaySDF', `[${p.tokens.join(',')}]`]
      : [
          `actor${p.type.slice(5)}SDF`,
          `${rateGroup(p.inRates)} ${rateGroup(p.outRates)}`,
          p.function === 'NULL' ? '⊥' : p.function,
        ];
    meta.set(p.name, {
      kind: isDelay(p) ? 'delay' : 'actor',
      label: p.name,
      stack,
      badge: !isDelay(p) && badge !== undefined ? `×${badge}` : undefined,
    });
    children.push({
      id: p.name,
      ...circleSize(stack),
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: portList(p.name, ir),
    });
  }

  for (const io of ir.inputs) {
    meta.set(io, { kind: 'io', label: io });
    children.push({
      id: io,
      width: Math.max(30, io.length * CHAR_W),
      height: 20,
      layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST' },
    });
  }
  for (const io of ir.outputs) {
    meta.set(io, { kind: 'io', label: io });
    children.push({
      id: io,
      width: Math.max(30, io.length * CHAR_W),
      height: 20,
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
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '44',
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
