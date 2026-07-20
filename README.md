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
npm test         # parity + scheduler + unit tests
npm run build    # production bundle (dist/)
```

Deploys to GitHub Pages from `main` via `.github/workflows/deploy.yml`.

## Editing from the diagram

The diagram (React Flow, laid out by elk) is interactive and every edit is
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
- drag from an output port to the dashed input dot of an actor to feed that
  signal in as a new input; the actor's constructor and rates are rewritten
  in the source (point-free specs with unconsumed source signals only), and
  refused connections explain why in SDF terms
- the Add actor toolbar button adds an actor fed by a new system input, wired
  to a new system output
- new actors get a runnable function stub appended to the file, for example
  `f_5 :: [Int] -> [Int]` with `f_5 _ = replicate 1 0`
- nodes can be dragged to inspect a layout; positions are ephemeral and reset
  at the next re-layout since they are not part of the source

Undo works through the editor history as usual, since diagram edits are
ordinary text edits. Freshly inserted processes pulse briefly and the view
refits after structural changes.

## Reading the diagram

- Two styles, switchable from the toolbar: a modern default and a lecture
  style that mimics the ForSyDe lecture notes / forsyde-latex figures.
- In the modern style the numbers are color coded: rates are teal, buffer
  sizes violet (shown as `buf n`), repetition badges blue. Every number has
  a hover tooltip explaining it with the actual process and signal names.
- The floating SHOW panel toggles each annotation kind individually: signal
  names, rates (with a sub-option for rates equal to 1), buffer sizes,
  repetitions, constructors and functions. Hovering an element always
  reveals its full detail. The legend button explains the notation.
- The Schedule toolbar button controls all schedule results; the summary
  chip at the bottom expands into the firing order plus repetition and
  buffer tables. A minimap sits in the top right corner.

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
- Built with [React Flow](https://reactflow.dev/) by xyflow for the diagram,
  the [Eclipse Layout Kernel](https://eclipse.dev/elk/) (via
  [elkjs](https://github.com/kieler/elkjs)) for layout, and
  [CodeMirror](https://codemirror.net/) for the editor.

## Fixture parity

`fixtures/` holds `.hs` sources and the IR JSON produced by
`forsyde-compiler-exe --output-forsyde-ir-json` for every bundled example.
`npm test` asserts the TypeScript parser produces identical IR. Regenerate with
`scripts/regen-fixtures.sh` (requires a local forsyde-devtools install).
