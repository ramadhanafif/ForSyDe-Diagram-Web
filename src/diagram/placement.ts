import type { Point } from '../core/layoutBlock';
import type { Scene } from '../scene/types';

/** Gap between a producer and a node placed to its right. */
export const LAYER_SPACING = 64;
/** Gap below a node that another is stepped down past. */
export const NODE_SPACING = 44;

/** A laid-out node box: the only geometry placement needs. */
export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of an IR signal placement reads (IRSignal satisfies it). */
export interface SignalLink {
  source: { name: string };
  target: { name: string };
}

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Final positions for pinned mode. Per node: stored position, else the hint
 * (a gesture's desired center), else right of a placed producer, else below
 * the lowest placed node at the leftmost x. Hinted and producer-placed nodes
 * step down past overlaps. Only ids in `nodes` are returned. Nodes
 * with a placed producer resolve first, then sources (no incoming signal), so
 * an input pill lands left of its actor; a cycle with nothing placed falls
 * back to the first unresolved node in layout order.
 */
export function placeNodes(
  nodes: PlacedBox[],
  positions: Map<string, Point>,
  hints: Map<string, Point>,
  signals: SignalLink[],
): Map<string, Point> {
  const placed = new Map<string, PlacedBox>();
  const put = (n: PlacedBox, p: Point) => placed.set(n.id, { ...n, ...p });

  const pending: PlacedBox[] = [];
  const hinted: PlacedBox[] = [];
  for (const n of nodes) {
    const stored = positions.get(n.id);
    if (stored) put(n, stored);
    else if (hints.has(n.id)) hinted.push(n);
    else pending.push(n);
  }
  // after every stored node, so a hint on an edge midpoint clears both neighbours
  for (const n of hinted) {
    const hint = hints.get(n.id)!;
    put(n, stepDown({ ...n, x: hint.x - n.width / 2, y: hint.y - n.height / 2 }, placed));
  }

  const producerOf = (id: string): PlacedBox | undefined => {
    for (const s of signals) {
      const p = s.target.name === id ? placed.get(s.source.name) : undefined;
      if (p) return p;
    }
    return undefined;
  };

  // ponytail: O(n^2 * signals) rescans, fine for hand-drawn diagrams
  while (pending.length > 0) {
    let i = pending.findIndex((n) => producerOf(n.id));
    if (i < 0) i = pending.findIndex((n) => !signals.some((s) => s.target.name === n.id));
    if (i < 0) i = 0;
    const n = pending.splice(i, 1)[0]!;
    const producer = producerOf(n.id);
    if (producer) {
      const box = {
        ...n,
        x: producer.x + producer.width + LAYER_SPACING,
        y: producer.y + producer.height / 2 - n.height / 2,
      };
      put(n, stepDown(box, placed));
    } else if (placed.size > 0) {
      const boxes = [...placed.values()];
      put(n, {
        x: Math.min(...boxes.map((b) => b.x)),
        y: Math.max(...boxes.map((b) => b.y + b.height)) + NODE_SPACING,
      });
    } else {
      put(n, { x: n.x, y: n.y });
    }
  }

  const out = new Map<string, Point>();
  for (const [id, b] of placed) out.set(id, { x: b.x, y: b.y });
  return out;
}

function firstHit(box: PlacedBox, placed: Map<string, PlacedBox>): PlacedBox | undefined {
  for (const b of placed.values()) if (overlaps(box, b)) return b;
  return undefined;
}

/** Move `box` down until it overlaps nothing placed; returns its top-left. */
function stepDown(box: PlacedBox, placed: Map<string, PlacedBox>): Point {
  // each step moves strictly below a blocker, so this terminates
  for (let hit = firstHit(box, placed); hit; hit = firstHit(box, placed)) {
    box.y = hit.y + hit.height + NODE_SPACING;
  }
  return { x: box.x, y: box.y };
}

/**
 * Carry a position over a rename; returns a new map, input untouched. The old
 * id keeps its entry as a stale one, so an editor undo of the rename finds it.
 */
export function renameKey(
  positions: Map<string, Point>,
  oldId: string,
  newId: string,
): Map<string, Point> {
  const out = new Map(positions);
  const p = out.get(oldId);
  if (p !== undefined) out.set(newId, p);
  return out;
}

/**
 * Place every node over `positions` and return the merged map. Ids absent
 * from `nodes` keep their entry, so an editor undo of a delete finds its old
 * spot; Export writes only the model's ids. `known` is the ids on screen
 * before this model: a node outside it whose name has a stored entry (undo,
 * or a fresh name reusing a deleted one) is placed there as a hint, so it
 * steps down rather than cover a node that moved into that spot.
 * ponytail: stale ids accumulate until Tidy, New or Open.
 */
export function placeOver(
  nodes: PlacedBox[],
  signals: SignalLink[],
  positions: Map<string, Point>,
  hints: Map<string, Point>,
  known?: Set<string>,
): Map<string, Point> {
  const base = new Map(positions);
  const all = new Map(hints);
  for (const id of hints.keys()) base.delete(id); // a gesture beats a stale entry
  for (const n of nodes) {
    const p = base.get(n.id);
    if (!known || known.has(n.id) || !p) continue;
    base.delete(n.id);
    all.set(n.id, { x: p.x + n.width / 2, y: p.y + n.height / 2 });
  }
  return new Map([...base, ...placeNodes(nodes, base, all, signals)]);
}

/**
 * Middle of an edge as drawn, from `scene`, the scene on screen (pinned
 * positions already applied): the average of its two end points.
 */
export function edgeMidpoint(scene: Scene, edgeId: string): Point | null {
  const pts = scene.edges.find((e) => e.id === edgeId)?.points;
  if (!pts?.length) return null;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
