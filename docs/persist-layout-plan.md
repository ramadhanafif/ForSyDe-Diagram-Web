# Persistence and user-owned layout

## Problem

A reload loses all work: the source is never written to localStorage. There
is no way to start from a blank model, open a `.hs` file, or save one. Node
positions are recomputed by elk on every change, so a node the user dragged
jumps back at the next edit.

## Decisions

- The browser is the working copy: source and node positions autosave to
  localStorage and are restored on load.
- Export `.hs` writes the source plus a trailing layout comment block. Open
  `.hs` reads the block, strips it from the editor text, and restores the
  positions. GHC ignores comments, so exported files still compile.
- Positions live in app state, never in the editor text. Dragging a node does
  not create an undo entry in the editor.
- elk stays. With no stored positions the diagram is pure elk, as today. The
  first drag pins every node at its current position (pinned mode). Tidy
  clears all positions and returns to elk mode, with a one-level undo in the
  toast.
- Positions are keyed by node id: process name, or signal name for system
  inputs/outputs. Renames made from the diagram carry the key over. A rename
  typed in the text pane loses the position; that node is placed as new.

## Layout block format

    -- @layout <id> <x> <y>

One line per node, integers, at the end of the file, preceded by one blank
line. Parsing accepts any `-- @layout` lines anywhere; writing removes all
existing ones and appends a fresh block.

## Units

A. `src/core/layoutBlock.ts` (pure, no DOM):
   - `parseLayoutBlock(source): Map<string, {x, y}>`
   - `stripLayoutBlock(source): string`
   - `writeLayoutBlock(source, positions): string` (strip, then append; empty
     map yields the stripped source)
   - tests in `tests/layoutBlock.test.ts`, including a round trip over every
     bundled example and a check that the parser still accepts the output.

B. `src/diagram/placement.ts` (pure):
   - `placeNodes(elkNodes, positions, hints, signals)`: returns final
     positions for pinned mode. Stored position wins; else a placement hint
     (gesture point) for that id; else right of its producer (producer x +
     producer width + gap, same y); else below the lowest node.
   - `renameKey(positions, old, new)`.
   - tests in `tests/placement.test.ts`.

C. Wiring (`App.tsx`, `Toolbar.tsx`, `DiagramPane.tsx`, `toFlow.ts`,
   `ElkEdge.tsx`, `storage.ts`, `Popovers.tsx`):
   - autosave source (debounced) and positions; restore on mount, falling
     back to the default example.
   - toolbar: New (blank `system` template that parses), Open .hs (native
     file input), Export .hs (Blob download, layout block written), Tidy.
     The example loader keeps its unsaved-changes confirm and also clears
     positions.
   - node drag stop: enter pinned mode, record positions.
   - in pinned mode, nodes use placed positions and edges route with React
     Flow's smoothstep path between handles instead of elk's bend points.
   - gesture hints: palette drop point (screenToFlowPosition), edge midpoint
     for edge-insert from popover or context menu.
   - renames from the popover carry the position key.

## Where this is worse

A heavily edited pinned diagram has smoothstep edges that can cross nodes;
elk's orthogonal routing avoided that. Tidy is the fix.
