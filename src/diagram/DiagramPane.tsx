import {
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../core/layoutBlock';
import { GRAPH_PADDING, type DiagramGraph } from './toElk';
import { toFlow, type FlowEdge, type FlowNode } from './toFlow';
import { nodeTypes } from './nodes';
import { edgeTypes } from './ElkEdge';

export interface DiagramCallbacks {
  onNodeClick(id: string, x: number, y: number): void;
  onEdgeClick(edgeId: string, x: number, y: number): void;
  onPaneClick(): void;
  /** Right-click hit: node (its data-id), edge, or empty canvas. Coords are client; `at` is the flow point. */
  onContextMenu(
    target: { kind: 'node'; name: string } | { kind: 'edge'; edgeId: string } | { kind: 'canvas' },
    x: number,
    y: number,
    at: Point,
  ): void;
  onConnect(sourceHandle: string, targetHandle: string): void;
  isValidConnection(sourceHandle: string, targetHandle: string): boolean;
  /** Palette chip dropped: on an edge (its id) or on empty canvas (null), at a flow point. */
  onDropInsert(kind: 'actor' | 'delay', edgeId: string | null, at: Point): void;
  /** A node drag ended: every node's current position, which pins the layout. */
  onPin(positions: Map<string, Point>): void;
  /** A connection gesture ended on a handle but was refused. */
  onConnectRefused(sourceHandle: string, targetHandle: string): void;
}

const DND_TYPE = 'application/forsyde-node';

/** Fit-to-view framing: padding fraction, zoom cap, and animation time. */
const FIT_PADDING = 0.08;
const FIT_MAX_ZOOM = 2;
const FIT_DURATION_MS = 150;
/** Zoom limits on the canvas. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

function edgeElementAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const g = el.closest?.('.react-flow__edge');
    if (g) return g;
  }
  return null;
}

/** Per-annotation visibility, driven by the floating toggles in the pane. */
export interface ShowFlags {
  signals: boolean;
  rates: boolean;
  buffers: boolean;
  repetitions: boolean;
  constructors: boolean;
  functions: boolean;
}

export const DEFAULT_FLAGS: ShowFlags = {
  signals: true,
  rates: true,
  buffers: true,
  repetitions: true,
  constructors: true,
  functions: true,
};

interface Props extends DiagramCallbacks {
  dg: DiagramGraph | null;
  showUnitRates: boolean;
  stale: boolean;
  showFlags: ShowFlags;
  /** Node ids to pulse briefly (freshly inserted). */
  flash: string[];
  /** Increment to request a fit-to-view (Fit button). */
  fitRequest: number;
  /** Polled after each graph update; returns true when a fit is pending (example load). */
  consumePendingFit(): boolean;
  /** Pinned node positions by id; empty means elk's layout as is. */
  positions: Map<string, Point>;
}

function Diagram(props: Props) {
  const { dg, showUnitRates, fitRequest, consumePendingFit, positions } = props;
  const { fitView } = useReactFlow();

  const elk = useMemo(
    () => (dg ? toFlow(dg.graph, dg.meta, dg.edgeMeta, showUnitRates) : { nodes: [], edges: [] }),
    [dg, showUnitRates],
  );
  const computed = useMemo(
    () =>
      positions.size
        ? {
            ...elk,
            nodes: elk.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })),
          }
        : elk,
    [elk, positions],
  );
  // the first drag of an elk layout already routes like a pinned one
  const [dragging, setDragging] = useState(false);
  const pinned = positions.size > 0 || dragging;

  // node positions are live (draggable); edges/labels derive from them below
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const { flash } = props;
  useEffect(() => {
    // a reset mid-drag would snap the dragged node back; drag stop re-runs this
    if (dragging) return;
    setNodes(
      flash.length
        ? computed.nodes.map((n) => (flash.includes(n.id) ? { ...n, className: 'just-added' } : n))
        : computed.nodes,
    );
  }, [computed, setNodes, flash, dragging]);

  const edges: FlowEdge[] = useMemo(
    () =>
      pinned
        ? computed.edges.map((e) => ({ ...e, data: { ...e.data!, pinned: true } }))
        : computed.edges,
    [computed, pinned],
  );

  const handledFit = useRef(0);
  useEffect(() => {
    // only consume the pending-fit flag once nodes exist, otherwise the
    // first-mount run (empty graph) eats it and the initial fit never happens
    if (!nodes.length) return;
    const pending = consumePendingFit();
    if (fitRequest !== handledFit.current || pending) {
      handledFit.current = fitRequest;
      void fitView({ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION_MS });
    }
  }, [fitRequest, nodes, fitView, consumePendingFit]);

  // the boundary hugs elk's graph box, or the live nodes once pinned
  let box = { x: 0, y: 0, w: dg?.graph.width ?? 0, h: dg?.graph.height ?? 0 };
  if (pinned && nodes.length) {
    const x = Math.min(...nodes.map((n) => n.position.x)) - GRAPH_PADDING;
    const y = Math.min(...nodes.map((n) => n.position.y)) - GRAPH_PADDING;
    const r = Math.max(...nodes.map((n) => n.position.x + (n.width ?? 0))) + GRAPH_PADDING;
    const b = Math.max(...nodes.map((n) => n.position.y + (n.height ?? 0))) + GRAPH_PADDING;
    box = { x, y, w: r - x, h: b - y };
  }

  return (
    <ReactFlow
      className={Object.entries(props.showFlags)
        .filter(([, on]) => !on)
        .map(([k]) => `hide-${k}`)
        .join(' ')}
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      edgesFocusable={false}
      // deletion is source-driven (context menu / popover); Backspace must never
      // mutate local flow selection state while the source stays unchanged
      deleteKeyCode={null}
      onNodeClick={(ev, node) => {
        if (node.type !== 'io') props.onNodeClick(node.id, ev.clientX, ev.clientY);
      }}
      onNodeDragStart={() => setDragging(true)}
      onNodeDragStop={(_ev, _node, dragged) => {
        // pin everything, taking the dragged nodes' final positions from the event
        const at = new Map(nodes.map((n) => [n.id, n.position]));
        for (const n of dragged) at.set(n.id, n.position);
        const rounded = new Map<string, Point>();
        for (const [id, p] of at) rounded.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
        setDragging(false);
        props.onPin(rounded);
      }}
      onEdgeClick={(ev, edge: Edge) => props.onEdgeClick(edge.id, ev.clientX, ev.clientY)}
      onPaneClick={() => props.onPaneClick()}
      onConnect={(c: Connection) => {
        if (c.sourceHandle && c.targetHandle) props.onConnect(c.sourceHandle, c.targetHandle);
      }}
      onConnectEnd={(_ev, state) => {
        if (state.toHandle && state.fromHandle && !state.isValid) {
          props.onConnectRefused(state.fromHandle.id ?? '', state.toHandle.id ?? '');
        }
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
              transform: `translate(${box.x - 16}px, ${box.y - 16}px)`,
              width: box.w + 32,
              height: box.h + 32,
            }}
          />
          <div
            className="system-label"
            style={{
              position: 'absolute',
              transform: `translate(${box.x + box.w / 2 - 24}px, ${box.y - 40}px)`,
            }}
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
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}

