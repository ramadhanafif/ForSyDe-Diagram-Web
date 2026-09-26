import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SceneModel } from '../app/useScene';
import { addInputError } from '../core/edits';
import { isDelay, type IRSystem } from '../core/ir';
import type { Linked, Target } from '../core/links';
import { editValue, type EditTarget } from '../core/inlineEdit';
import type { Point } from '../core/layoutBlock';
import { pinScene } from '../layout/pin';
import type { DiagramStyle, LabelFlags, Pt, Rect, Scene } from '../scene/types';
import { motionOn, planTravel, runTravel, useLayoutTween, type Travel } from './animate';
import { SceneLabels } from './SceneLabels';
import {
  frameOf,
  NO_MARKS,
  sameHit,
  SceneShapes,
  type ConnectState,
  type Hit,
  type SceneMarks,
} from './SceneShapes';
import { usePanZoom } from './usePanZoom';

export type SceneTarget =
  { kind: 'node'; name: string } | { kind: 'edge'; edgeId: string } | { kind: 'canvas' };

export interface SceneViewProps {
  model: SceneModel | null;
  style: DiagramStyle;
  /** The flags the scene was laid out with; what they hide shows on hover. */
  flags: LabelFlags;
  /** Schedule annotations on; when off, hover does not reveal them either. */
  schedule: boolean;
  stale: boolean;
  /** Simulation state: highlights, buffer strip fills, hover notes. */
  marks?: SceneMarks;
  /** The firing to animate as travelling tokens; null shows the marks as they are. */
  travel?: Travel | null;
  /** Node ids to pulse briefly (freshly inserted). */
  flash: string[];
  /** Increment to request a fit-to-view. */
  fitRequest: number;
  /** Polled after each scene change; true when a fit is pending (example load). */
  /** True once, when a fit is pending for the model with this source (example load, open). */
  consumePendingFit(source: string): boolean;
  /** Coordinates are client coordinates. */
  onNodeClick(id: string, x: number, y: number): void;
  onEdgeClick(edgeId: string, x: number, y: number): void;
  onPaneClick(): void;
  /** `at` is the pointer in scene coordinates, where a canvas add lands. */
  onContextMenu(target: SceneTarget, x: number, y: number, at: Point): void;
  /** Palette chip dropped: on an edge (its id) or on empty canvas (null). */
  onDropInsert(kind: 'actor' | 'delay', edgeId: string | null, at: Point): void;
  /** A node move landed (drag end, arrow key): every node's top-left, which pins the layout. */
  onPin?(positions: Map<string, Point>): void;
  /** A signal dragged onto an actor: add it as a new input (App refuses with a toast). */
  onConnect(signal: string, proc: string): void;
  /** Nodes and edges the editor cursor is on; drawn as .linked. */
  linked?: Linked;
  /** The pointer moved onto (or off, null) a diagram element; the editor marks its source. */
  onHoverTarget?(t: Target | null): void;
  /** Ctrl/Cmd-click: jump the editor to the element's source. */
  onJump?(t: Target): void;
  /** An in-place edit was submitted: apply it, or return why it cannot be. */
  onInlineEdit?(t: EditTarget, text: string): string | null;
}

const DND_TYPE = 'application/forsyde-node';
const OWNED = '[data-node-id],[data-edge-id],[data-owner-node],[data-owner-edge]';

/** The node or edge an event target belongs to, labels included. */
function hitOf(t: EventTarget | null): Hit | null {
  const el = t instanceof Element ? t.closest(OWNED) : null;
  if (!el) return null;
  const node = el.getAttribute('data-node-id') ?? el.getAttribute('data-owner-node');
  if (node) return { kind: 'node', id: node };
  const edge = el.getAttribute('data-edge-id') ?? el.getAttribute('data-owner-edge');
  return edge ? { kind: 'edge', id: edge } : null;
}

const STACK_LINES = ['ctor', 'fn', 'tokens'] as const;

/**
 * The element under the pointer as precisely as the DOM tells: a port or the
 * rate label at it, a line inside a node, else its node or edge.
 */
