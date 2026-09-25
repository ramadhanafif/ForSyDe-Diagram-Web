/** Top-left corner of a node in flow coordinates. */
export interface Point {
  x: number;
  y: number;
}

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

/** Horizontal gap right of a producer; matches elk's LAYER_SPACING. */
const LAYER_GAP = 64;
/** Vertical gap when stepping down past a node; matches elk's NODE_SPACING. */
const NODE_GAP = 44;

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Final positions for pinned mode. Per node: stored position, else the hint
 * (a gesture's desired center), else right of a placed producer (stepped down
 * past overlaps), else below the lowest placed node at the leftmost x. Nodes
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
  for (const n of elkNodes) {
    const stored = positions.get(n.id);
    const hint = hints.get(n.id);
    if (stored) put(n, stored);
    else if (hint) put(n, { x: hint.x - n.width / 2, y: hint.y - n.height / 2 });
    else pending.push(n);
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
        x: producer.x + producer.width + LAYER_GAP,
        y: producer.y + producer.height / 2 - n.height / 2,
      };
      // each step moves strictly below a blocker, so this terminates
      for (let hit = firstHit(box, placed); hit; hit = firstHit(box, placed)) {
        box.y = hit.y + hit.height + NODE_GAP;
      }
      put(n, box);
    } else if (placed.size > 0) {
      const boxes = [...placed.values()];
      put(n, {
        x: Math.min(...boxes.map((b) => b.x)),
        y: Math.max(...boxes.map((b) => b.y + b.height)) + NODE_GAP,
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
