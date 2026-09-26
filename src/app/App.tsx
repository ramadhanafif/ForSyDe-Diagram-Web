import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { orderDiagnostics, type Diagnostic } from '../core/ast';
import {
  addInput,
  addInputError,
  addSourceActor,
  deleteProcess,
  insertOnEdge,
  outputRenames,
} from '../core/edits';
import { isDelay, type IRSystem } from '../core/ir';
import { Menu, menuItems, type MenuTarget } from '../diagram/ContextMenu';
import { findDefinitionOffset } from '../diagram/labels';
import { EditPopover, type PopoverTarget } from '../diagram/Popovers';
import { EditorPane, type EditorApi } from '../editor/EditorPane';
import { animating, setMotion, type Travel } from '../render/animate';
import { Strip } from '../render/SceneShapes';
import { SceneView, type SceneTarget } from '../render/SceneView';
import { canvasMeasure, fifoSize } from '../scene/measure';
import type { DiagramStyle, LabelFlags, Scene } from '../scene/types';
import type { SimTrace } from '../sim/simulate';
import { examples } from './examples';
import {
  type WorkingCopy,
  preferredTheme,
  storageGet,
  storageGetJson,
  storageGetWorkingCopy,
  storageSet,
  storageSetWorkingCopy,
} from './storage';
import { Toolbar, type ExportKind } from './Toolbar';
import { Timeline } from './Timeline';
import { analyze } from '../core/analysis';
import { scheduleWarning } from './scheduleWarning';
import { explain } from './explain';
import { download, sceneToSvg, svgToPngBlob } from '../export/svg';
import { sceneToTikz, tikzPicture } from '../export/tikz';
import { startTour, TOUR_SEEN_KEY } from './tour';
import { useScene, type SceneModel } from './useScene';
import { BLANK_MODEL, exportFileName } from './files';
import {
  parseLayoutBlock,
  stripLayoutBlock,
  writeLayoutBlock,
  type Point,
} from '../core/layoutBlock';
import { edgeMidpoint, placeOver, renameKey, type PlacedBox } from '../diagram/placement';
import { pinScene } from '../layout/pin';
import { linkedAt, sourceSpans, type Target } from '../core/links';
import { inlineEdit, type EditTarget } from '../core/inlineEdit';
import { edgeId as edgeIdOf } from '../scene/labels';
import { fillAt, simMarks, useSimulation } from './useSimulation';

/** Per-annotation visibility, driven by the floating SHOW toggles in the pane. */
type ShowFlags = Omit<LabelFlags, 'unitRates'>;

const DEFAULT_FLAGS: ShowFlags = {
  signals: true,
  rates: true,
  buffers: true,
  repetitions: true,
  constructors: true,
  functions: true,
};

/** Test and debugging handle; the e2e harness drives the app through it. */
interface FsdHandle {
  getDoc(): string;
  setSource(src: string): void;
  scene(): Scene | null;
  ir(): IRSystem | null;
  /** One simulated schedule period, when the model has a schedule. */
  trace(): SimTrace | null;
  /** A layout transition or token travel is running (or only that kind). */
  animating(kind?: 'layout' | 'tokens'): boolean;
  /** Force motion off or on; null follows prefers-reduced-motion. */
  setMotion(on: boolean | null): void;
  /** Put the editor cursor at an offset, as a click in the text would. */
  setCursor(offset: number): void;
}

declare global {
  interface Window {
    __fsd?: FsdHandle;
  }
}

const FLAG_LABELS: [keyof ShowFlags, string][] = [
  ['signals', 'signal names'],
  ['rates', 'rates'],
  ['buffers', 'buffer sizes'],
  ['repetitions', 'repetitions'],
  ['constructors', 'constructors'],
  ['functions', 'functions'],
];

/** A three-slot strip holding one token, as the modern style draws a buffer. */
const LEGEND_STRIP = fifoSize(3, 0);

function Legend({ style }: { style: DiagramStyle }) {
  const modern = style === 'modern';
  return (
    <div className="legend">
      <div className="legend-title">Legend</div>
      <div className="legend-row">
        <span className="legend-swatch swatch-actor" />
        <span>actor: constructor and function inside</span>
      </div>
      <div className="legend-row">
        <span className="legend-swatch swatch-delay" />
        <span>
          {modern
            ? 'delay: its initial tokens, pre-filled on the signal'
            : 'delay with its initial tokens [..]'}
        </span>
      </div>
      <div className="legend-row">
        <span className="legend-pill">s</span>
        <span>system input or output</span>
      </div>
      <div className="legend-row">
        <span className="legend-glyph legend-rate">2</span>
        <span>rate at an edge end: tokens produced or consumed per firing</span>
      </div>
      <div className="legend-row">
        {modern ? (
          <svg
            className="legend-glyph"
            width={LEGEND_STRIP.w}
            height={LEGEND_STRIP.h}
            aria-hidden="true"
          >
            <rect
              className="fifo-outline"
              x={0.5}
              y={0.5}
              width={LEGEND_STRIP.w - 1}
              height={LEGEND_STRIP.h - 1}
              rx={3}
            />
            <Strip x={0} y={0} capacity={3} filled={1} />
          </svg>
        ) : (
          <span className="legend-glyph legend-buffer">&middot;4</span>
        )}
        <span>
          {modern
            ? 'buffer: one slot per token it holds at most under this schedule, filled slots hold tokens now'
            : 'buffer: maximum tokens held on the signal under this schedule'}
        </span>
      </div>
      <div className="legend-row">
        <span className="legend-glyph legend-badge">&times;2</span>
        <span>repetitions of the actor in one schedule iteration</span>
      </div>
      <div className="legend-row">
        <span className="legend-swatch swatch-newinput" />
        <span>drop target: drag a signal here to add an input</span>
      </div>
    </div>
  );
}