function targetOf(t: EventTarget | null, model: SceneModel | null): Target | null {
  if (!(t instanceof Element) || !model) return null;
  const ports = new Map(model.scene.nodes.flatMap((n) => n.ports.map((q) => [q.id, q])));
  const portTarget = (id: string | null): Target | null => {
    const q = id ? ports.get(id) : undefined;
    return q ? { kind: 'rate', node: q.node, dir: q.dir, index: q.index } : null;
  };
  const port = t.closest('[data-port-id]');
  if (port) return portTarget(port.getAttribute('data-port-id'));
  const label = t.closest('[data-label-id]');
  const kind = label?.getAttribute('data-label-kind');
  if (label && kind === 'rate') {
    const owner = label.getAttribute('data-label-id')!.replace(/#rate$/, '');
    // a rate at an io pill belongs to the pill's signal
    return portTarget(owner) ?? { kind: 'edge', signal: owner };
  }
  if (label && kind === 'stack') {
    const node = label.getAttribute('data-owner-node') ?? '';
    const line = t.closest('.stack-line');
    const which = STACK_LINES.find((k) => line?.classList.contains(`stack-${k}`));
    return which ? { kind: 'stack', node, line: which } : { kind: 'node', id: node };
  }
  const hit = hitOf(t);
  if (!hit) return null;
  if (hit.kind === 'node') return { kind: 'node', id: hit.id };
  const sig = model.edgeSignals.get(hit.id);
  return sig ? { kind: 'edge', signal: sig.name } : null;
}

const sameTarget = (a: Target | null, b: Target | null) => JSON.stringify(a) === JSON.stringify(b);

/** The field a double-click on this element edits in place, if any. */
function editTargetOf(t: EventTarget | null, model: SceneModel | null): EditTarget | null {
  if (!(t instanceof Element) || !model) return null;
  const label = t.closest('[data-label-id]');
  const kind = label?.getAttribute('data-label-kind');
  const owner = label?.getAttribute('data-owner-node') ?? '';
  if (kind === 'name') return { kind: 'name', node: owner };
  if (kind === 'signal') {
    const sig = model.edgeSignals.get(label!.getAttribute('data-owner-edge') ?? '');
    return sig ? { kind: 'signal', signal: sig.name } : null;
  }
  const line = t.closest('.stack-line');
  if (kind === 'stack' && line?.classList.contains('stack-tokens'))
    return { kind: 'tokens', node: owner };
  if (kind === 'stack' && line?.classList.contains('stack-fn')) return { kind: 'fn', node: owner };
  const target = targetOf(t, model);
  if (target?.kind === 'rate') return target;
  // a modern delay is its token strip
  const node = t.closest('[data-node-id]')?.getAttribute('data-node-id');
  const n = node ? model.scene.nodes.find((x) => x.id === node) : undefined;
  if (n?.shape === 'strip') return { kind: 'tokens', node: n.id };
  return null;
}

/** An edit in place: its field, where it sits (scene coordinates) and its text. */
interface Editing {
  /** The model it was opened on; a different model means the field may be gone. */
  model: SceneModel;
  target: EditTarget;
  box: Rect;
  value: string;
  error: string;
}

/** Empty canvas: not a node, edge, label, or control. */
const isBackground = (t: EventTarget) =>
  t instanceof Element && !t.closest(`${OWNED},[data-label-id],button,.zoom-controls,.inline-edit`);

function edgeElementAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const g = el.closest?.('.scene-edge');
    if (g) return g;
  }
  return null;
}

/** Arrow-key nudge of the focused node, in scene pixels (Shift: far). */
const NUDGE_NEAR = 8;
const NUDGE_FAR = 32;
const NUDGE: Record<string, Pt> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Pointer travel, in client pixels, before a press on a node or port becomes a drag. */
const DRAG_SLOP = 4;

const tokensOf = (ir: IRSystem) =>
  new Map(ir.processes.filter(isDelay).map((d) => [d.name, d.tokens.length]));

/**
 * `next` plus what `prev` shows that `next` lacks: the exiting elements a
 * layout transition fades out. Their tooltips and stack text come from the
 * merged meta. `next` itself when nothing exits.
 */
