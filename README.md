# ForSyDe Playground

Try it: <https://ramadhanafif.github.io/ForSyDe-Diagram-Web/>

Live SDF dataflow diagrams for [ForSyDe Shallow](https://forsyde.github.io/forsyde-shallow/)
models, fully in the browser. Type a model on the left and see the laid-out dataflow
graph, with repetition vector, buffer sizes and rates, on the right. No install, no
backend.

Built as a companion to [forsyde-devtools](https://github.com/sthaeron/forsyde-devtools):
the parser and scheduler mirror the reference Haskell compiler and are tested against
fixtures generated from it.

Primary motivation in building this project is to explore tool that are easier to use in browser environments, provide better visuals, and more straightforward in development. This project is made on top of the success of [forsyde-devtools](https://github.com/sthaeron/forsyde-devtools), which internally uses KLighD and elk.js as diagram layout placement tool.

## Development

```sh
npm ci
npm run dev      # local dev server
npm test         # parity + scheduler + layout + unit tests
npm run e2e      # browser tests (Playwright) on this machine
npm run e2e:remote  # the same, in the Playwright server on devbox
npm run build    # production bundle (dist/)
```

Run one scenario by name with `npm run e2e -- -g overlap`. The browser
tests in `tests/e2e` start their own vite server on port 5199 (never an
existing one, which could be another checkout's). Locally they
use `CHROMIUM_PATH`, else `/usr/bin/chromium-browser` if present, else
Playwright's own Chromium (`npx playwright install chromium`). CI runs them
in the `playwright:v1.61.1-noble` image with its own Chromium, and skips
`frameRate` there (frame timing measures the runner, not the code).
`e2e:remote` connects to a
[Playwright server in Docker](https://playwright.dev/docs/docker#remote-connection)
at `ws://devbox:3100/` (set `PW_WS_ENDPOINT` for another, for example
`ws://dator-cos:3100/`); the remote browser reaches the local vite server
through the connection. The server image version must match
`@playwright/test` (1.61.1).

Deploys to GitHub Pages from `main` via `.github/workflows/deploy.yml`.

The working copy (text, baseline, example, positions and the layout-edited
flag) lives in localStorage as one JSON object under the key `workingCopy`;
clear site data to reset to the default example.

## Editing from the diagram

The diagram is interactive and every edit is
applied as a plain text change to the source, which stays the single source
of truth:

- click an edge to insert an actor or delay in the middle of it, or to rename
  the signal
- click a process (or select it and press Enter) to change its name, rates,
  function or delay tokens, jump to the function definition, or delete it
  (1-in-1-out processes; the consumer is rewired to the producer); Enter
  applies, Escape closes
- drag the actor or delay chip from the toolbar onto an edge to insert it
  there; dropping the actor chip on empty canvas adds a source actor
- drag from an output port, or from a system input or output, onto an actor
  (its dashed input dot or anywhere on it) to feed that signal in as a new
  input; a dashed line follows the pointer, actors that accept the signal
  show a filled dot, the others fade. The actor's constructor and rates are
  rewritten in the source (point-free specs only), and a refused connection
  explains why in SDF terms
- the Add actor toolbar button adds an actor fed by a new system input, wired
  to a new system output
- new actors get a runnable function stub appended to the file, for example
  `f_5 :: [Int] -> [Int]` with `f_5 _ = replicate 1 0`
- dragging a node pins the whole layout: every node keeps its position across
  edits (positions are keyed by name, so a rename typed in the editor places
  that node as new; renames made from the diagram keep it), new nodes land
  where they were dropped or next to their producer, and edges route as
  orthogonal lines between the ports; arrow keys nudge the focused node.
  Tidy returns to the automatic layout (with an Undo in the toast), and the
  positions travel in exported .hs files. System input and output pills move
  the same way; a connection starts from their small handle dot
- right-click a process, an edge or empty canvas for a menu of the same
  actions; Backspace and Delete do nothing on the diagram, deletion goes
  through the menu or the popover
- double-click a rate, a delay's tokens (its stack line, or the strip in the
  modern style), a process or signal name, or an actor's function to edit it
  in place; F2 renames the focused process. Enter applies, Escape cancels,
  and an invalid value says why and leaves the source alone
- the editor and the diagram point at each other: with the cursor on a
  binding, spec, signal name or function definition, the matching nodes and
  edges light up; pointing at a diagram element marks its source (a port's
  rate marks exactly that literal), and Ctrl/Cmd-click jumps the cursor there

The editor text and node positions autosave to the browser's localStorage and
are restored on reload. New starts a blank model, Open .hs loads a file and
restores the positions stored in its trailing `-- @layout` comment lines, and
Export > Haskell (.hs) downloads the source with those lines appended (GHC
ignores them). New, Open and the example picker ask before discarding unsaved
changes, including a dragged layout.

Undo works through the editor history as usual, since diagram edits are
ordinary text edits. Freshly inserted processes pulse briefly and the view
refits after structural changes.

## Reading the diagram

- The layout runs left to right: system inputs in the first column,
  outputs in the last, cycles closed by edges that run backwards. Edges are
  orthogonal and every label has reserved space; the tests check that no
  two elements overlap on any bundled example.
- Two styles, switchable from the toolbar: a modern default and a lecture
  style that mimics the ForSyDe lecture notes / forsyde-latex figures. The
  lecture style hides port dots until the pointer is over the process.
- Each port sits on the process outline, ordered by argument top to bottom,
  with its rate next to it (rates equal to 1 are hidden unless asked for).
- In the modern style the numbers are color coded: rates are teal, buffer
  sizes violet (shown as `buf n`), repetition badges blue. Every number has
  a hover tooltip explaining it with the actual process and signal names.
- The floating SHOW panel toggles each annotation kind individually: signal
  names, rates (with a sub-option for rates equal to 1), buffer sizes,
  repetitions, constructors and functions. Hidden annotations take no space;
  hovering an element lists what is hidden for it in a small card. The
  legend button explains the notation.
- Buffers: in the modern style each buffer is a FIFO strip on its edge, one
  slot per token the buffer must hold (above 8 slots, a bar and the number).
  Filled slots are the tokens in that buffer at the current simulation step
  (the signals on both sides of a delay share one buffer); when idle that is
  0, except where a delay's initial tokens sit. The lecture
  style writes the size as `·n`.
- Delays: the lecture style draws a delay as a process circle with its
  initial tokens `[..]`. The modern style draws it as its initial tokens
  sitting on the edge, a small strip with one filled slot per token; click it
  to edit the tokens.
- **Animate** in the toolbar runs the model: each system input produces the
  tokens its consumers take in one period, the tokens travel along the edges
  into their FIFO strips, each actor firing takes its tokens out of its
  buffers and sends the ones it produces to the next buffer, and at the end
  of the period the outputs take what collected in front of them. The
  period loops until Stop. A model without a schedule plays the run that
  gets stuck instead, and stops where it sticks.
- The Schedule toolbar button controls all schedule results. The timeline
  docked under the diagram (collapsible to a summary chip) has one cell per
  step of one schedule period: the inputs producing (italic, first), the
  actor firings, and the outputs taking (italic, last). Play, pause, step
  back and forward, reset, pick a speed (0.5x, 1x, 2x) or click a cell to
  jump there; the period loops, and pauses while the timeline is collapsed.
  The diagram follows: the firing actor or io pill is outlined, tokens land
  in and leave from strip slots, and the strips show the counts.
  Under the cells, a sparkline per signal plots its token count over the
  period with the maximum marked, which is where `buf n` is reached.
  "tables" expands the repetition and buffer tables.
- When no schedule exists the model is run anyway to show why. On a
  deadlock the actors that wait are outlined in red dashes, the buffers they
  are short on are dashed, and hovering an actor lists each input it is short
  on as "needs 2, has 1". This includes a deadlocked loop behind a source that
  keeps firing. On inconsistent rates the signals whose tokens accumulate every
  period are dashed and marked with a `+`. The red banner keeps a one-line
  summary.
- Pan by dragging empty canvas, zoom with the wheel (around the cursor) or a
  two-finger pinch, and use the +, - and fit buttons at the bottom right.
  There is no minimap. Zoomed out, fine print is hidden: below 55% the
  rates, buffers, repetitions and node text go, below 30% the signal names
  and ports too; hovering an element lists what is hidden.
- **Export** in the toolbar saves the diagram as it is on screen, in the
  current style, theme and SHOW settings, named after the module: a PNG
  image (2x), a standalone SVG (for Inkscape or the web), a standalone
  TikZ document (`.tex`, plain TikZ with the arrows.meta library, compiles
  with pdflatex), or Copy TikZ for only the `tikzpicture`, to paste into
  your own report.

## Supported model subset

The playground parses the same restricted ForSyDe Shallow subset as the reference
compiler, without GHC, so function bodies are not type-checked:

- netlist named `system`, inputs as curried parameters, output a signal name or tuple
- `where` bindings of the form `s = proc s_1 s_2` / `(a, b) = proc s`
- top-level process specs: `p = actorNMSDF <inRates> <outRates> <fn>` (N and M from 1 to 4),
  `d = delaySDF [tokens]`, eta-expanded or point-free
- no `if`, no nested `where` in the system block, no inline constructors in bindings,
  no implicit signal splits

Everything else (function definitions, `main`, type signatures) is carried along as
opaque text.

## Acknowledgements

Special thanks to [Ingo Sander](https://www.kth.se/profile/ingo) and the [ForSyDe](https://forsyde.github.io/) team at KTH Royal Institute of
Technology, whose formal system design methodology and teaching this
playground builds on.

More acknowledgements for:

- The [ForSyDe project](https://forsyde.github.io/) at KTH Royal Institute of
  Technology: this playground models the
  [ForSyDe Shallow](https://forsyde.github.io/forsyde-shallow/) SDF dialect,
  and its parser and scheduler mirror the
  [forsyde-devtools](https://github.com/sthaeron/forsyde-devtools) reference
  compiler, which also generated the parity fixtures.
- The lecture diagram style follows the figures in the KTH embedded systems
  lecture notes and the conventions of
  [forsyde-latex](https://forsyde.github.io/forsyde-latex/).
- Built with [CodeMirror](https://codemirror.net/) for the editor. The
  diagram layout and renderer are our own. Earlier versions drew the diagram
  with [React Flow](https://reactflow.dev/) and laid it out with the
  [Eclipse Layout Kernel](https://eclipse.dev/elk/) (via
  [elkjs](https://github.com/kieler/elkjs)); the layout tests still compare
  crossings and bends against the elk layouts recorded in
  `docs/layout-baseline.json`.

## Fixture parity

`fixtures/` holds `.hs` sources and the IR JSON produced by
`forsyde-compiler-exe --output-forsyde-ir-json` for every bundled example.
`npm test` asserts the TypeScript parser produces identical IR. Regenerate with
`scripts/regen-fixtures.sh` (requires a local forsyde-devtools install).
