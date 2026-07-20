# ForSyDe Playground

Try it: https://ramadhanafif.github.io/ForSyDe-Diagram-Web/

Live SDF dataflow diagrams for [ForSyDe Shallow](https://forsyde.github.io/forsyde-shallow/)
models, fully in the browser. Type a model on the left and see the laid-out dataflow
graph, with repetition vector, buffer sizes and rates, on the right. No install, no
backend.

Built as a companion to [forsyde-devtools](https://github.com/sthaeron/forsyde-devtools):
the parser and scheduler mirror the reference Haskell compiler and are tested against
fixtures generated from it.

## Development

```sh
npm ci
npm run dev      # local dev server
npm test         # parity + scheduler + unit tests
npm run build    # production bundle (dist/)
```

Deploys to GitHub Pages from `main` via `.github/workflows/deploy.yml`.

## Editing from the diagram

The diagram is clickable and every edit is applied as a plain text change to
the source, which stays the single source of truth:

- click an edge to insert an actor or delay in the middle of it, or to rename
  the signal
- click a process to change its name, rates, function or delay tokens, jump
  to the function definition, or delete it (1-in-1-out processes; the
  consumer is rewired to the producer)
- the Add actor toolbar button adds an actor fed by a new system input, wired
  to a new system output
- new actors get a runnable function stub appended to the file, for example
  `f_5 :: [Int] -> [Int]` with `f_5 _ = replicate 1 0`

Undo works through the editor history as usual, since diagram edits are
ordinary text edits.

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

## Fixture parity

`fixtures/` holds `.hs` sources and the IR JSON produced by
`forsyde-compiler-exe --output-forsyde-ir-json` for every bundled example.
`npm test` asserts the TypeScript parser produces identical IR. Regenerate with
`scripts/regen-fixtures.sh` (requires a local forsyde-devtools install).