/** Clickable list of diagnostics, errors first; click jumps the cursor to the span. */
function ErrorBar({
  diagnostics,
  onGoto,
}: {
  diagnostics: Diagnostic[];
  onGoto(offset: number): void;
}) {
  if (!diagnostics.length) return null;
  return (
    <div className="error-bar">
      {orderDiagnostics(diagnostics).map((d, i) => (
        <button
          key={i}
          className={d.severity === 'error' ? 'err' : 'warn'}
          title="Jump to this diagnostic"
          onClick={() => onGoto(d.span.from)}
        >
          {d.message}
        </button>
      ))}
    </div>
  );
}

/** Number of weakly connected components over processes and io nodes. */
function componentCount(ir: IRSystem): number {
  const nodes = [...ir.processes.map((p) => p.name), ...ir.inputs, ...ir.outputs];
  const parent = new Map(nodes.map((n) => [n, n]));
  const find = (n: string): string => {
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const s of ir.signals) {
    const a = find(s.source.name);
    const b = find(s.target.name);
    if (a !== b) parent.set(a, b);
  }
  return new Set(nodes.map(find)).size;
}

/** Phones, portrait or landscape: one pane at a time. theme.css has the same query. */
const COMPACT_QUERY = '(max-width: 700px), (max-height: 500px) and (pointer: coarse)';
/** On a phone a fit stops here: 10 px labels stay at 9 px and the view pans instead. */
const COMPACT_FIT_MIN = 0.9;

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', changed);
      return () => m.removeEventListener('change', changed);
    },
    () => window.matchMedia(query).matches,
  );
}

const NOTICE_TIMEOUT_MS = 5000;
/** Presenting, a fit may zoom this far: 10 px labels read at 30 px on a small model. */
const PRESENT_FIT_MAX = 3;
const FLASH_TIMEOUT_MS = 1800;

/** Keystroke quiet period before the editor text is written to localStorage. */
const AUTOSAVE_MS = 500;
/** localStorage key for the working copy (text, baseline, example, positions). */
const WORKING_COPY_KEY = 'workingCopy';
/** Horizontal distance from a new source actor's center to its io nodes' centers. */
const IO_HINT_OFFSET = 110;

const DEFAULT_EXAMPLE = examples.find((e) => e.name === 'SDF_example_002') ?? examples[0];

/** Stored working copy, else the default example, unedited. */
const initialWorkingCopy = (): WorkingCopy => {
  const stored = storageGetWorkingCopy(WORKING_COPY_KEY);
  if (stored) {
    const known = examples.some((e) => e.name === stored.example);
    return { ...stored, example: known ? stored.example : '' };
  }
  const text = DEFAULT_EXAMPLE?.source ?? '';
  return {
    source: text,
    baseline: text,
    example: DEFAULT_EXAMPLE?.name ?? '',
    positions: new Map(),
    layoutEdited: false,
  };
};

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

/** Hints for a source actor created at `at`: the actor there, its io pills either side. */
function sourceActorHints(created: string[], at: Point): [string, Point][] {
  const [proc, inSig, outSig] = created;
  return [
    [proc!, at],
    [inSig!, { x: at.x - IO_HINT_OFFSET, y: at.y }],
    [outSig!, { x: at.x + IO_HINT_OFFSET, y: at.y }],
  ];
}

const initialAppTheme = (): string => storageGet('theme') ?? preferredTheme();

const initialDiagramTheme = (): 'modern' | 'lecture' =>
  storageGet('diagramTheme') === 'lecture' ? 'lecture' : 'modern';

