# Diagram engine plan

Replace elkjs and React Flow with our own layout and renderer.

## North star

The diagram is an instrument, not a picture: it shows how the SDF model
behaves (tokens, buffers, firings) as well as its structure, every element
is clickable and editable, and it updates within one frame of a keystroke.

## Baseline (35 fixtures, before this work)

- parse + elaborate + schedule: 0.81 ms average
- elk layout: 21 ms average, 192 ms worst (cold)
- a fixed 250 ms debounce before the pipeline runs
- elk.bundled.js is 1.6 MB of the 2.25 MB production bundle
- largest fixture: 10 nodes, 9 signals; max 6 ports on one actor; 14 of 35 cyclic

## Architecture

`layout(LayoutInput) -> Scene` (`src/scene/types.ts`) is a pure, synchronous
function. The scene is plain data consumed by the live renderer (SVG shapes
plus an HTML label layer sharing one pan/zoom transform), SVG/PNG/TikZ
export, and the metrics harness (no DOM).

## Decisions

1. Delay notation: delay-process node in the lecture style; pre-filled buffer
   tokens on the edge in the modern style.
2. Simulation shows tokens produced and consumed (counts only), never values.
3. Minimap dropped.
4. SHOW toggles re-lay out (hidden labels take no space). Ties in ordering
   keep the previous scene's layer/order (stability).

## Layout requirements

- Left to right. System inputs in the first layer, outputs in the last.
- Cycles broken at the edges leaving a delay; DFS back edges as fallback.
- Ports visible, ordered by argument index top to bottom, each with its rate
  label at the port (rates leave the node stack text).
- Circle for up to 2 ports per side; stadium beyond that.
- Orthogonal edges; labels get reserved space; gaps between layers sized to
  fit the labels and tracks routed through them.
- Hard gate: zero overlaps on every fixture and every flag combination.
- Soft gate: crossings and bends no worse than elk per fixture.
- Budget: target under 4 ms per fixture; the test gate is 8 ms (half a
  frame), since this machine's clock varies about 2x between runs.

## Phases

- [x] 0. Scene type, metrics harness, elk baseline. (4f6e28f)
- [x] 1. Synchronous label-aware layout. (4f6e28f)
- [x] 2. Own renderer at gesture parity; remove React Flow and elk. (da88ac8)
- [x] 3. Buffer FIFO element, simulate(), timeline strip, deadlock and
      inconsistency views. (2599469)
- [x] 4. Motion: layout transitions, tokens along edges, enter and exit. (d583156)
- [x] 4b. SDF animation as token flow, and an Animate button:
  - [x] inputs produce a period's tokens as their own step, outputs drain
        at the period end (simulate, simulateUntilStuck, sim tests)
  - [x] tokens land in and leave from FIFO slots, slot-sized dots
  - [x] stuck runs (deadlock, inconsistent rates) are playable, not looping
  - [x] Timeline for io steps and stuck runs
  - [x] Animate / Stop toolbar button
  - [x] tour step introducing the animation (it starts playback)
  - [x] e2e scenarios updated and extended (26/26, three runs); all checks pass
  - [x] frame-by-frame check on devbox
- [x] 5. Semantic zoom, inline editing, two-way highlighting, SVG and TikZ
      export:
  - [x] export: sceneToSvg, PNG from it, sceneToTikz (pdflatex-checked),
        Export menu replacing html-to-image
  - [x] two-way highlighting between editor and diagram (hover marks the source, Ctrl/Cmd-click jumps)
  - [x] inline editing of rates, tokens, names, functions on the canvas (double-click, F2)
  - [x] semantic zoom (lod-mid below 0.55, lod-far below 0.3; hover card lists what is hidden)
  - [x] e2e scenarios, README; all checks pass twice (31/31), devbox visual check
- [x] 6. e2e on @playwright/test 1.61.1: `e2e` local, `e2e:remote` on
      ws://devbox:3100, CI job with bundled chromium; vitest excludes it.
      Verified: 31/31 local (system Chromium), 31/31 on devbox, subset on
      dator-cos, 31/31 with CI=1 after npm ci (bundled Chromium); lint,
      test and build as the CI test job runs them.

## Motion (phase 4)

React renders only settled scenes. Re-rendering the SVG and label layers on
every animation frame would rebuild about a hundred elements per frame, so
motion writes the DOM directly instead.

- `src/render/motion.ts` is pure: `tweenScene(from, to, t)` matches elements
  by id, mixes node and label boxes and port points, and morphs edge
  polylines after padding the shorter one with repeated vertices. Entering
  elements grow from their centre and exiting ones shrink. At t = 1 the
  result is `to` itself.
- `src/render/animate.ts` runs the frames. A layout transition (250 ms)
  starts from the frame on screen, so an edit during a transition does not
  jump back. SceneView keeps the exiting elements rendered until they have
  faded, then drops them. Every frame maps each element's rendered box onto
  its in-between box with an SVG `transform` or a CSS transform on the label.
  The last frame clears those transforms, so the settled DOM is exactly what
  React rendered. A drag (a node or a new connection) finishes the
  transition first, and so does a click that opens a popover, which then
  hangs from where its element lands. Export PNG waits until nothing moves.
- A re-fit during a transition (an edit that adds or removes a process) jumps
  the view and maps the transition's start through the old view, so on screen
  every element moves in a straight line. Animating the view on its own clock
  (150 ms, ease-out, against the tween's 250 ms ease-in-out) made nodes swing
  up to 20 px out and back.
- Token travel: each forward step (play or step) sends one dot per token,
  capped at 8 per edge with a count badge. Consumed dots run from the buffer
  strip (or the input pill) into the actor, and produced dots run from the
  out port, through delays, to the next strip (or into the output pill). Strip
  fills follow the dots, and at rest they come from the trace again. A travel
  takes 70% of the step interval, so it ends before the next step fires; a
  speed change leaves the travel in flight at its old pace. Stepping back or
  scrubbing jumps.
- `prefers-reduced-motion: reduce` (or `window.__fsd.setMotion(false)`)
  turns all of it off: scenes and pan/zoom fits jump, no dots are drawn, and
  the first-run tour does not animate.
  `window.__fsd.animating()` is true while anything moves. The e2e `settle()`
  waits for it.

## Rebase onto v1.1.0 (persistence and user-owned layout)

main shipped autosave, New/Open/Export .hs with a `-- @layout` block, and
pinned layout on top of elk and React Flow. This branch removes both, so the
behaviour is ported onto the scene engine rather than merged as code:

- [x] placement.ts on scene boxes (spacing constants local, edgeMidpoint from
      scene edges); its tests adapted
- [x] pinScene(scene, positions): nodes at pinned positions with their labels,
      edges rerouted orthogonally between the moved ports; unit tests
- [x] SceneView: drag pins every node, arrow keys nudge, io pills move too
      (connections start from their handle dot), drop and menu points in
      scene coordinates
- [x] App: working copy autosave and restore, New, Open .hs, Export .hs in
      the Export menu, Tidy with undo, placement hints, renames carry keys
      (popover, inline edits, outputRenames)
- [x] e2e: pin survives an edit, Tidy and undo, reload restores, .hs round
      trip, arrow keys; all checks local and on devbox
- [ ] PR, CI green, squash merge, release v1.2.0 tag
