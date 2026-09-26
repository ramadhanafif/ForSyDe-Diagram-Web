import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { SceneModel } from '../app/useScene';
import { isDelay } from '../core/ir';
import { edgeId } from '../scene/labels';
import { FIFO } from '../scene/measure';
import type { Pt, Rect, Scene, SceneEdge } from '../scene/types';
import type { SimStep } from '../sim/simulate';
import {
  ease,
  lengthAt,
  mix,
  pathLength,
  pointAtLength,
  scaleScene,
  slicePath,
  tweenScene,
} from './motion';
import { frameOf, pathD, TITLE_H } from './SceneShapes';

/**
 * Motion on the live DOM: layout transitions and token travel. Both write
 * SVG attributes and label transforms imperatively on each animation frame;
 * React renders only the settled scene.
 */

/** Layout transition length. */
const TWEEN_MS = 250;
/** Dots drawn per edge per firing; beyond that a count badge rides along. */
const MAX_DOTS = 8;
/** About a FIFO slot in size, so a dot reads as the slot it fills or empties. */
const DOT_R = 5;

// ---------------------------------------------------------------------------
// motion switch and the test hook

let override: boolean | null = null;

/** Force motion on or off (tests); null follows prefers-reduced-motion again. */
export const setMotion = (on: boolean | null) => {
  override = on;
};

export const motionOn = () =>
  override ??
  !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

const active = { layout: new Set<object>(), tokens: new Set<object>() };

/** True while a layout transition (or token travel, or either when no kind) runs. */
export const animating = (kind?: 'layout' | 'tokens') =>
  kind ? active[kind].size > 0 : active.layout.size + active.tokens.size > 0;

// ---------------------------------------------------------------------------
// layout transitions

const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** Transform an element drawn at box `r` so it shows at box `f`; none when they agree. */
function svgMap(el: Element | null, r: Rect, f: Rect) {
  if (!el) return;
  if (same(r, f)) return el.removeAttribute('transform');
  const sx = r.w ? f.w / r.w : 1;
  const sy = r.h ? f.h / r.h : 1;
  el.setAttribute('transform', `matrix(${sx} 0 0 ${sy} ${f.x - r.x * sx} ${f.y - r.y * sy})`);
}

/** The same for an HTML label (transform-origin 0 0 in the stylesheet). */
function cssMap(el: HTMLElement, r: Rect, f: Rect) {
  if (same(r, f)) {
    el.style.transform = '';
    return;
  }
  const sx = r.w ? f.w / r.w : 1;
  const sy = r.h ? f.h / r.h : 1;
  el.style.transform = `translate(${f.x - r.x}px, ${f.y - r.y}px) scale(${sx}, ${sy})`;
}

const setAlpha = (el: HTMLElement | SVGElement, a = 1) => {
  el.style.opacity = a >= 1 ? '' : String(Math.max(0, a));
};

/** Opacity keys: one namespace per element kind, since ids may repeat across kinds. */
function keysOf(s: Scene): Set<string> {
  return new Set([
    ...s.nodes.map((n) => `n:${n.id}`),
    ...s.edges.map((e) => `e:${e.id}`),
    ...s.labels.map((l) => `l:${l.id}`),
  ]);
}

const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));

/**
 * Show frame `F` on DOM that React rendered from scene `R`: every element of
 * R is moved from its R geometry to its F geometry (or stays, when F lacks
 * it) and gets its opacity from `alpha`.
 */