export function App() {
  const editorRef = useRef<EditorApi>(null);
  const paneRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState('');

  const [initial] = useState(initialWorkingCopy);
  const [example, setExample] = useState(initial.example);
  // node positions keyed by process or io signal name; empty means the automatic layout
  const [positions, setPositions] = useState(initial.positions);
  // the replaced document's positions, shown until its model leaves the screen,
  // so the old diagram does not re-lay out under the new document's positions
  const [heldPositions, setHeldPositions] = useState<Map<string, Point> | null>(null);
  // gesture points (node centers) and diagram renames waiting for the model they produce
  const [hints, setHints] = useState<Map<string, Point>>(() => new Map());
  const [renames, setRenames] = useState<[string, string][]>([]);
  const queueRenames = useCallback((pairs: [string, string][]) => {
    if (pairs.length) setRenames((r) => [...r, ...pairs]);
  }, []);
  const [showUnitRates, setShowUnitRates] = useState(true);
  const [showSchedule, setShowSchedule] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(true);
  const [showFlags, setShowFlags] = useState<ShowFlags>(() =>
    storageGetJson('showFlags', DEFAULT_FLAGS),
  );
  const [legendOpen, setLegendOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const compact = useMedia(COMPACT_QUERY);
  // on a phone one pane shows at a time; the diagram first
  const [tab, setTab] = useState<'code' | 'diagram'>('diagram');
  const [showOpen, setShowOpen] = useState(() => storageGet('showOpen') === '1');
  useEffect(() => storageSet('showOpen', showOpen ? '1' : '0'), [showOpen]);
  useEffect(() => storageSet('showFlags', JSON.stringify(showFlags)), [showFlags]);

  // transient toast for refused gestures, optionally with an undo action
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const [appTheme, setAppTheme] = useState(initialAppTheme);
  const [diagramTheme, setDiagramTheme] = useState(initialDiagramTheme);
  const [fitRequest, setFitRequest] = useState(0);

  // SHOW toggles re-lay out (hidden labels take no space); the Schedule
  // button hides every schedule result. Both inputs keep their identity
  // between renders, or useScene would lay out on every render.
  const flags = useMemo<LabelFlags>(
    () => ({
      ...showFlags,
      unitRates: showUnitRates,
      buffers: showFlags.buffers && showSchedule,
      repetitions: showFlags.repetitions && showSchedule,
    }),
    [showFlags, showUnitRates, showSchedule],
  );
  const measure = useMemo(() => canvasMeasure(diagramTheme), [diagramTheme]);
  const pipe = useScene(source, flags, measure, diagramTheme);
  const model = pipe.model;
  const shownPositions = heldPositions ?? positions;
  // what the diagram draws: the model's scene, with pinned nodes where the user put them
  const view = useMemo(
    () =>
      model && shownPositions.size
        ? { ...model, scene: pinScene(model.scene, shownPositions) }
        : model,
    [model, shownPositions],
  );
  const parts = useMemo(() => (model ? componentCount(model.ir) : 0), [model]);
  const facts = useMemo(() => (model ? analyze(model.ir) : null), [model]);
  const sim = useSimulation(model, parts === 1, showSchedule && scheduleOpen);
  const { trace, stuck, pos } = sim;
  // why there is no schedule, in the model's names, with a checked fix when one exists
  const explanation = useMemo(
    () =>
      model && !model.schedule.ok
        ? explain(model.source, model.ir, model.schedule, facts, stuck, parts)
        : null,
    [model, facts, stuck, parts],
  );
  const schedError = explanation?.message ?? null;
  // the failure also lists with the editor's problems, as a warning on the text as it is
  const diagnostics = useMemo(
    () =>
      explanation && model?.source === source
        ? [...pipe.diagnostics, scheduleWarning(explanation)]
        : pipe.diagnostics,
    [explanation, model, source, pipe.diagnostics],
  );
  const marks = useMemo(
    () => (model ? simMarks(model, { trace: showSchedule ? trace : null, stuck, pos }) : undefined),
    [model, trace, stuck, pos, showSchedule],
  );
  // editor <-> diagram links, valid only while the diagram shows the text as it is
  const [cursor, setCursor] = useState<number | null>(null);
  const current = !!model && model.source === source;
  const linked = useMemo(
    () =>
      current && cursor !== null ? linkedAt(model!.ir, model!.source, cursor, edgeIdOf) : undefined,
    [current, cursor, model],
  );
  const spansOf = useCallback(
    (t: Target) =>
      model && editorRef.current?.getDoc() === model.source
        ? sourceSpans(model.ir, model.source, t)
        : [],
    [model],
  );
  const onHoverTarget = useCallback(
    (t: Target | null) => editorRef.current?.highlight(t ? spansOf(t) : []),
    [spansOf],
  );
  const onJump = useCallback(
    (t: Target) => {
      const [first] = spansOf(t);
      if (first) editorRef.current?.gotoOffset(first.from);
    },
    [spansOf],
  );
  /** An edit in place on the canvas: the same splices and staleness guard as the popover. */
  const onInlineEdit = useCallback(
    (t: EditTarget, text: string): string | null => {
      const editor = editorRef.current;
      if (!model || !editor || editor.getDoc() !== model.source)
        return 'the text changed since the diagram was drawn, try again';
      const r = inlineEdit(model.ir, model.source, t, text);
      if (typeof r === 'string') return r;
      const to = text.trim();
      if (t.kind === 'name') queueRenames([[t.node, to]]);
      if (t.kind === 'signal') queueRenames([[t.signal, to]]);
      editor.applySplices(r);
      return null;
    },
    [model, queueRenames],
  );

  // a new model moves text around: drop highlights that point at old offsets
  useEffect(() => editorRef.current?.highlight([]), [model]);

  // one click to watch the model run: bring the timeline on screen and play
  const startAnimation = () => {
    setShowSchedule(true);
    setScheduleOpen(true);
    sim.play();
  };
  /** Why Animate and the timeline have nothing to show; null when they do. */
  const nothingToRun = trace
    ? null
    : schedError
      ? `Not schedulable: ${schedError}`
      : 'Nothing to run yet: fix the errors listed above the editor';
  const onAnimate = () => {
    if (sim.playing) return sim.stop();
    if (nothingToRun) return setNotice({ text: nothingToRun });
    startAnimation();
  };
  const onToggleSchedule = () => {
    // switching the results on with none to show: say why instead of doing nothing visible
    if (!showSchedule && nothingToRun) setNotice({ text: nothingToRun });
    setShowSchedule((v) => !v);
  };
  // the tour starts it from outside React's render, so it needs the latest one
  const animateRef = useRef(startAnimation);
  useEffect(() => {
    animateRef.current = startAnimation;
  });
  const tourHooks = useMemo(
    () => ({
      animate: () => animateRef.current(),
      // synchronously, so the tour measures the pane after it is shown
      tab: (t: 'code' | 'diagram') => {
        flushSync(() => setTab(t));
        if (t === 'diagram') setFitRequest((n) => n + 1);
      },
      compact,
    }),
    [compact],
  );
  const { stepSeq, stepMs } = sim;
  const travel = useMemo<Travel | null>(
    () =>
      model && trace && showSchedule && stepSeq !== null && pos > 0
        ? {
            seq: stepSeq,
            step: trace.steps[pos - 1]!,
            before: fillAt(model, trace, pos - 1),
            ms: stepMs,
          }
        : null,
    [model, trace, showSchedule, stepSeq, pos, stepMs],
  );

  // when processes appear or disappear, pulse the new ones and re-fit;
  // derived-during-render pattern so no setState-in-effect
  const [flash, setFlash] = useState<string[]>([]);
  const [prevModel, setPrevModel] = useState<typeof model>(null);
  if (model !== prevModel) {
    setPrevModel(model);
    // pinned: place new nodes and write them back so they stay put; keeps removed ids.
    // A new document's first model has no known ids: every entry is its own.
    if (model && positions.size) {
      let pos = positions;
      for (const [from, to] of renames) pos = renameKey(pos, from, to);
      const known =
        prevModel && !heldPositions ? new Set(prevModel.scene.nodes.map((n) => n.id)) : undefined;
      setPositions(placeModel(model, pos, hints, known));
    }
    if (model && heldPositions) setHeldPositions(null);
    if (model && hints.size) setHints(new Map());
    if (model && renames.length) setRenames([]);
    if (model && prevModel) {
      const names = model.ir.processes.map((p) => p.name);
      const prev = prevModel.ir.processes.map((p) => p.name);
      const added = names.filter((n) => !prev.includes(n));
      if (added.length && names.length !== prev.length) {
        setFlash(added);
        setFitRequest((n) => n + 1);
      } else if (names.length < prev.length) {
        setFitRequest((n) => n + 1);
      }
    }
  }
  useEffect(() => {
    if (!flash.length) return;
    const t = setTimeout(() => setFlash([]), FLASH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [flash]);
  const [popover, setPopover] = useState<{ target: PopoverTarget; x: number; y: number } | null>(
    null,
  );
  // `at` is the right-click point in scene coordinates, where canvas adds land
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number; at: Point } | null>(
    null,
  );
  // source whose model the next fit waits for; null when none is pending
  const pendingFit = useRef<string | null>(null);
  const exportingRef = useRef(false);

  // the model on screen, for handlers and callbacks that must not go stale;
  // updated after the diagram's effects, so a fit consults the committed model
  const modelRef = useRef(model);
  const viewRef = useRef(view);
  const traceRef = useRef(trace);
  useEffect(() => {
    modelRef.current = model;
    viewRef.current = view;
    traceRef.current = trace;
  }, [model, view, trace]);
  useEffect(() => {
    window.__fsd = {
      getDoc: () => editorRef.current?.getDoc() ?? '',
      setSource: (src) => {
        pendingFit.current = src;
        editorRef.current?.setSource(src);
      },
      scene: () => viewRef.current?.scene ?? null,
      ir: () => modelRef.current?.ir ?? null,
      trace: () => traceRef.current,
      animating,
      setMotion,
      setCursor: (offset) => editorRef.current?.gotoOffset(offset),
    };
    return () => {
      delete window.__fsd;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appTheme);
    storageSet('theme', appTheme);
  }, [appTheme]);
  useEffect(() => storageSet('diagramTheme', diagramTheme), [diagramTheme]);

  const baselineRef = useRef(initial.baseline);
  // a drag or Tidy since the baseline: unsaved even when the text is unchanged
  const layoutEditedRef = useRef(initial.layoutEdited);

  // autosave: the whole working copy under one key, debounced, plus a flush on
  // pagehide so a quick close keeps the last keystrokes
  const latestRef = useRef<WorkingCopy | null>(null); // null until the editor is loaded
  const flush = useCallback(() => {
    if (latestRef.current)
      storageSetWorkingCopy(WORKING_COPY_KEY, {
        ...latestRef.current,
        baseline: baselineRef.current,
        layoutEdited: layoutEditedRef.current,
      });
  }, []);
  useEffect(() => {
    if (latestRef.current === null) return; // editor not loaded yet: keep what is stored
    latestRef.current = { ...latestRef.current, source, example, positions };
    const t = setTimeout(flush, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [source, example, positions, flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [flush]);

  const markSaved = useCallback(
    (text: string) => {
      baselineRef.current = text;
      layoutEditedRef.current = false;
      flush();
    },
    [flush],
  );

  /** Replace the whole working copy after the unsaved-changes confirm; false if declined. */
  const replaceDoc = useCallback(
    (text: string, from: string, pos: Map<string, Point>, what: string): boolean => {
      if (editorRef.current?.getDoc() !== baselineRef.current || layoutEditedRef.current) {
        if (!window.confirm(`Discard unsaved changes and ${what}?`)) return false;
      }
      // same text (reopening the file on screen): no new model will come to place
      // it or to consume a pending fit, so place and fit now
      const m = modelRef.current;
      const same = m?.source === text;
      setExample(from);
      if (m && !same) setHeldPositions((h) => h ?? positions);
      else setHeldPositions(null);
      setPositions(m && same && pos.size ? placeModel(m, pos, new Map()) : pos);
      setPopover(null);
      setMenu(null);
      setNotice(null); // Tidy's undo belongs to the old document
      markSaved(text);
      pendingFit.current = same ? null : text;
      if (same) setFitRequest((n) => n + 1);
      editorRef.current?.setSource(text);
      return true;
    },
    [markSaved, positions],
  );

  const loadExample = useCallback(
    (name: string) => {
      const ex = examples.find((e) => e.name === name);
      if (ex) replaceDoc(ex.source, name, new Map(), 'load this example');
    },
    [replaceDoc],
  );

  const onNew = () => replaceDoc(BLANK_MODEL, '', new Map(), 'start a new model');

  const onOpen = (file: File) => {
    file
      .text()
      .then((raw) => {
        // the editor normalizes to \n; the baseline and model.source must match its text
        const text = raw.replace(/\r\n?/g, '\n');
        replaceDoc(stripLayoutBlock(text), '', parseLayoutBlock(text), `open ${file.name}`);
      })
      .catch(() => setNotice({ text: `could not read ${file.name}` }));
  };

  const onExportHs = useCallback(() => {
    const doc = editorRef.current?.getDoc() ?? '';
    // stale ids kept for editor undo are not part of the file; filter only by
    // the model of this very text, else (errors, debounce) keep every position
    const ids = new Set(model?.scene.nodes.map((n) => n.id));
    const saved =
      model?.source === doc ? new Map([...positions].filter(([id]) => ids.has(id))) : positions;
    download(writeLayoutBlock(doc, saved), exportFileName(doc), 'text/x-haskell');
    markSaved(doc);
  }, [model, positions, markSaved]);

  const onTidy = () => {
    setFitRequest((n) => n + 1);
    if (!positions.size) return;
    const prev = positions;
    const prevEdited = layoutEditedRef.current;
    layoutEditedRef.current = true;
    setHeldPositions(null);
    setPositions(new Map());
    setNotice({
      text: 'automatic layout restored',
      undo: () => {
        // cleared flag: a save since Tidy wrote the tidy layout, so this differs from it
        layoutEditedRef.current = layoutEditedRef.current ? prevEdited : true;
        // the text may have changed since Tidy: place against the current model
        const m = modelRef.current;
        setPositions(m ? placeModel(m, prev, new Map()) : prev);
        setNotice(null);
        setFitRequest((n) => n + 1);
      },
    });
  };

  /** A node move landed: pin every node there (the first move pins the whole layout). */
  const onPin = (pinned: Map<string, Point>) => {
    // a held diagram belongs to the replaced document: pin into its map and
    // leave the new document's positions alone until its model arrives
    layoutEditedRef.current = true;
    if (heldPositions) setHeldPositions((h) => h && new Map([...h, ...pinned]));
    else setPositions((q) => new Map([...q, ...pinned]));
  };

  // restore the working copy once the editor is mounted, else the default example
  // (idempotent under StrictMode)
  useEffect(() => {
    latestRef.current = initial;
    pendingFit.current = initial.source;
    editorRef.current?.setSource(initial.source);
  }, [initial]);

  // first-run tour: once a valid model is on screen, never on a broken/empty first paint
  const tourStarted = useRef(false);
  useEffect(() => {
    if (tourStarted.current || storageGet(TOUR_SEEN_KEY) || !model) return;
    tourStarted.current = true;
    void startTour(() => storageSet(TOUR_SEEN_KEY, '1'), tourHooks);
  }, [model, tourHooks]);

  // consulted by the diagram after each scene change, with the source of the
  // model it drew: only the model for the replaced text consumes the fit, not
  // the old model's nodes moving to the new positions. (A ref to the model
  // would lag: the diagram's effects run before App's.)
  const consumePendingFit = useCallback((shown: string) => {
    if (pendingFit.current === null || pendingFit.current !== shown) return false;
    pendingFit.current = null;
    return true;
  }, []);

  // splitter drag; initial ratio read once (lazy state) for render stability
  const [splitRatio] = useState(() => storageGet('splitRatio') ?? '45%');
  const panesRef = useRef<HTMLElement>(null);
  const onSplitterDown = (down: React.PointerEvent<HTMLDivElement>) => {
    const splitter = down.currentTarget;
    splitter.setPointerCapture(down.pointerId);
    const onMove = (move: PointerEvent) => {
      const panes = panesRef.current;
      if (!panes) return;
      const rect = panes.getBoundingClientRect();
      const ratio = Math.min(0.8, Math.max(0.2, (move.clientX - rect.left) / rect.width));
      panes.style.setProperty('--split', `${(ratio * 100).toFixed(1)}%`);
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      const v = panesRef.current?.style.getPropertyValue('--split');
      if (v) storageSet('splitRatio', v);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  };

  const paneCoords = useCallback((clientX: number, clientY: number) => {
    const rect = paneRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  /** Export the diagram as it is on screen (waiting out any animation), named after the module. */
  const onExport = useCallback(
    async (kind: ExportKind) => {
      const wrap = paneRef.current?.querySelector<HTMLElement>('.diagram-wrap');
      if (!model || !wrap) {
        setNotice({ text: 'nothing to export yet' });
        return;
      }
      if (kind === 'hs') return onExportHs();
      if (exportingRef.current) {
        setNotice({ text: 'export in progress' });
        return;
      }
      exportingRef.current = true;
      const name = /^module\s+([\w.']+)/m.exec(model.source)?.[1] ?? 'diagram';
      const ctx = {
        style: diagramTheme,
        tokens: new Map(model.ir.processes.filter(isDelay).map((d) => [d.name, d.tokens.length])),
      };
      const scene = (view ?? model).scene;
      const svg = () => sceneToSvg(wrap, scene.bounds);
      try {
        if (kind === 'png') download(await svgToPngBlob(await svg()), `${name}.png`);
        else if (kind === 'svg') download(await svg(), `${name}.svg`, 'image/svg+xml');
        else if (kind === 'tikz')
          download(sceneToTikz(scene, ctx), `${name}.tex`, 'application/x-tex');
        else {
          await navigator.clipboard.writeText(tikzPicture(scene, ctx));
          setNotice({
            text: 'TikZ picture copied: needs \\usepackage{tikz} and \\usetikzlibrary{arrows.meta}',
          });
        }
      } catch {
        setNotice({ text: 'export failed' });
      } finally {
        exportingRef.current = false;
      }
    },
    [model, view, diagramTheme, onExportHs],
  );

  const onFix = () => {
    const fix = explanation?.fix;
    if (!fix || !model) return;
    if (editorRef.current?.getDoc() !== model.source) {
      setNotice({ text: 'diagram is stale, try again once it updates' });
      return;
    }
    editorRef.current.applySplices(fix.splices);
  };

  const onAddDelay = () => {
    setNotice({ text: 'a delay needs a signal: drag the delay chip onto an edge' });
  };

  const onAddActor = () => {
    if (!model) return;
    if (editorRef.current?.getDoc() !== model.source) {
      setNotice({ text: 'diagram is stale, try again once it updates' });
      return;
    }
    editorRef.current?.applySplices(addSourceActor(model.source, model.ir).splices);
  };

  const onDropInsert = useCallback(
    (kind: 'actor' | 'delay', edgeId: string | null, at: Point) => {
      if (!model) return;
      if (editorRef.current?.getDoc() !== model.source) {
        setNotice({ text: 'diagram is stale, try again once it updates' });
        return;
      }
      if (edgeId) {
        const sig = model.edgeSignals.get(edgeId);
        if (!sig) return;
        const r = insertOnEdge(model.source, model.ir, sig, kind);
        setHints((h) => new Map(h).set(r.created[0]!, at));
        queueRenames(outputRenames(model.ir, r.splices));
        editorRef.current?.applySplices(r.splices);
      } else if (kind === 'actor') {
        // dropped on empty canvas: a source actor, where it was dropped
        const r = addSourceActor(model.source, model.ir);
        setHints((h) => new Map([...h, ...sourceActorHints(r.created, at)]));
        editorRef.current?.applySplices(r.splices);
      } else {
        // a floating delay has no valid text form
        setNotice({ text: 'a delay needs a signal: drop the delay chip onto an edge' });
      }
    },
    [model, queueRenames],
  );

  // drag-to-connect: a refused connection explains itself instead of doing nothing
  const onConnect = useCallback(
    (signal: string, proc: string) => {
      if (!model) return;
      if (editorRef.current?.getDoc() !== model.source) {
        setNotice({ text: 'diagram is stale, try again once it updates' });
        return;
      }
      const splices = addInput(model.ir, proc, signal);
      if (splices) editorRef.current?.applySplices(splices);
      else
        setNotice({
          text: addInputError(model.ir, proc, signal) ?? 'connection not possible here',
        });
    },
    [model],
  );

  /** Menu shortcut into the popover: same targets, actions inline, same staleness guard. */
  const onMenuPick = useCallback(
    (action: string) => {
      if (!model || !menu) return;
      if (editorRef.current?.getDoc() !== model.source) {
        setNotice({ text: 'diagram is stale, try again once it updates' });
        return;
      }
      const editor = editorRef.current!;
      if (menu.target.kind === 'canvas') {
        if (action === 'add-actor') {
          const r = addSourceActor(model.source, model.ir);
          const at = menu.at;
          setHints((h) => new Map([...h, ...sourceActorHints(r.created, at)]));
          editor.applySplices(r.splices);
          setMenu(null);
        } else if (action === 'fit-view') {
          setFitRequest((n) => n + 1);
          setMenu(null);
        }
        return;
      }
      if (menu.target.kind === 'edge') {
        const sig = model.edgeSignals.get(menu.target.edgeId);
        if (action === 'insert-actor' || action === 'insert-delay') {
          if (!sig) return;
          const kind = action === 'insert-actor' ? 'actor' : 'delay';
          const r = insertOnEdge(model.source, model.ir, sig, kind);
          const mid = view && edgeMidpoint(view.scene, menu.target.edgeId);
          if (mid) setHints((h) => new Map(h).set(r.created[0]!, mid));
          queueRenames(outputRenames(model.ir, r.splices));
          editor.applySplices(r.splices);
          setMenu(null);
        } else if (action === 'rename-signal') {
          if (!sig) return;
          setMenu(null);
          setPopover({
            target: { kind: 'edge', edgeId: menu.target.edgeId },
            x: menu.x,
            y: menu.y,
          });
        }
        return;
      }
      const target = menu.target;
      if (target.kind !== 'node') return;
      const p = model.ir.processes.find((q) => q.name === target.name);
      if (!p) {
        setMenu(null);
        return;
      }
      const delay = isDelay(p);
      if (action === 'delete') {
        const splices = deleteProcess(model.ir, p.name);
        if (splices) {
          setMenu(null);
          queueRenames(outputRenames(model.ir, splices));
          editor.applySplices(splices);
        }
        return;
      }
      if (action === 'goto-definition') {
        const fn = delay ? '' : p.function;
        if (!fn || fn === 'NULL') return;
        const at = findDefinitionOffset(editor.getDoc(), fn);
        if (at >= 0) {
          setMenu(null);
          editor.gotoOffset(at);
        }
        return;
      }
      // rename / rates / function / tokens: open the popover pre-focused at the same spot
      if (
        action === 'rename' ||
        action === 'rates' ||
        action === 'function' ||
        action === 'tokens'
      ) {
        setMenu(null);
        setPopover({ target: { kind: 'node', name: p.name }, x: menu.x, y: menu.y });
      }
    },
    [model, menu, view, queueRenames],
  );

  const onContextMenu = useCallback(
    (target: SceneTarget, cx: number, cy: number, at: Point) => {
      setPopover(null);
      setMenu({
        target: target.kind === 'edge' ? { ...target, signalName: '' } : target,
        at,
        ...paneCoords(cx, cy),
      });
    },
    [paneCoords],
  );

  const togglePresent = () => {
    setPresenting((v) => !v);
    setTab('diagram'); // a phone on the Code tab would present nothing
    // Space plays from here on: the Present button must not keep focus and click again
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPopover(null);
    setMenu(null);
    setFitRequest((n) => n + 1); // the pane changes size
  };
  // presenting: Space plays, the arrow keys step, Esc leaves; P toggles anywhere
  // outside a text field. Captured, so a focused node does not also nudge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('.cm-editor, input, textarea, select, [contenteditable]')) return;
      const act =
        e.key === 'p' || e.key === 'P' || (presenting && e.key === 'Escape')
          ? togglePresent
          : !presenting
            ? null
            : e.key === ' '
              ? onAnimate
              : e.key === 'ArrowRight'
                ? () => sim.step(1)
                : e.key === 'ArrowLeft'
                  ? () => sim.step(-1)
                  : null;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className={`app tab-${tab}${presenting ? ' presenting' : ''}`}>
      <Toolbar
        example={example}
        onExample={loadExample}
        onFit={() => setFitRequest((n) => n + 1)}
        showSchedule={showSchedule}
        onToggleSchedule={onToggleSchedule}
        onAddActor={onAddActor}
        onAddDelay={onAddDelay}
        onExport={(k) => void onExport(k)}
        onNew={onNew}
        onOpen={onOpen}
        onTidy={onTidy}
        onTour={() => void startTour(() => storageSet(TOUR_SEEN_KEY, '1'), tourHooks)}
        animating={sim.playing}
        canAnimate={!!model}
        animateBlocked={nothingToRun}
        onAnimate={onAnimate}
        diagramTheme={diagramTheme}
        onToggleDiagramTheme={() => setDiagramTheme((t) => (t === 'modern' ? 'lecture' : 'modern'))}
        onToggleAppTheme={() => setAppTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        presenting={presenting}
        onPresent={togglePresent}
      />
      <nav className="tabs" role="tablist">
        {(['code', 'diagram'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setPopover(null);
              setMenu(null);
              if (t === 'diagram') setFitRequest((n) => n + 1); // it measured 0x0 while hidden
            }}
          >
            {t === 'code' ? 'Code' : 'Diagram'}
            {t === 'code' && diagnostics.some((d) => d.severity === 'error') && (
              <span className="tab-errors" aria-label="has errors">
                !
              </span>
            )}
          </button>
        ))}
      </nav>
      <main className="panes" ref={panesRef} style={{ ['--split' as string]: splitRatio }}>
        <section className="pane editor-pane">
          <ErrorBar
            diagnostics={diagnostics}
            onGoto={(offset) => editorRef.current?.gotoOffset(offset)}
          />
          <EditorPane
            ref={editorRef}
            onChange={setSource}
            onCursor={setCursor}
            diagnostics={diagnostics}
            dark={appTheme === 'dark'}
          />
        </section>
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onSplitterDown}
        />
        <section
          className={`pane diagram-pane diagram-${diagramTheme}${showSchedule ? '' : ' schedule-off'}`}
          ref={paneRef}
        >
          <SceneView
            linked={linked}
            onHoverTarget={onHoverTarget}
            onJump={onJump}
            onInlineEdit={onInlineEdit}
            onPin={onPin}
            model={view}
            style={diagramTheme}
            flags={flags}
            schedule={showSchedule}
            stale={pipe.stale}
            marks={marks}
            travel={travel}
            flash={flash}
            fitRequest={fitRequest}
            fitMax={presenting ? PRESENT_FIT_MAX : undefined}
            fitMin={compact ? COMPACT_FIT_MIN : undefined}
            consumePendingFit={consumePendingFit}
            onNodeClick={(id, cx, cy) => {
              if (!model?.ir.processes.some((q) => q.name === id)) return;
              setMenu(null);
              setPopover({ target: { kind: 'node', name: id }, ...paneCoords(cx, cy) });
            }}
            onEdgeClick={(edgeId, cx, cy) => {
              setMenu(null);
              setPopover({ target: { kind: 'edge', edgeId }, ...paneCoords(cx, cy) });
            }}
            onPaneClick={() => {
              setPopover(null);
              setMenu(null);
            }}
            onContextMenu={onContextMenu}
            onDropInsert={onDropInsert}
            onConnect={onConnect}
          />
          <div className={`float-controls${showOpen ? ' open' : ''}`}>
            <span className="detail-switch" title="Toggle each annotation on the diagram">
              <button
                className="switch-title"
                aria-expanded={showOpen}
                onClick={() => setShowOpen((v) => !v)}
              >
                show {showOpen ? '▾' : '▸'}
              </button>
              {FLAG_LABELS.map(([key, label]) => (
                <span key={key} className="switch-group">
                  <button
                    className={showFlags[key] ? 'active' : ''}
                    onClick={() => setShowFlags((f) => ({ ...f, [key]: !f[key] }))}
                  >
                    {label}
                  </button>
                  {key === 'rates' && (
                    <button
                      className={`sub ${showUnitRates ? 'active' : ''}`}
                      disabled={!showFlags.rates}
                      title="Also show rates equal to 1"
                      onClick={() => setShowUnitRates((v) => !v)}
                    >
                      rates equal to 1
                    </button>
                  )}
                </span>
              ))}
            </span>
            <button
              className={legendOpen ? 'active' : ''}
              title="Explain the diagram notation"
              onClick={() => setLegendOpen((v) => !v)}
            >
              legend
            </button>
            {legendOpen && <Legend style={diagramTheme} />}
          </div>
          {popover && model && (
            <EditPopover
              target={popover.target}
              x={popover.x}
              y={popover.y}
              model={model}
              editorRef={editorRef}
              onClose={() => setPopover(null)}
              onInserted={(proc) => {
                const mid =
                  popover.target.kind === 'edge' && view
                    ? edgeMidpoint(view.scene, popover.target.edgeId)
                    : null;
                if (mid) setHints((h) => new Map(h).set(proc, mid));
              }}
              onRenamed={(from, to) => setRenames((r) => [...r, [from, to]])}
              notes={marks?.notes.get(
                popover.target.kind === 'node' ? popover.target.name : popover.target.edgeId,
              )}
            />
          )}
          {menu && model && (
            <Menu
              x={menu.x}
              y={menu.y}
              items={menuItems(
                menu.target.kind === 'edge'
                  ? {
                      kind: 'edge',
                      edgeId: menu.target.edgeId,
                      signalName: model.edgeSignals.get(menu.target.edgeId)?.name ?? '',
                    }
                  : menu.target,
                model.ir,
              )}
              onPick={onMenuPick}
              onClose={() => setMenu(null)}
            />
          )}
          {pipe.stale && model && (
            <div className="status-chip">
              Showing last valid diagram: {pipe.errorCount} error{pipe.errorCount === 1 ? '' : 's'}
            </div>
          )}
          {notice && (
            <div className="notice-toast">
              {notice.text}
              {notice.undo && <button onClick={notice.undo}>Undo</button>}
            </div>
          )}
          <div className="dock">
            {explanation && (
              <div className="sched-banner" role="alert">
                <div>Not schedulable: {explanation.message}</div>
                {explanation.lines.map((l) => (
                  <div key={l} className="sched-detail">
                    {l}
                  </div>
                ))}
                {explanation.fix && (
                  <button className="sched-fix" onClick={onFix}>
                    {explanation.fix.label}
                  </button>
                )}
              </div>
            )}
            {showSchedule && (trace || facts) && (
              <Timeline
                sched={pipe.schedule?.ok ? pipe.schedule : null}
                facts={facts}
                onJump={onJump}
                sim={sim}
                open={scheduleOpen}
                onToggle={() => setScheduleOpen((v) => !v)}
              />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
