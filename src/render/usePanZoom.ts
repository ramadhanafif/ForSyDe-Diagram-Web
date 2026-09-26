import { useCallback, useEffect, useRef, useState } from 'react';
import type { Rect } from '../scene/types';
import { motionOn } from './animate';

/** Scene to pane mapping: pane = scene * k + (tx, ty). */
export interface View {
  k: number;
  tx: number;
  ty: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Fit-to-view framing: the frame grows by this fraction, the zoom stops at FIT_MAX_ZOOM. */
const FIT_PADDING = 0.08;
const FIT_MAX_ZOOM = 2;
const ANIM_MS = 150;
/** Zoom button step. */
const STEP = 1.2;
/** Wheel zoom per pixel of deltaY; line and page deltas are converted to pixels first. */
const WHEEL_SPEED = 0.002;
const WHEEL_UNIT = [1, 20, 400];

const clampK = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Scale to k around pane point (px, py): the scene point under it stays under it. */
function zoomAt(v: View, k: number, px: number, py: number): View {
  const k2 = clampK(k);
  const r = k2 / v.k;
  return { k: k2, tx: px - (px - v.tx) * r, ty: py - (py - v.ty) * r };
}

type Pt = { x: number; y: number };
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) || 1;

/**
 * Pan and zoom for a pane: wheel zooms around the cursor, a drag that starts
 * on `isBackground` pans, two touches pinch. `pane` and the `bind` handlers go
 * on the pane element; `view` is the transform for its content layer.
 */
export function usePanZoom(
  isBackground: (target: EventTarget) => boolean,
  fitMax = FIT_MAX_ZOOM,
  fitMin = MIN_ZOOM,
) {
  const pane = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  const anim = useRef(0);
  const setView = useCallback((v: View) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const jump = useCallback(
    (v: View) => {
      cancelAnimationFrame(anim.current);
      setView(v);
    },
    [setView],
  );
  const animateTo = useCallback(
    (to: View) => {
      cancelAnimationFrame(anim.current);
      if (!motionOn()) return setView(to);
      const from = viewRef.current;
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ANIM_MS);
        const e = t * (2 - t);
        setView({
          k: from.k + (to.k - from.k) * e,
          tx: from.tx + (to.tx - from.tx) * e,
          ty: from.ty + (to.ty - from.ty) * e,
        });
        if (t < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [setView],
  );
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  /** Frame `frame` in the pane; `jumpIf(from, to)` true jumps there instead of animating. */
  const fit = useCallback(
    (frame: Rect, jumpIf?: (from: View, to: View) => boolean) => {
      const el = pane.current;
      if (!el || !el.clientWidth || !el.clientHeight || !frame.w || !frame.h) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const k = clampK(
        Math.max(
          fitMin,
          Math.min(W / (frame.w * (1 + FIT_PADDING)), H / (frame.h * (1 + FIT_PADDING)), fitMax),
        ),
      );
      // held at fitMin, a frame larger than the pane shows its start (the inputs)
      // and pans for the rest, instead of cutting both ends
      const start = (size: number, at: number, len: number) =>
        len * k > size ? (size * FIT_PADDING) / 2 - at * k : size / 2 - (at + len / 2) * k;
      const to = { k, tx: start(W, frame.x, frame.w), ty: start(H, frame.y, frame.h) };
      if (jumpIf?.(viewRef.current, to)) jump(to);
      else animateTo(to);
    },
    [animateTo, jump, fitMax, fitMin],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      const el = pane.current;
      if (!el) return;
      const v = viewRef.current;
      animateTo(zoomAt(v, v.k * STEP ** dir, el.clientWidth / 2, el.clientHeight / 2));
    },
    [animateTo],
  );

  // React registers wheel listeners as passive, and zooming must preventDefault
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      const dy = e.deltaY * (WHEEL_UNIT[e.deltaMode] ?? 1);
      jump(zoomAt(v, v.k * Math.exp(-dy * WHEEL_SPEED), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [jump]);

  // pointers down on the pane, pane coordinates; one pans, two pinch
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ v0: View; p0: Pt; d0: number } | null>(null);

  const local = (e: React.PointerEvent): Pt => {
    const r = pane.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const restart = () => {
    const ps = [...pointers.current.values()];
    gesture.current = ps.length
      ? {
          v0: viewRef.current,
          p0: ps.length > 1 ? mid(ps[0]!, ps[1]!) : ps[0]!,
          d0: ps.length > 1 ? dist(ps[0]!, ps[1]!) : 1,
        }
      : null;
  };

  const bind = {
    onPointerDown(e: React.PointerEvent) {
      const touch = e.pointerType === 'touch';
      if (!touch && (e.button !== 0 || !isBackground(e.target))) return;
      if (touch && pointers.current.size === 0 && !isBackground(e.target)) return;
      cancelAnimationFrame(anim.current);
      pane.current?.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, local(e));
      restart();
    },
    onPointerMove(e: React.PointerEvent) {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, local(e));
      const g = gesture.current;
      if (!g) return;
      const ps = [...pointers.current.values()];
      if (ps.length === 1) {
        const p = ps[0]!;
        setView({ ...g.v0, tx: g.v0.tx + p.x - g.p0.x, ty: g.v0.ty + p.y - g.p0.y });
      } else {
        const m = mid(ps[0]!, ps[1]!);
        const moved = { ...g.v0, tx: g.v0.tx + m.x - g.p0.x, ty: g.v0.ty + m.y - g.p0.y };
        setView(zoomAt(moved, (g.v0.k * dist(ps[0]!, ps[1]!)) / g.d0, m.x, m.y));
      }
    },
    onPointerUp(e: React.PointerEvent) {
      if (!pointers.current.delete(e.pointerId)) return;
      restart();
    },
    onPointerCancel(e: React.PointerEvent) {
      if (!pointers.current.delete(e.pointerId)) return;
      restart();
    },
  };

  return { pane, view, bind, fit, zoomBy };
}