function writeFrame(root: Element, R: Scene, F: Scene, alpha: Map<string, number>) {
  const rn = byId(R.nodes);
  const fn = byId(F.nodes);
  for (const g of root.querySelectorAll<SVGGElement>('.scene-svg [data-node-id]')) {
    const id = g.dataset.nodeId!;
    const r = rn.get(id);
    if (!r) continue;
    const f = fn.get(id) ?? r;
    svgMap(g.querySelector('.node-body'), r.box, f.box);
    const at = new Map(f.ports.map((p) => [p.id, p.at]));
    for (const p of r.ports) {
      const el = g.querySelector(`[data-port-id="${CSS.escape(p.id)}"]`);
      const q = at.get(p.id) ?? p.at;
      if (!el) continue;
      if (q.x === p.at.x && q.y === p.at.y) el.removeAttribute('transform');
      else el.setAttribute('transform', `translate(${q.x - p.at.x} ${q.y - p.at.y})`);
    }
    setAlpha(g, alpha.get(`n:${id}`));
  }
  for (const el of root.querySelectorAll<HTMLElement>('.io-label[data-owner-node]')) {
    const id = el.dataset.ownerNode!;
    const r = rn.get(id);
    if (!r) continue;
    cssMap(el, r.box, (fn.get(id) ?? r).box);
    setAlpha(el, alpha.get(`n:${id}`));
  }
  const re = byId(R.edges);
  const fe = byId(F.edges);
  for (const g of root.querySelectorAll<SVGGElement>('.scene-svg [data-edge-id]')) {
    const id = g.dataset.edgeId!;
    const r = re.get(id);
    if (!r) continue;
    const d = pathD((fe.get(id) ?? r).points);
    for (const path of g.querySelectorAll('path')) path.setAttribute('d', d);
    setAlpha(g, alpha.get(`e:${id}`));
  }
  const rl = byId(R.labels);
  const fl = byId(F.labels);
  for (const el of root.querySelectorAll<HTMLElement>('.scene-labels [data-label-id]')) {
    const id = el.dataset.labelId!;
    const r = rl.get(id);
    if (!r) continue;
    cssMap(el, r.box, (fl.get(id) ?? r).box);
    setAlpha(el, alpha.get(`l:${id}`));
  }
  for (const g of root.querySelectorAll<SVGGElement>('.scene-svg [data-strip]')) {
    const id = g.dataset.strip!;
    const r = rl.get(id);
    if (!r) continue;
    svgMap(g, r.box, (fl.get(id) ?? r).box);
    setAlpha(g, alpha.get(`l:${id}`));
  }
  // the boundary and its title, as SceneShapes and SceneLabels place them
  const b = frameOf(F.bounds);
  const box = root.querySelector('.system-boundary');
  box?.setAttribute('x', String(b.x));
  box?.setAttribute('y', String(b.y + TITLE_H));
  box?.setAttribute('width', String(b.w));
  box?.setAttribute('height', String(b.h - TITLE_H));
  const title = root.querySelector<HTMLElement>('.system-label');
  if (title) {
    title.style.left = `${b.x}px`;
    title.style.top = `${b.y}px`;
    title.style.width = `${b.w}px`;
  }
}

interface TweenState {
  el: HTMLElement | null;
  /** The layout's scene the transition heads for. */
  to: Scene | null;
  from: Scene | null;
  /** What React rendered: `to` plus exiting elements, or `to` with dragged nodes moved. */
  R: Scene | null;
  /** The in-between frame on screen; null at rest. */
  frame: Scene | null;
  /** Opacity per element key, where the last frame left it. */
  alpha: Map<string, number>;
  a0: Map<string, number>;
  goal: Set<string>;
  t0: number;
  raf: number;
}

const hasGhosts = (R: Scene, to: Scene) =>
  R.nodes.length > to.nodes.length ||
  R.edges.length > to.edges.length ||
  R.labels.length > to.labels.length;

/**
 * Animate `root` from the scene it shows to each new `target` over TWEEN_MS,
 * starting from the in-between frame when a transition is still running.
 * `shown` is what React rendered (target plus exiting elements); `settle`
 * asks the caller to drop the exiting ones once they have faded. When motion
 * is off or `hold()` (a node drag) the new scene shows at once. Returns
 * `finish`, which jumps a running transition to its end (true when one was
 * running), and `rebase`.
 */