function withGhosts(prev: SceneModel, next: SceneModel): SceneModel {
  const gone = <T extends { id: string }>(was: T[], now: T[]) => {
    const ids = new Set(now.map((x) => x.id));
    return was.filter((x) => !ids.has(x.id));
  };
  const a = prev.scene;
  const b = next.scene;
  const nodes = gone(a.nodes, b.nodes);
  const edges = gone(a.edges, b.edges);
  const labels = gone(a.labels, b.labels);
  if (!nodes.length && !edges.length && !labels.length) return next;
  return {
    ...next,
    scene: {
      ...b,
      nodes: [...b.nodes, ...nodes],
      edges: [...b.edges, ...edges],
      labels: [...b.labels, ...labels],
    },
    meta: {
      nodes: new Map([...prev.meta.nodes, ...next.meta.nodes]),
      edges: new Map([...prev.meta.edges, ...next.meta.edges]),
    },
    edgeSignals: new Map([...prev.edgeSignals, ...next.edgeSignals]),
  };
}

/** A press on a node or port, until it ends; `active` once it moved past DRAG_SLOP. */
type Gesture = { pointerId: number; x0: number; y0: number; active: boolean } & (
  { kind: 'move'; id: string; base: Pt } | { kind: 'connect'; signal: string; from: Pt }
);

const rateGroup = (rates: number[]) =>
  rates.length === 1 ? String(rates[0]) : `(${rates.join(',')})`;

/** Hover detail: what the flags keep off the diagram for this node or edge. */
function hiddenDetail(model: SceneModel, hit: Hit, flags: LabelFlags, schedule: boolean) {
  const lines: string[] = [];
  if (hit.kind === 'node') {
    const p = model.ir.processes.find((q) => q.name === hit.id);
    const m = model.meta.nodes.get(hit.id);
    if (!p || !m) return lines;
    for (const l of m.stack)
      if ((l.kind === 'ctor' && !flags.constructors) || (l.kind === 'fn' && !flags.functions))
        lines.push(l.text);
    if (!flags.rates && !isDelay(p))
      lines.push(`rates ${rateGroup(p.inRates)} → ${rateGroup(p.outRates)}`);
    if (schedule && !flags.repetitions && m.repetitions !== undefined)
      lines.push(`fires ×${m.repetitions} per iteration`);
    return lines;
  }
  const s = model.edgeSignals.get(hit.id);
  if (!s) return lines;
  if (!flags.signals) lines.push(`signal ${s.name}`);
  if (!flags.rates) lines.push(`rates ${s.source.rate} → ${s.target.rate}`);
  const buffer = model.meta.edges.get(hit.id)?.buffer;
  if (schedule && !flags.buffers && buffer !== undefined) lines.push(`buf ${buffer}`);
  return lines;
}

/**
 * Level of detail by zoom: far out only shapes and names are readable, so the
 * rest is hidden (by CSS, nothing moves) and the hover card lists it instead.
 */
export type Lod = 'near' | 'mid' | 'far';
export const LOD_MID = 0.55;
export const LOD_FAR = 0.3;
export const lodOf = (k: number): Lod => (k < LOD_FAR ? 'far' : k < LOD_MID ? 'mid' : 'near');

/** The SHOW flags as the zoom level leaves them: what it hides counts as switched off. */
export function lodFlags(flags: LabelFlags, lod: Lod): LabelFlags {
  if (lod === 'near') return flags;
  const off = { ...flags, rates: false, buffers: false, repetitions: false };
  return { ...off, constructors: false, functions: false, signals: lod === 'mid' && flags.signals };
}

