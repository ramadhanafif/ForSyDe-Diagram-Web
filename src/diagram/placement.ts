import type { Point } from '../core/layoutBlock';
import { LAYER_SPACING, NODE_SPACING } from './toElk';

/** An elk-laid-out node: the only geometry placement needs. */
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
 * step down past overlaps. Only ids in `elkNodes` are returned. Nodes
 * with a placed producer resolve first; a cycle with nothing placed falls
 * back to the first unresolved node in elk order.
 */
export function placeNodes(
  elkNodes: PlacedBox[],
  positions: Map<string, Point>,
  hints: Map<string, Point>,
  signals: SignalLink[],
): Map<string, Point> {
  const placed = new Map<string, PlacedBox>();
  const put = (n: PlacedBox, p: Point) => placed.set(n.id, { ...n, ...p });

  const pending: PlacedBox[] = [];
  const hinted: PlacedBox[] = [];
  for (const n of elkNodes) {
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

/** Carry a position over a rename; returns a new map, input untouched. */
export function renameKey(
  positions: Map<string, Point>,
  oldId: string,
  newId: string,
): Map<string, Point> {
  const out = new Map(positions);
  const p = out.get(oldId);
  if (p === undefined) return out;
  out.delete(oldId);
  out.set(newId, p);
  return out;
}
