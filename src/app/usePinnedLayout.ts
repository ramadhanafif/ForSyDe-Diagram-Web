import { useCallback, useMemo, useState } from 'react';
import type { Point } from '../core/layoutBlock';
import { placeOver, renameKey, type PlacedBox } from '../diagram/placement';
import { pinScene } from '../layout/pin';
import type { SceneModel } from './useScene';

/** The automatic layout's boxes for every node of a model, placement's input. */
const sceneBoxes = (model: SceneModel): PlacedBox[] =>
  model.scene.nodes.map((n) => ({
    id: n.id,
    x: n.box.x,
    y: n.box.y,
    width: n.box.w,
    height: n.box.h,
  }));

/** Place every node of `model` over `pos`; see placement's placeOver. */
const placeModel = (
  model: SceneModel,
  pos: Map<string, Point>,
  hints: Map<string, Point>,
  known?: Set<string>,
) => placeOver(sceneBoxes(model), model.ir.signals, pos, hints, known);

/**
 * Node positions the user pinned, keyed by process or io signal name; empty
 * means the automatic layout. Each new model places its new nodes (at the
 * gesture points in `hints`, under the names in `renames`) and writes them
 * back, so they stay put. `view` is the model with its pinned nodes moved.
 */
export function usePinnedLayout(model: SceneModel | null, initial: Map<string, Point>) {
  const [positions, setPositions] = useState(initial);
  // the replaced document's positions, shown until its model leaves the screen,
  // so the old diagram does not re-lay out under the new document's positions
  const [held, setHeld] = useState<Map<string, Point> | null>(null);
  // gesture points (node centers) and diagram renames waiting for the model they produce
  const [hints, setHints] = useState<Map<string, Point>>(() => new Map());
  const [renames, setRenames] = useState<[string, string][]>([]);
  const queueRenames = useCallback((pairs: [string, string][]) => {
    if (pairs.length) setRenames((r) => [...r, ...pairs]);
  }, []);
  const addHints = useCallback((pairs: [string, Point][]) => {
    if (pairs.length) setHints((h) => new Map([...h, ...pairs]));
  }, []);

  // derived-during-render pattern so no setState-in-effect
  const [placedFor, setPlacedFor] = useState<SceneModel | null>(null);
  if (model !== placedFor) {
    setPlacedFor(model);
    // pinned: place new nodes and write them back so they stay put; keeps removed ids.
    // A new document's first model has no known ids: every entry is its own.
    if (model && positions.size) {
      let pos = positions;
      for (const [from, to] of renames) pos = renameKey(pos, from, to);
      const known =
        placedFor && !held ? new Set(placedFor.scene.nodes.map((n) => n.id)) : undefined;
      setPositions(placeModel(model, pos, hints, known));
    }
    if (model && held) setHeld(null);
    if (model && hints.size) setHints(new Map());
    if (model && renames.length) setRenames([]);
  }

  const shown = held ?? positions;
  // what the diagram draws: the model's scene, with pinned nodes where the user put them
  const view = useMemo(
    () => (model && shown.size ? { ...model, scene: pinScene(model.scene, shown) } : model),
    [model, shown],
  );

  /** A new document: `onScreen` is the model on screen, `same` when its text stays. */
  const replace = useCallback(
    (onScreen: SceneModel | null, pos: Map<string, Point>, same: boolean) => {
      // same text: no new model will come to place it, so place now
      if (onScreen && !same) setHeld((h) => h ?? positions);
      else setHeld(null);
      setPositions(onScreen && same && pos.size ? placeModel(onScreen, pos, new Map()) : pos);
    },
    [positions],
  );

  /** A node move landed: pin every node there (the first move pins the whole layout). */
  const pin = useCallback(
    (pinned: Map<string, Point>) => {
      // a held diagram belongs to the replaced document: pin into its map and
      // leave the new document's positions alone until its model arrives
      if (held) setHeld((h) => h && new Map([...h, ...pinned]));
      else setPositions((q) => new Map([...q, ...pinned]));
    },
    [held],
  );

  /** Back to the automatic layout. */
  const clear = useCallback(() => {
    setHeld(null);
    setPositions(new Map());
  }, []);

  /** Positions from before a clear, placed against the model on screen (the text may have changed). */
  const restore = useCallback(
    (onScreen: SceneModel | null, prev: Map<string, Point>) =>
      setPositions(onScreen ? placeModel(onScreen, prev, new Map()) : prev),
    [],
  );

  return { positions, view, queueRenames, addHints, replace, pin, clear, restore };
}
