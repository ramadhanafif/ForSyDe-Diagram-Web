import {
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import type { DiagramGraph } from './toElk';
import { toFlow, type FlowEdge, type FlowNode } from './toFlow';
import { nodeTypes } from './nodes';
import { edgeTypes } from './ElkEdge';

export interface DiagramCallbacks {
  onNodeClick(id: string, x: number, y: number): void;
  onEdgeClick(edgeId: string, x: number, y: number): void;
  onPaneClick(): void;
  onConnect(sourceHandle: string, targetHandle: string): void;
  isValidConnection(sourceHandle: string, targetHandle: string): boolean;
}

interface Props extends DiagramCallbacks {
  dg: DiagramGraph | null;
  showUnitRates: boolean;
  stale: boolean;
  /** Increment to request a fit-to-view (Fit button). */
  fitRequest: number;
  /** Polled after each graph update; returns true when a fit is pending (example load). */
  consumePendingFit(): boolean;
}

function Diagram(props: Props) {
  const { dg, showUnitRates, fitRequest, consumePendingFit } = props;
  const { fitView } = useReactFlow();

  const computed = useMemo(
    () => (dg ? toFlow(dg.graph, dg.meta, dg.edgeMeta, showUnitRates) : { nodes: [], edges: [] }),
    [dg, showUnitRates],
  );

  // node positions are live (draggable); edges/labels derive from them below
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  useEffect(() => setNodes(computed.nodes), [computed, setNodes]);

  // translate elk path endpoints by each node's drag delta so edges follow;
  // ponytail: only endpoints move, mid-bends reroute at the next re-layout
  const edges: FlowEdge[] = useMemo(() => {
    const delta = new Map<string, { dx: number; dy: number }>();
    for (const n of nodes) {
      const orig = computed.nodes.find((o) => o.id === n.id);
      if (!orig) continue;
      const dx = n.position.x - orig.position.x;
      const dy = n.position.y - orig.position.y;
      if (dx || dy) delta.set(n.id, { dx, dy });
    }
    if (!delta.size) return computed.edges;
    return computed.edges.map((e) => {
      const ds = delta.get(e.source);
      const dt = delta.get(e.target);
      if (!ds && !dt) return e;
      const points = e.data!.points.map((p, i, arr) => {
        if (i === 0 && ds) return { x: p.x + ds.dx, y: p.y + ds.dy };
        if (i === arr.length - 1 && dt) return { x: p.x + dt.dx, y: p.y + dt.dy };
        return p;
      });
      return { ...e, data: { ...e.data!, points } };
    });
  }, [computed, nodes]);

  const handledFit = useRef(0);
  useEffect(() => {
    const pending = consumePendingFit();
    if ((fitRequest !== handledFit.current || pending) && nodes.length) {
      handledFit.current = fitRequest;
      void fitView({ padding: 0.08, maxZoom: 2, duration: 150 });
    }
  }, [fitRequest, nodes, fitView, consumePendingFit]);

  const w = dg?.graph.width ?? 0;
  const h = dg?.graph.height ?? 0;

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={0.1}
      maxZoom={4}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      edgesFocusable={false}
      onNodeClick={(ev, node) => {
        if (node.type !== 'io') props.onNodeClick(node.id, ev.clientX, ev.clientY);
      }}
      onEdgeClick={(ev, edge: Edge) => props.onEdgeClick(edge.id, ev.clientX, ev.clientY)}
      onPaneClick={() => props.onPaneClick()}
      onConnect={(c: Connection) => {
        if (c.sourceHandle && c.targetHandle) props.onConnect(c.sourceHandle, c.targetHandle);
      }}
      isValidConnection={(c) =>
        !!c.sourceHandle &&
        !!c.targetHandle &&
        props.isValidConnection(c.sourceHandle, c.targetHandle)
      }
    >
      <svg width="0" height="0">
        <defs>
          <marker
            id="fsd-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" />
          </marker>
        </defs>
      </svg>
      {dg && (
        <ViewportPortal>
          <div
            className="system-boundary-box"
            style={{
              position: 'absolute',
              transform: 'translate(-16px, -16px)',
              width: w + 32,
              height: h + 32,
            }}
          />
          <div
            className="system-label"
            style={{ position: 'absolute', transform: `translate(${w / 2 - 24}px, -40px)` }}
          >
            System
          </div>
        </ViewportPortal>
      )}
      <MiniMap
        position="top-right"
        pannable
        zoomable
        nodeClassName={(n) => `mm-${n.type ?? 'io'}`}
      />
    </ReactFlow>
  );
}

export function DiagramPane(props: Props) {
  return (
    <div className={`diagram-wrap${props.stale ? ' stale' : ''}`}>
      <ReactFlowProvider>
        <Diagram {...props} />
      </ReactFlowProvider>
    </div>
  );
}