export function useLayoutTween(
  root: RefObject<HTMLElement | null>,
  shown: Scene | null,
  target: Scene | null,
  settle: () => void,
  hold: () => boolean,
): { finish: () => boolean; rebase: (k: number, d: Pt) => boolean } {
  const st = useRef<TweenState>({
    el: null,
    to: null,
    from: null,
    R: null,
    frame: null,
    alpha: new Map(),
    a0: new Map(),
    goal: new Set(),
    t0: 0,
    raf: 0,
  });
  const handle = useRef({});

  const finish = useCallback(() => {
    const s = st.current;
    const running = s.raf !== 0;
    cancelAnimationFrame(s.raf);
    s.raf = 0;
    const { el } = s;
    if (!el || !s.R || !s.to) return running;
    // the rendered scene itself: no transforms left, exiting elements invisible
    const alpha = new Map([...keysOf(s.R)].map((k) => [k, s.goal.has(k) ? 1 : 0]));
    writeFrame(el, s.R, s.R, alpha);
    s.frame = null;
    s.alpha = alpha;
    if (hasGhosts(s.R, s.to)) settle();
    else active.layout.delete(handle.current);
    return running;
  }, [settle]);

  useLayoutEffect(() => {
    const s = st.current;
    const el = root.current;
    s.el = el;
    if (target === s.to) {
      // the same layout re-rendered: exiting elements dropped, or a drag moved a node
      s.R = shown;
      if (!s.raf && (!shown || !target || !hasGhosts(shown, target)))
        active.layout.delete(handle.current);
      return;
    }
    const from = s.frame ?? s.R;
    s.to = target;
    s.R = shown;
    cancelAnimationFrame(s.raf);
    s.raf = 0;
    if (!el || !shown || !target) return;
    s.goal = keysOf(target);
    if (!from || !motionOn() || hold()) {
      active.layout.add(handle.current);
      finish();
      return;
    }
    const was = keysOf(from);
    s.from = from;
    s.a0 = new Map([...keysOf(shown)].map((k) => [k, s.alpha.get(k) ?? (was.has(k) ? 1 : 0)]));
    s.t0 = performance.now();
    active.layout.add(handle.current);
    const draw = (e: number) => {
      const alpha = new Map([...s.a0].map(([k, a]) => [k, mix(a, s.goal.has(k) ? 1 : 0, e)]));
      s.frame = tweenScene(s.from!, s.to!, e);
      s.alpha = alpha;
      writeFrame(el, s.R!, s.frame, alpha);
    };
    const tick = (now: number) => {
      const t = (now - s.t0) / TWEEN_MS;
      if (t >= 1) return finish();
      draw(ease(t));
      s.raf = requestAnimationFrame(tick);
    };
    // the first frame before paint, so the new layout never flashes
    draw(0);
    s.raf = requestAnimationFrame(tick);
  }, [root, shown, target, finish, hold]);

  /**
   * The view is about to jump to one where scene point p shows where p * k + d
   * showed before: move the transition's start there, so on screen every
   * element still travels in a straight line from where it was. Animating the
   * view on its own clock instead makes nodes swing out and back. False when
   * no transition runs.
   */
  const rebase = useCallback((k: number, d: Pt) => {
    const s = st.current;
    if (!s.raf || !s.el || !s.R || !s.from || !s.frame) return false;
    s.from = scaleScene(s.from, k, d);
    s.frame = scaleScene(s.frame, k, d);
    writeFrame(s.el, s.R, s.frame, s.alpha);
    return true;
  }, []);

  useEffect(() => {
    const h = handle.current;
    const s = st.current;
    return () => {
      cancelAnimationFrame(s.raf);
      active.layout.delete(h);
    };
  }, []);

  return { finish, rebase };
}

// ---------------------------------------------------------------------------
// token travel

/** One animated step: its step, the strip fills before it, and how long it takes. */
export interface Travel {
  /** New for every animated step, so replaying the same step animates again. */
  seq: number;
  step: SimStep;
  /** Strip fill per edge before the step. */
  before: Map<string, number>;
  ms: number;
}

/** The tokens of one step that move along one edge (or chain of edges through delays). */
export interface Hop {
  /** One path per drawn dot, each from where its token is to where it goes. */
  paths: Pt[][];
  /** Tokens each dot stands for (more than one above MAX_DOTS). */
  shares: number[];
  n: number;
  /** 0: leaving a buffer (into an actor or output); 1: entering one. */
  phase: 0 | 1;
  /** Strips whose fill loses (phase 0, on departure) or gains (phase 1, on arrival) each token. */
  strips: string[];
}

/** Centre of FIFO slot i of a strip drawn at `box` with `capacity` slots (the bar above MAX_SLOTS). */
export function slotAt(box: Rect, capacity: number, i: number): Pt {
  const { SLOT_W, SLOT_H, GAP, PAD, MAX_SLOTS, BAR_W } = FIFO;
  const y = box.y + PAD + SLOT_H / 2;
  if (capacity > MAX_SLOTS) return { x: box.x + PAD + BAR_W / 2, y };
  const k = Math.max(0, Math.min(Math.max(1, capacity) - 1, i));
  return { x: box.x + PAD + k * (SLOT_W + GAP) + SLOT_W / 2, y };
}