/** Where the hover card hangs, in scene coordinates: under a node, at an edge's middle. */
function anchorOf(scene: Scene, hit: Hit): Pt | null {
  if (hit.kind === 'node') {
    const n = scene.nodes.find((q) => q.id === hit.id);
    return n ? { x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h } : null;
  }
  const pts = scene.edges.find((e) => e.id === hit.id)?.points;
  if (!pts?.length) return null;
  return pts.length === 2
    ? { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
    : pts[Math.floor(pts.length / 2)]!;
}

/**
 * The live diagram: an SVG layer for shapes and edges and an HTML layer for
 * labels, both inside one pan/zoom transform. Clicks, hover, keyboard,
 * context menu and palette drops resolve to a node or edge id here; the
 * editing itself happens in App.
 */
export function SceneView(p: SceneViewProps) {
  const { pane: wrap, view, bind, fit, zoomBy } = usePanZoom(isBackground);
  const [selected, setSelected] = useState<Hit | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [editingState, setEditing] = useState<Editing | null>(null);
  // an edit opened on an older model is not shown: its field may have moved or gone
  const editing = editingState?.model === p.model ? editingState : null;
  // the precise element under the pointer, reported only when it changes
  const hoverTarget = useRef<Target | null>(null);
  const dropEdge = useRef<Element | null>(null);
  const { model, fitRequest, consumePendingFit, travel } = p;
  const scene = model?.scene ?? null;

  // what React draws: the model, plus exiting elements while a layout transition fades them
  const [drawn, setDrawn] = useState(() => ({
    model,
    display: model,
    tokens: model ? tokensOf(model.ir) : new Map<string, number>(),
  }));
  if (model !== drawn.model) {
    const ghosts = model && drawn.display && motionOn() ? withGhosts(drawn.display, model) : model;
    setDrawn({
      model,
      display: ghosts,
      tokens: new Map([
        ...(ghosts !== model ? drawn.tokens : []),
        ...(model ? tokensOf(model.ir) : []),
      ]),
    });
  }
  const display = model === drawn.model ? drawn.display : model;
  const settle = useCallback(
    () => setDrawn((v) => (v.display === v.model ? v : { ...v, display: v.model })),
    [],
  );

  // node drag: the dragged node at the pointer, every edge re-routed live; the
  // positions are handed to App (onPin) when the drag lands
  const [dragAt, setDragAt] = useState<{ scene: Scene; id: string; at: Pt } | null>(null);
  const held = scene && dragAt?.scene === scene ? dragAt : null;
  const shown = useMemo(
    () =>
      display && held
        ? { ...display, scene: pinScene(display.scene, new Map([[held.id, held.at]])) }
        : display,
    [display, held],
  );
  /** Every node's top-left in `sc`, rounded, with `id` moved to `at`: a whole pinned layout. */
  const pinAll = (sc: Scene, id: string, at: Pt) =>
    new Map(
      sc.nodes.map((n) => {
        const q = n.id === id ? at : n.box;
        return [n.id, { x: Math.round(q.x), y: Math.round(q.y) }] as const;
      }),
    );
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // a node being dragged is not tweened: a new scene during a drag shows at once
  const dragging = useCallback(
    () => gesture.current?.kind === 'move' && gesture.current.active,
    [],
  );
  const { finish: finishTween, rebase } = useLayoutTween(
    wrap,
    shown?.scene ?? null,
    scene,
    settle,
    dragging,
  );

  // token travel: dots in the token layer, strip fills from the travel until it ends
  const [live, setLive] = useState<{ seq: number; fill: Map<string, number> | null }>({
    seq: -1,
    fill: null,
  });
  const finished = useRef(-1);
  useEffect(() => {
    const layer = wrap.current?.querySelector<SVGGElement>('.token-layer');
    // a re-layout of the same text re-runs this; a finished travel stays finished
    if (!travel || !model || !layer || !motionOn() || finished.current === travel.seq) return;
    const { seq } = travel;
    return runTravel(
      layer,
      // tokens use strip slots only where strips are drawn
      planTravel(model, travel.step, travel.before, p.style === 'modern'),
      travel.ms,
      travel.before,
      (fill) => setLive({ seq, fill }),
      () => {
        finished.current = seq;
        setLive({ seq, fill: null });
      },
    );
  }, [travel, model, wrap, p.style]);
  const baseMarks = p.marks ?? NO_MARKS;
  const fill =
    travel && motionOn()
      ? ((live.seq === travel.seq ? live.fill : travel.before) ?? baseMarks.fill)
      : baseMarks.fill;
  const marks = useMemo(
    () => (fill === baseMarks.fill ? baseMarks : { ...baseMarks, fill }),
    [baseMarks, fill],
  );
  // a drag or pan ends with a click on the pane; it must not act as one
  const swallowClick = useRef(false);
  const downAt = useRef<Pt | null>(null);

  const handledFit = useRef(0);
  // a layout effect: a jump and the rebased transition frame must reach the same paint
  useLayoutEffect(() => {
    if (!scene || !model) return;
    // a pending fit is consumed only once a scene exists to fit
    const pending = consumePendingFit(model.source);
    if (fitRequest !== handledFit.current || pending) {
      handledFit.current = fitRequest;
      // during a layout transition the view jumps and the transition absorbs it
      fit(frameOf(scene.bounds), (a, b) =>
        rebase(a.k / b.k, { x: (a.tx - b.tx) / b.k, y: (a.ty - b.ty) / b.k }),
      );
    }
  }, [fitRequest, scene, model, fit, consumePendingFit, rebase]);

  /** Client point a popover for `hit` hangs from: under a node, at an edge's middle. */
  const anchorAt = (hit: Hit): Pt | null => {
    const attr = hit.kind === 'node' ? 'data-node-id' : 'data-edge-id';
    const el = wrap.current?.querySelector(`[${attr}="${CSS.escape(hit.id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: hit.kind === 'node' ? r.y + r.height : r.y + r.height / 2 };
  };
  const open = (hit: Hit, x: number, y: number) => {
    // mid-transition the element is still on its way: anchor the popover where it lands
    if (finishTween()) ({ x, y } = anchorAt(hit) ?? { x, y });
    setSelected(hit);
    if (hit.kind === 'node') p.onNodeClick(hit.id, x, y);
    else p.onEdgeClick(hit.id, x, y);
  };
  const setDropEdge = (g: Element | null) => {
    if (dropEdge.current === g) return;
    dropEdge.current?.classList.remove('drop-target');
    g?.classList.add('drop-target');
    dropEdge.current = g;
  };

  const toScene = (cx: number, cy: number): Pt => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k };
  };

  /** Open an in-place edit over `el` for field `t`. */
  const startEdit = (t: EditTarget, el: Element) => {
    if (!p.model || !p.onInlineEdit) return;
    const value = editValue(p.model.ir, t);
    if (value === null) return;
    const r = el.getBoundingClientRect();
    const a = toScene(r.left, r.top);
    p.onPaneClick();
    setEditing({
      model: p.model,
      target: t,
      box: { x: a.x, y: a.y, w: r.width / view.k, h: r.height / view.k },
      value,
      error: '',
    });
  };
  const submitEdit = () => {
    if (!editing || !p.onInlineEdit) return;
    const error = p.onInlineEdit(editing.target, editing.value);
    if (error) setEditing({ ...editing, error });
    else setEditing(null);
  };

  /** The actor a connection would land on: its add-input handle, or anywhere on it. */
  const connectTarget = (cx: number, cy: number): string | null => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const handle = el.closest('[data-new-input]');
      if (handle) return handle.getAttribute('data-new-input');
      const hit = hitOf(el);
      if (
        hit?.kind === 'node' &&
        shown?.scene.nodes.some((n) => n.id === hit.id && n.kind === 'actor')
      )
        return hit.id;
    }
    return null;
  };

  /** A press that may become a drag: on an out port or io node it connects, on a node it moves. */
  const startGesture = (e: React.PointerEvent): boolean => {
    if (e.button !== 0 || !shown) return false;
    const t = e.target as Element;
    const hit = hitOf(t);
    if (hit?.kind !== 'node') return false;
    const node = shown.scene.nodes.find((n) => n.id === hit.id);
    if (!node) return false;
    const base = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, active: false };
    const port = node.ports.find(
      (q) => q.id === t.closest('[data-port-id]')?.getAttribute('data-port-id'),
    );
    if (port?.dir === 'out') {
      gesture.current = { ...base, kind: 'connect', signal: port.signal, from: port.at };
    } else if (node.kind === 'io' && t.closest('[data-io-handle]')) {
      // an io node is its signal: drag its handle onto an actor to feed it
      const b = node.box;
      gesture.current = {
        ...base,
        kind: 'connect',
        signal: node.id,
        from: { x: b.x + b.w, y: b.y + b.h / 2 },
      };
    } else if (!port && !t.closest('[data-new-input]')) {
      gesture.current = {
        ...base,
        kind: 'move',
        id: node.id,
        base: { x: node.box.x, y: node.box.y },
      };
    } else return false;
    return true;
  };

  const moveGesture = (e: React.PointerEvent) => {
    const g = gesture.current!;
    if (!g.active && e.buttons === 0) {
      // released outside the pane before it became a drag (no capture yet): no pointerup came
      gesture.current = null;
      return;
    }
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.active) {
      if (Math.hypot(dx, dy) < DRAG_SLOP || !model) return;
      g.active = true;
      swallowClick.current = true;
      // a drag works on the settled geometry: ports, drop targets, the dragged node
      finishTween();
      wrap.current?.setPointerCapture(e.pointerId);
      if (g.kind === 'connect') {
        const actors = model.scene.nodes.filter((n) => n.kind === 'actor').map((n) => n.id);
        setConnect({
          from: g.from,
          to: toScene(e.clientX, e.clientY),
          over: null,
          valid: new Set(actors.filter((a) => addInputError(model.ir, a, g.signal) === null)),
        });
      }
    }
    if (g.kind === 'move' && scene) {
      setDragAt({ scene, id: g.id, at: { x: g.base.x + dx / view.k, y: g.base.y + dy / view.k } });
    } else if (g.kind === 'connect') {
      const to = toScene(e.clientX, e.clientY);
      const over = connectTarget(e.clientX, e.clientY);
      setConnect((c) => c && { ...c, to, over });
    }
  };

  const own = (e: React.PointerEvent) => gesture.current?.pointerId === e.pointerId;

  const endGesture = (e: React.PointerEvent, commit: boolean) => {
    const g = gesture.current!;
    gesture.current = null;
    setConnect(null);
    if (g.kind === 'move') {
      // a landed drag pins every node where it is now; a cancelled one snaps back
      if (commit && g.active && held && display) p.onPin?.(pinAll(display.scene, held.id, held.at));
      setDragAt(null);
      return;
    }
    if (!commit || !g.active) return;
    const proc = connectTarget(e.clientX, e.clientY);
    if (proc) p.onConnect(g.signal, proc);
  };

  // no card over the selected element, whose popover opens at the same spot
  const lod = lodOf(view.k);
  const detail =
    model && hover && !sameHit(hover, selected) && !connect
      ? [
          ...(marks.notes.get(hover.id) ?? []),
          ...hiddenDetail(model, hover, lodFlags(p.flags, lod), p.schedule),
        ]
      : [];
  const anchor = shown && hover && detail.length ? anchorOf(shown.scene, hover) : null;

  return (
    <div
      ref={wrap}
      className={`diagram-wrap${p.stale ? ' stale' : ''}${connect ? ' connecting' : ''}`}
      onPointerDown={(e) => {
        // one gesture at a time: a second finger during a node drag is ignored
        if (gesture.current) return;
        swallowClick.current = false;
        downAt.current = { x: e.clientX, y: e.clientY };
        if (!startGesture(e)) bind.onPointerDown(e);
      }}
      onPointerMove={(e) => (own(e) ? moveGesture(e) : bind.onPointerMove(e))}
      onPointerUp={(e) => (own(e) ? endGesture(e, true) : bind.onPointerUp(e))}
      onPointerCancel={(e) => (own(e) ? endGesture(e, false) : bind.onPointerCancel(e))}
      onClick={(e) => {
        const d = downAt.current;
        const panned = !!d && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_SLOP;
        if (swallowClick.current || panned) {
          swallowClick.current = false;
          return;
        }
        // Ctrl/Cmd-click reads the element in the source instead of editing it
        if ((e.ctrlKey || e.metaKey) && p.onJump) {
          const t = targetOf(e.target, p.model);
          if (t) return p.onJump(t);
        }
        const hit = hitOf(e.target);
        if (hit) open(hit, e.clientX, e.clientY);
        else if (isBackground(e.target)) {
          setSelected(null);
          p.onPaneClick();
        }
      }}
      onPointerOver={(e) => {
        const hit = hitOf(e.target);
        setHover((cur) => (sameHit(cur, hit) ? cur : hit));
        const t = targetOf(e.target, p.model);
        if (!sameTarget(t, hoverTarget.current)) {
          hoverTarget.current = t;
          p.onHoverTarget?.(t);
        }
      }}
      onPointerLeave={() => {
        setHover(null);
        if (hoverTarget.current) {
          hoverTarget.current = null;
          p.onHoverTarget?.(null);
        }
      }}
      onDoubleClick={(e) => {
        const t = editTargetOf(e.target, p.model);
        const el =
          e.target instanceof Element ? e.target.closest('[data-label-id],[data-node-id]') : null;
        if (t && el) startEdit(t, el);
      }}
      onKeyDown={(e) => {
        // F2 renames the focused process in place, over its name
        if (e.key === 'F2') {
          const id = hitOf(e.target)?.id;
          const name =
            id && wrap.current?.querySelector(`[data-label-id="${CSS.escape(id)}#name"]`);
          if (name) {
            e.preventDefault();
            startEdit({ kind: 'name', node: id }, name);
          }
          return;
        }
        // arrow keys nudge the focused node, which pins the layout like a drag
        const nudge = NUDGE[e.key];
        if (nudge && display && p.onPin) {
          const id = hitOf(e.target)?.kind === 'node' ? hitOf(e.target)!.id : null;
          const n = id ? display.scene.nodes.find((x) => x.id === id) : undefined;
          if (!n) return;
          e.preventDefault();
          const step = e.shiftKey ? NUDGE_FAR : NUDGE_NEAR;
          p.onPin(
            pinAll(display.scene, n.id, {
              x: n.box.x + nudge.x * step,
              y: n.box.y + nudge.y * step,
            }),
          );
          return;
        }
        // keyboard path into editing: Enter or Space on a focused node; keys on
        // anything else (the zoom buttons) keep their own meaning
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const hit = hitOf(e.target);
        if (!hit) return;
        const at = anchorAt(hit);
        if (!at) return;
        // the popover autofocuses an input; this Enter must not also submit it
        e.preventDefault();
        open(hit, at.x, at.y);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = toScene(e.clientX, e.clientY);
        const hit = hitOf(e.target);
        if (hit?.kind === 'node')
          p.onContextMenu({ kind: 'node', name: hit.id }, e.clientX, e.clientY, at);
        else if (hit) p.onContextMenu({ kind: 'edge', edgeId: hit.id }, e.clientX, e.clientY, at);
        else if (isBackground(e.target))
          p.onContextMenu({ kind: 'canvas' }, e.clientX, e.clientY, at);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropEdge(edgeElementAt(e.clientX, e.clientY));
      }}
      onDragLeave={() => setDropEdge(null)}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData(DND_TYPE);
        if (kind !== 'actor' && kind !== 'delay') return;
        e.preventDefault();
        const edgeId = edgeElementAt(e.clientX, e.clientY)?.getAttribute('data-edge-id') ?? null;
        setDropEdge(null);
        p.onDropInsert(kind, edgeId, toScene(e.clientX, e.clientY));
      }}
    >
      {shown && (
        <div
          className={`scene-viewport${lod === 'near' ? '' : ` lod-${lod}`}`}
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}
        >
          <SceneShapes
            scene={shown.scene}
            style={p.style}
            tokens={drawn.tokens}
            marks={marks}
            selected={selected}
            hover={hover}
            linked={p.linked}
            flash={p.flash}
            connect={connect}
          />
          <SceneLabels model={shown} style={p.style} flags={p.flags} />
          {connect && (
            <svg className="connect-line">
              <line x1={connect.from.x} y1={connect.from.y} x2={connect.to.x} y2={connect.to.y} />
            </svg>
          )}
        </div>
      )}
      {editing && (
        <div
          className="inline-edit"
          style={{
            left: editing.box.x * view.k + view.tx,
            top: editing.box.y * view.k + view.ty,
          }}
        >
          <input
            autoFocus
            aria-label={`edit ${editing.target.kind}`}
            aria-invalid={!!editing.error}
            spellCheck={false}
            // as wide as its text, so it covers the label and not its neighbours
            size={Math.max(4, editing.value.length + 1)}
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value, error: '' })}
            onKeyDown={(e) => {
              // the pane's own Enter and F2 handling must not see these keys
              e.stopPropagation();
              if (e.key === 'Enter') submitEdit();
              else if (e.key === 'Escape') setEditing(null);
            }}
            onBlur={() => setEditing(null)}
          />
          {editing.error && (
            <div className="inline-edit-error" role="alert">
              {editing.error}
            </div>
          )}
        </div>
      )}
      {anchor && (
        <div
          className="hover-card"
          style={{ left: anchor.x * view.k + view.tx, top: anchor.y * view.k + view.ty }}
        >
          {detail.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      <div className="zoom-controls">
        <button data-zoom="in" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1)}>
          +
        </button>
        <button data-zoom="out" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(-1)}>
          −
        </button>
        <button
          data-zoom="fit"
          title="Fit the diagram to the pane"
          aria-label="Fit the diagram to the pane"
          onClick={() => scene && fit(frameOf(scene.bounds))}
        >
          ⤢
        </button>
      </div>
      {!model && (
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
