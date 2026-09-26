import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import {
  addInput,
  addInputError,
  addSourceActor,
  deleteProcess,
  insertOnEdge,
  outputRenames,
} from '../core/edits';
import { isDelay, type IRSystem } from '../core/ir';
import { Menu, menuItems, type MenuAction, type MenuTarget } from '../diagram/ContextMenu';
import { findDefinitionOffset } from '../diagram/labels';
import { EditPopover, type EditGuard, type PopoverTarget } from '../diagram/Popovers';
import { EditorPane, type EditorApi } from '../editor/EditorPane';
import { animating, setMotion, type Travel } from '../render/animate';
import { SceneView, type SceneTarget } from '../render/SceneView';
import { canvasMeasure } from '../scene/measure';
import type { LabelFlags, Scene } from '../scene/types';
import type { SimTrace } from '../sim/simulate';
import { examples } from './examples';
import { preferredTheme, storageGet, storageGetJson, storageSet } from './storage';
import { Toolbar, type ExportKind } from './Toolbar';
import { Timeline } from './Timeline';
import { analyze } from '../core/analysis';
import { parseTimes } from '../sim/timed';
import { scheduleWarning } from './scheduleWarning';
import { explain } from './explain';
import { download, sceneToSvg, SourceChanged, svgToPngBlob } from '../export/svg';
import { sceneToTikz, tikzPicture } from '../export/tikz';
import { startLearn, startTour, TOUR_SEEN_KEY } from './tour';
import { useScene } from './useScene';
import { BLANK_MODEL, exportFileName } from './files';
import {
  parseLayoutBlock,
  stripLayoutBlock,
  writeLayoutBlock,
  type Point,
} from '../core/layoutBlock';
import { edgeMidpoint } from '../diagram/placement';
import { linkedAt, sourceSpans, type Target } from '../core/links';
import { inlineEdit, type EditTarget } from '../core/inlineEdit';
import { edgeId as edgeIdOf } from '../scene/labels';
import { fillAt, simMarks, useSimulation } from './useSimulation';
import { DiagramBoundary } from './DiagramBoundary';
import { ErrorBar } from './ErrorBar';
import { DEFAULT_FLAGS, ShowToggles, type ShowFlags } from './ShowToggles';
import { usePinnedLayout } from './usePinnedLayout';
import { initialWorkingCopy, useWorkingCopy } from './useWorkingCopy';