/** Split n tokens over at most MAX_DOTS dots. */
function shares(n: number): number[] {
  const v = Math.min(n, MAX_DOTS);
  return Array.from(
    { length: v },
    (_, k) => Math.floor(((k + 1) * n) / v) - Math.floor((k * n) / v),
  );
}

/**
 * Where the tokens of one step travel. A buffer is its FIFO strip (modern
 * style): tokens enter it by landing in the next free slot and leave it from
 * the last filled one, so the strip visibly fills and drains. Without a strip
 * (lecture style, or buffers hidden) a buffer sits where its label is, else
 * half way along its edge.
 *
 * - input step: from the input pill along its edge, through any delays, into
 *   the buffer in front of the consumer;
 * - actor step: consumed tokens from each input buffer into the actor, then
 *   produced ones from each out port into the next buffer;
 * - output step: from the buffer in front of the output into its pill.
 */
export function planTravel(
  model: SceneModel,
  step: SimStep,
  before: Map<string, number>,
  strips: boolean,
): Hop[] {
  const { ir, scene, schedule } = model;
  const edges = byId(scene.edges);
  const sig = new Map(ir.signals.map((s) => [s.name, s]));
  const bufLabel = new Map(
    scene.labels.filter((l) => l.kind === 'buffer').map((l) => [l.owner, l]),
  );
  const aliases = schedule.ok ? schedule.aliases : new Map<string, string>();
  const buf = (s: string) => aliases.get(s) ?? s;
  // a delay folds signals into one buffer: every edge of it shows the same fill
  const group = (s: string) =>
    ir.signals.filter((o) => buf(o.name) === buf(s)).map((o) => edgeId(o));
  const delays = new Set(ir.processes.filter(isDelay).map((p) => p.name));
  const capacity = (id: string) => Number(/\d+/.exec(bufLabel.get(id)?.text ?? '')?.[0] ?? 0);
  /** Distance along `pts` where edge `id`'s buffer sits. */
  const bufferAt = (id: string, pts: Pt[]) => {
    const b = bufLabel.get(id)?.box;
    return b ? lengthAt(pts, { x: b.x + b.w / 2, y: b.y + b.h / 2 }) : pathLength(pts) / 2;
  };
  /** The slot token k uses: arrivals fill upward from `fill`, departures leave from the top. */
  const slot = (id: string, fill: number, k: number, arriving: boolean): Pt | null => {
    const l = bufLabel.get(id);
    if (!strips || !l) return null;
    return slotAt(l.box, capacity(id), arriving ? fill + k : fill - 1 - k);
  };

  const hops: Hop[] = [];
  /** Tokens leaving the buffer on edge e (its strip or label) towards the end of the edge. */
  const leave = (e: SceneEdge, n: number, signal: string) => {
    const rest = slicePath(e.points, bufferAt(e.id, e.points), pathLength(e.points));
    const fill = before.get(e.id) ?? 0;
    const sh = shares(n);
    hops.push({
      paths: sh.map((_, k) => {
        const from = slot(e.id, fill, k, false);
        return from ? [from, ...rest] : rest;
      }),
      shares: sh,
      n,
      phase: 0,
      strips: group(signal),
    });
  };
  /** Tokens starting at the head of signal `name` and running to the next buffer. */
  const enter = (name: string, n: number) => {
    // the chain of signals through delays, up to the actor or output that reads it
    const chain = [sig.get(name)];
    for (let s = chain[0]; s && delays.has(s.target.name);) {
      s = ir.signals.find((x) => x.source.name === s!.target.name);
      if (!s || chain.includes(s)) break;
      chain.push(s);
    }
    const points: Pt[] = [];
    let to = -1;
    let stop: string | null = null;
    for (const s of chain) {
      const e = s && edges.get(edgeId(s));
      if (!e) break;
      const offset = pathLength(points.length ? [...points, e.points[0]!] : []);
      points.push(...e.points);
      // tokens stop at the first buffer on the way
      if (bufLabel.has(e.id)) {
        to = offset + bufferAt(e.id, e.points);
        stop = e.id;
        break;
      }
    }
    if (points.length < 2) return;
    const last = chain[chain.length - 1];
    const out = !!last && ir.outputs.includes(last.target.name);
    // no buffer shown on the way: half way along, or into the output pill
    if (to < 0) to = out ? pathLength(points) : pathLength(points) / 2;
    const run = slicePath(points, 0, to);
    const fill = stop ? (before.get(stop) ?? 0) : 0;
    const sh = shares(n);
    hops.push({
      paths: sh.map((_, k) => {
        const into = stop ? slot(stop, fill, k, true) : null;
        return into ? [...run, into] : run;
      }),
      shares: sh,
      n,
      phase: 1,
      strips: stop ? group(name) : [],
    });
  };

  for (const c of [...step.consumed, ...step.drained]) {
    const s = sig.get(c.signal);
    const e = s && edges.get(edgeId(s));
    if (e) leave(e, c.n, c.signal);
  }
  for (const o of step.produced) enter(o.signal, o.n);
  return hops;
}