/** Needs the provider above it: drops convert screen points to flow points. */
function DiagramWrap(props: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const hovered = useRef<Element | null>(null);
  const clearHover = () => {
    hovered.current?.classList.remove('drop-target');
    hovered.current = null;
  };

  return (
    <div
      className={`diagram-wrap${props.stale ? ' stale' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const g = edgeElementAt(e.clientX, e.clientY);
        if (hovered.current !== g) {
          hovered.current?.classList.remove('drop-target');
          g?.classList.add('drop-target');
          hovered.current = g;
        }
      }}
      onDragLeave={clearHover}
      onKeyDown={(e) => {
        // keyboard path into editing: Enter on a selected node or edge
        if (e.key !== 'Enter') return;
        const node = document.querySelector('.react-flow__node.selected');
        if (node) {
          const r = node.getBoundingClientRect();
          props.onNodeClick(node.getAttribute('data-id') ?? '', r.x + r.width / 2, r.y + r.height);
          return;
        }
        const edge = document.querySelector('.react-flow__edge.selected');
        if (edge) {
          const r = edge.getBoundingClientRect();
          props.onEdgeClick(
            edge.getAttribute('data-id') ?? '',
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
        }
      }}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData(DND_TYPE);
        if (kind !== 'actor' && kind !== 'delay') return;
        e.preventDefault();
        const edgeId = edgeElementAt(e.clientX, e.clientY)?.getAttribute('data-id') ?? null;
        clearHover();
        props.onDropInsert(kind, edgeId, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const node = (e.target as Element).closest?.('.react-flow__node')?.getAttribute('data-id');
        if (node) {
          props.onContextMenu({ kind: 'node', name: node }, e.clientX, e.clientY, at);
          return;
        }
        const edgeId = edgeElementAt(e.clientX, e.clientY)?.getAttribute('data-id');
        if (edgeId) props.onContextMenu({ kind: 'edge', edgeId }, e.clientX, e.clientY, at);
        else props.onContextMenu({ kind: 'canvas' }, e.clientX, e.clientY, at);
      }}
    >
      <Diagram {...props} />
      {!props.dg && (
        <div className="empty-canvas">
          <div className="empty-title">No diagram yet</div>
          <div className="empty-hint">
            Fix the errors listed above the editor, or load an example from the toolbar.
          </div>
        </div>
      )}
    </div>
  );
}

export function DiagramPane(props: Props) {
  return (
    <ReactFlowProvider>
      <DiagramWrap {...props} />
    </ReactFlowProvider>
  );
}