/** Test and debugging handle; the e2e harness drives the app through it (dev server only). */
interface FsdHandle {
  getDoc(): string;
  setSource(src: string): void;
  scene(): Scene | null;
  ir(): IRSystem | null;
  /** What playback shows: one schedule period, else the start of a stuck run. */
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
/** Horizontal distance from a new source actor's center to its io nodes' centers. */
const IO_HINT_OFFSET = 110;
/** What every diagram edit says when the diagram no longer shows the text as it is. */
const STALE = 'diagram is stale, try again once it updates';
/** The splitter's range and keyboard step, in percent of the panes' width. */
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;
const SPLIT_STEP = 5;

/** Hints for a source actor created at `at`: the actor there, its io pills either side. */
function sourceActorHints(created: string[], at: Point): [string, Point][] {
  const [proc, inSig, outSig] = created;
  return [
    [proc!, at],
    [inSig!, { x: at.x - IO_HINT_OFFSET, y: at.y }],
    [outSig!, { x: at.x + IO_HINT_OFFSET, y: at.y }],
  ];
}

const initialAppTheme = (): 'light' | 'dark' =>
  (storageGet('theme') ?? preferredTheme()) === 'dark' ? 'dark' : 'light';

const initialDiagramTheme = (): 'modern' | 'lecture' =>
  storageGet('diagramTheme') === 'lecture' ? 'lecture' : 'modern';

export function App() {
  const editorRef = useRef<EditorApi>(null);
  const paneRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState('');

  const [initial] = useState(initialWorkingCopy);
  const [showUnitRates, setShowUnitRates] = useState(true);
  const [showSchedule, setShowSchedule] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(true);
  const toggleScheduleOpen = useCallback(() => setScheduleOpen((v) => !v), []);
  const [showFlags, setShowFlags] = useState<ShowFlags>(() =>
    storageGetJson('showFlags', DEFAULT_FLAGS),
  );
  const [presenting, setPresenting] = useState(false);
  const compact = useMedia(COMPACT_QUERY);
  // on a phone one pane shows at a time; the diagram first
  const [tab, setTab] = useState<'code' | 'diagram'>('diagram');
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
  const requestFit = useCallback(() => setFitRequest((n) => n + 1), []);

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
  const pinned = usePinnedLayout(model, initial.positions);
  const { view, queueRenames, addHints } = pinned;
  const parts = useMemo(() => (model ? componentCount(model.ir) : 0), [model]);
  const facts = useMemo(() => (model ? analyze(model.ir, model.schedule.rank) : null), [model]);
  const times = useMemo(() => parseTimes(model?.source ?? ''), [model]);
  const sim = useSimulation(model, showSchedule && scheduleOpen);
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

  /** Every diagram-driven edit goes through here; see EditGuard. */
  const editGuarded = useCallback<EditGuard>(
    (make, quiet = false) => {
      const editor = editorRef.current;
      if (!model || !editor || editor.getDoc() !== model.source) {
        if (!quiet) setNotice({ text: STALE });
        return STALE;
      }
      return make(model, editor) ?? null;
    },
    [model],
  );

  /** An edit in place on the canvas: the same splices and staleness guard as the popover. */
  const onInlineEdit = useCallback(
    (t: EditTarget, text: string): string | null =>
      editGuarded((m, editor) => {
        const r = inlineEdit(m.ir, m.source, t, text);
        if (typeof r === 'string') return r;
        const to = text.trim();
        if (t.kind === 'name') queueRenames([[t.node, to]]);
        if (t.kind === 'signal') queueRenames([[t.signal, to]]);
        editor.applySplices(r);
      }, true),
    [editGuarded, queueRenames],
  );

  /** Go to a function's definition in the editor; false when there is none. */
  const gotoDefinition = useCallback((fn: string) => {
    const editor = editorRef.current;
    const at = editor && fn && fn !== 'NULL' ? findDefinitionOffset(editor.getDoc(), fn) : -1;
    if (at < 0) return false;
    editor!.gotoOffset(at);
    return true;
  }, []);

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
  // the tour starts it from outside React's render, so it needs the latest one;
  // a ref, not useEffectEvent, which may only be called from effects
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
        if (t === 'diagram') requestFit();
      },
      compact,
    }),
    [compact, requestFit],
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
    if (model && prevModel) {
      const names = model.ir.processes.map((p) => p.name);
      const prev = prevModel.ir.processes.map((p) => p.name);
      const added = names.filter((n) => !prev.includes(n));
      if (added.length && names.length !== prev.length) {
        setFlash(added);
        requestFit();
      } else if (names.length < prev.length) {
        requestFit();
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
  const closeOverlays = useCallback(() => {
    setPopover(null);
    setMenu(null);
  }, []);
  // source whose model the next fit waits for; null when none is pending
  const pendingFit = useRef<string | null>(null);
  const exportingRef = useRef(false);

  // the model on screen, for handlers and callbacks that must not go stale;
  // updated after the diagram's effects, so a fit consults the committed model
  const modelRef = useRef(model);
  const viewRef = useRef(view);
  const traceRef = useRef(trace);
  // a lesson the Learn SDF walk waits for: resolved when its model is on screen
  const lessonWait = useRef<{ source: string; done(shown: boolean): void } | null>(null);
  useEffect(() => {
    modelRef.current = model;
    viewRef.current = view;
    traceRef.current = trace;
    const w = lessonWait.current;
    if (w && model?.source === w.source) {
      lessonWait.current = null;
      w.done(true);
    }
  }, [model, view, trace]);
  // the text moved on (typed, or another document) before the lesson's model came
  useEffect(() => {
    const w = lessonWait.current;
    if (w && source !== w.source) {
      lessonWait.current = null;
      w.done(false);
    }
  }, [source]);
  useEffect(() => {
    // the e2e suite runs against the dev server; a build has no handle
    if (!import.meta.env.DEV) return;
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

  /** Put a new document's text and positions on screen, dropping the old one's overlays. */
  const { replace: replacePositions } = pinned;
  const load = useCallback(
    (text: string, pos: Map<string, Point>) => {
      // same text (reopening the file on screen): no new model will come to place
      // it or to consume a pending fit, so place and fit now
      const m = modelRef.current;
      const same = m?.source === text;
      replacePositions(m, pos, same);
      closeOverlays();
      setNotice(null); // Tidy's undo belongs to the old document
      pendingFit.current = same ? null : text;
      if (same) requestFit();
      editorRef.current?.setSource(text);
    },
    [replacePositions, closeOverlays, requestFit],
  );
  const { example, replaceDoc, markSaved, layoutEditedRef } = useWorkingCopy(
    editorRef,
    initial,
    source,
    pinned.positions,
    load,
  );

  const loadExample = useCallback(
    (name: string) => {
      const ex = examples.find((e) => e.name === name);
      if (ex) replaceDoc(ex.source, name, new Map(), 'load this example');
    },
    [replaceDoc],
  );

  // the Learn SDF walk loads lessons itself and waits for their diagrams
  const learnHooks = {
    load: async (name: string) => {
      const ex = examples.find((e) => e.name === name);
      if (!ex) return false;
      let shown = true;
      if (modelRef.current?.source !== ex.source) {
        if (!replaceDoc(ex.source, name, new Map(), 'load this lesson')) return false;
        lessonWait.current?.done(false);
        shown = await new Promise<boolean>((done) => {
          lessonWait.current = { source: ex.source, done };
        });
      }
      setTab('diagram');
      return shown;
    },
    animate: () => animateRef.current(),
  };

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

  const { positions } = pinned;
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
    requestFit();
    if (!positions.size) return;
    const prev = positions;
    const prevEdited = layoutEditedRef.current;
    layoutEditedRef.current = true;
    pinned.clear();
    setNotice({
      text: 'automatic layout restored',
      undo: () => {
        // cleared flag: a save since Tidy wrote the tidy layout, so this differs from it
        layoutEditedRef.current = layoutEditedRef.current ? prevEdited : true;
        // the text may have changed since Tidy: place against the current model
        pinned.restore(modelRef.current, prev);
        setNotice(null);
        requestFit();
      },
    });
  };

  /** A node move landed: pin every node there (the first move pins the whole layout). */
  const onPin = (moved: Map<string, Point>) => {
    layoutEditedRef.current = true;
    pinned.pin(moved);
  };

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
  // the ratio as the separator reports it; updated when a drag ends, not per move
  const [split, setSplit] = useState(() => parseFloat(splitRatio));
  const panesRef = useRef<HTMLElement>(null);
  const setSplitTo = (percent: number) => {
    const v = `${Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, percent)).toFixed(1)}%`;
    panesRef.current?.style.setProperty('--split', v);
    return v;
  };
  const saveSplit = () => {
    const v = panesRef.current?.style.getPropertyValue('--split');
    if (!v) return;
    storageSet('splitRatio', v);
    setSplit(parseFloat(v));
  };
  const onSplitterDown = (down: React.PointerEvent<HTMLDivElement>) => {
    const splitter = down.currentTarget;
    splitter.setPointerCapture(down.pointerId);
    const onMove = (move: PointerEvent) => {
      const rect = panesRef.current?.getBoundingClientRect();
      if (rect) setSplitTo(((move.clientX - rect.left) / rect.width) * 100);
    };
    // a system gesture can take the pointer instead of releasing it
    const onEnd = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onEnd);
      splitter.removeEventListener('pointercancel', onEnd);
      splitter.removeEventListener('lostpointercapture', onEnd);
      saveSplit();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onEnd);
    splitter.addEventListener('pointercancel', onEnd);
    splitter.addEventListener('lostpointercapture', onEnd);
  };
  const onSplitterKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -SPLIT_STEP : e.key === 'ArrowRight' ? SPLIT_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setSplitTo(split + step);
    saveSplit();
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
      // the SVG clones the diagram once its animation ends: frame it with the
      // scene on screen then, and refuse if the text changed meanwhile
      const svg = () =>
        sceneToSvg(wrap, () => {
          if (modelRef.current?.source !== model.source) return null;
          return (viewRef.current ?? modelRef.current).scene.bounds;
        });
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
      } catch (err) {
        setNotice({ text: err instanceof SourceChanged ? err.message : 'export failed' });
      } finally {
        exportingRef.current = false;
      }
    },
    [model, view, diagramTheme, onExportHs],
  );

  const onFix = () =>
    editGuarded((_, editor) => {
      if (explanation?.fix) editor.applySplices(explanation.fix.splices);
    });

  const onAddActor = () =>
    editGuarded((m, editor) => editor.applySplices(addSourceActor(m.source, m.ir).splices));

  const onDropInsert = useCallback(
    (kind: 'actor' | 'delay', edgeId: string | null, at: Point) =>
      void editGuarded((m, editor) => {
        if (edgeId) {
          const sig = m.edgeSignals.get(edgeId);
          if (!sig) return;
          const r = insertOnEdge(m.source, m.ir, sig, kind);
          addHints([[r.created[0]!, at]]);
          queueRenames(outputRenames(m.ir, r.splices));
          editor.applySplices(r.splices);
        } else if (kind === 'actor') {
          // dropped on empty canvas: a source actor, where it was dropped
          const r = addSourceActor(m.source, m.ir);
          addHints(sourceActorHints(r.created, at));
          editor.applySplices(r.splices);
        } else {
          // a floating delay has no valid text form
          setNotice({ text: 'a delay needs a signal: drop the delay chip onto an edge' });
        }
      }),
    [editGuarded, addHints, queueRenames],
  );

  // drag-to-connect: a refused connection explains itself instead of doing nothing
  const onConnect = useCallback(
    (signal: string, proc: string) =>
      void editGuarded((m, editor) => {
        const splices = addInput(m.ir, proc, signal);
        if (splices) editor.applySplices(splices);
        else
          setNotice({
            text: addInputError(m.ir, proc, signal) ?? 'connection not possible here',
          });
      }),
    [editGuarded],
  );

  /** Menu shortcut into the popover: same targets, actions inline, same staleness guard. */
  const onMenuPick = useCallback(
    (action: MenuAction) => {
      if (!menu) return;
      const target = menu.target;
      const proc = (m: typeof model) =>
        target.kind === 'node' ? m?.ir.processes.find((q) => q.name === target.name) : undefined;
      // rename / rates / function / tokens: open the popover pre-focused at the same spot
      const openPopover = (t: PopoverTarget) => {
        setMenu(null);
        setPopover({ target: t, x: menu.x, y: menu.y });
      };
      editGuarded((m, editor) => {
        switch (action) {
          case 'add-actor': {
            if (target.kind !== 'canvas') return;
            const r = addSourceActor(m.source, m.ir);
            addHints(sourceActorHints(r.created, menu.at));
            editor.applySplices(r.splices);
            setMenu(null);
            return;
          }
          case 'fit-view':
            requestFit();
            setMenu(null);
            return;
          case 'insert-actor':
          case 'insert-delay': {
            if (target.kind !== 'edge') return;
            const sig = m.edgeSignals.get(target.edgeId);
            if (!sig) return;
            const r = insertOnEdge(
              m.source,
              m.ir,
              sig,
              action === 'insert-actor' ? 'actor' : 'delay',
            );
            const mid = view && edgeMidpoint(view.scene, target.edgeId);
            if (mid) addHints([[r.created[0]!, mid]]);
            queueRenames(outputRenames(m.ir, r.splices));
            editor.applySplices(r.splices);
            setMenu(null);
            return;
          }
          case 'rename-signal':
            if (target.kind === 'edge' && m.edgeSignals.has(target.edgeId))
              openPopover({ kind: 'edge', edgeId: target.edgeId });
            return;
          case 'delete': {
            const p = proc(m);
            const splices = p && deleteProcess(m.ir, p.name);
            if (!p) setMenu(null);
            if (!splices) return;
            setMenu(null);
            queueRenames(outputRenames(m.ir, splices));
            editor.applySplices(splices);
            return;
          }
          case 'goto-definition': {
            const p = proc(m);
            if (!p) setMenu(null);
            else if (!isDelay(p) && gotoDefinition(p.function)) setMenu(null);
            return;
          }
          case 'rename':
          case 'rates':
          case 'function':
          case 'tokens': {
            const p = proc(m);
            if (p) openPopover({ kind: 'node', name: p.name });
            else setMenu(null);
            return;
          }
          default:
            return action satisfies never;
        }
      });
    },
    [menu, view, editGuarded, addHints, queueRenames, requestFit, gotoDefinition],
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
    closeOverlays();
    requestFit(); // the pane changes size
  };
  // presenting: Space plays, the arrow keys step, Esc leaves; P toggles anywhere
  // outside a text field. Captured, so a focused node does not also nudge.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
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
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  const exampleSource = useMemo(() => examples.find((e) => e.name === example)?.source, [example]);

  return (
    <div className={`app tab-${tab}${presenting ? ' presenting' : ''}`}>
      <Toolbar
        example={example}
        edited={!!source && source !== exampleSource}
        onExample={loadExample}
        showSchedule={showSchedule}
        onToggleSchedule={onToggleSchedule}
        onAddActor={onAddActor}
        onExport={(k) => void onExport(k)}
        onNew={onNew}
        onOpen={onOpen}
        onTidy={onTidy}
        onTour={() => void startTour(() => storageSet(TOUR_SEEN_KEY, '1'), tourHooks)}
        onLearn={() => void startLearn(learnHooks)}
        animating={sim.playing}
        canAnimate={!!model}
        animateBlocked={nothingToRun}
        animateWarning={schedError ? `Not schedulable: ${schedError}` : null}
        stale={pipe.stale}
        onAnimate={onAnimate}
        diagramTheme={diagramTheme}
        onDiagramTheme={setDiagramTheme}
        appTheme={appTheme}
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
              closeOverlays();
              if (t === 'diagram') requestFit(); // it measured 0x0 while hidden
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
          aria-label="Resize the editor and diagram panes"
          aria-valuenow={split}
          aria-valuemin={SPLIT_MIN}
          aria-valuemax={SPLIT_MAX}
          tabIndex={0}
          onPointerDown={onSplitterDown}
          onKeyDown={onSplitterKey}
        />
        <section
          className={`pane diagram-pane diagram-${diagramTheme}${showSchedule ? '' : ' schedule-off'}`}
          ref={paneRef}
        >
          <DiagramBoundary>
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
              onPaneClick={closeOverlays}
              onContextMenu={onContextMenu}
              onDropInsert={onDropInsert}
              onConnect={onConnect}
            />
            <ShowToggles
              flags={showFlags}
              onFlags={setShowFlags}
              unitRates={showUnitRates}
              onToggleUnitRates={() => setShowUnitRates((v) => !v)}
              style={diagramTheme}
            />
            {popover && model && (
              <EditPopover
                target={popover.target}
                x={popover.x}
                y={popover.y}
                model={model}
                facts={facts}
                editGuarded={editGuarded}
                onGoto={gotoDefinition}
                onClose={() => setPopover(null)}
                onInserted={(proc) => {
                  const mid =
                    popover.target.kind === 'edge' && view
                      ? edgeMidpoint(view.scene, popover.target.edgeId)
                      : null;
                  if (mid) addHints([[proc, mid]]);
                }}
                onRenamed={(from, to) => queueRenames([[from, to]])}
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
                Showing last valid diagram: {pipe.errorCount} error
                {pipe.errorCount === 1 ? '' : 's'}
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
                  times={times}
                  onJump={onJump}
                  sim={sim}
                  open={scheduleOpen}
                  onToggle={toggleScheduleOpen}
                />
              )}
            </div>
          </DiagramBoundary>
        </section>
      </main>
    </div>
  );
}