interface Dot {
  hop: Hop;
  path: Pt[];
  len: number;
  share: number;
  start: number;
  el: SVGCircleElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Run one step's travel in `layer`. With both kinds of move (an actor firing)
 * the departures take the first half of `ms` and the arrivals the second;
 * otherwise one kind takes all of it. Each train is staggered. `onFill`
 * receives the strip fills whenever a dot leaves or reaches a strip; `onDone`
 * fires once every dot has arrived. Returns a cancel function.
 */
export function runTravel(
  layer: SVGGElement,
  hops: Hop[],
  ms: number,
  before: Map<string, number>,
  onFill: (fill: Map<string, number>) => void,
  onDone: () => void,
): () => void {
  const both = hops.some((h) => h.phase === 0) && hops.some((h) => h.phase === 1);
  const span = both ? ms / 2 : ms;
  const travel = span * 0.6;
  const dots: Dot[] = [];
  const badges: [Hop, SVGTextElement][] = [];
  for (const hop of hops) {
    const v = hop.paths.length;
    hop.paths.forEach((path, k) => {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('class', 'token');
      el.setAttribute('r', String(DOT_R));
      el.style.display = 'none';
      layer.appendChild(el);
      dots.push({
        hop,
        path,
        len: pathLength(path),
        share: hop.shares[k]!,
        start: (both ? hop.phase * span : 0) + (v > 1 ? k / (v - 1) : 0) * (span - travel),
        el,
      });
    });
    if (hop.n > MAX_DOTS) {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('class', 'token-count');
      t.textContent = `×${hop.n}`;
      t.style.display = 'none';
      layer.appendChild(t);
      badges.push([hop, t]);
    }
  }
  const handle = {};
  active.tokens.add(handle);
  let raf = 0;
  let events = '';
  const t0 = performance.now();
  const stop = () => {
    cancelAnimationFrame(raf);
    for (const d of dots) d.el.remove();
    for (const [, t] of badges) t.remove();
    active.tokens.delete(handle);
  };
  const tick = (now: number) => {
    const t = Math.max(0, now - t0);
    const lead = new Map<Hop, Pt>();
    let done = '';
    for (const d of dots) {
      const u = (t - d.start) / travel;
      const moving = u >= 0 && u < 1;
      d.el.style.display = moving ? '' : 'none';
      if (moving) {
        const p = pointAtLength(d.path, ease(u) * d.len);
        d.el.setAttribute('cx', String(p.x));
        d.el.setAttribute('cy', String(p.y));
        if (!lead.has(d.hop)) lead.set(d.hop, p);
      }
      // a leaving token empties its slot as it sets off, an arriving one fills one on arrival
      done += (d.hop.phase === 0 ? u >= 0 : u >= 1) ? '1' : '0';
    }
    for (const [hop, el] of badges) {
      const p = lead.get(hop);
      el.style.display = p ? '' : 'none';
      if (p) {
        el.setAttribute('x', String(p.x + DOT_R + 2));
        el.setAttribute('y', String(p.y - DOT_R - 2));
      }
    }
    if (done !== events) {
      events = done;
      const fill = new Map(before);
      dots.forEach((d, i) => {
        if (done[i] !== '1') return;
        for (const e of d.hop.strips)
          fill.set(e, (fill.get(e) ?? 0) + (d.hop.phase ? d.share : -d.share));
      });
      onFill(fill);
    }
    if (t >= ms) {
      stop();
      onDone();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
