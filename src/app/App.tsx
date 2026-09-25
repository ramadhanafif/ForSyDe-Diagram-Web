import { toPng } from 'html-to-image';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { parseLayoutBlock, stripLayoutBlock, writeLayoutBlock, type Point } from '../core/layoutBlock';
import type { ScheduleResult } from '../core/schedule';
import { Menu, menuItems, type MenuTarget } from '../diagram/ContextMenu';
import { findDefinitionOffset } from '../diagram/labels';
import { edgeMidpoint, placeOver, renameKey, type PlacedBox } from '../diagram/placement';
import { DEFAULT_FLAGS, DiagramPane, type ShowFlags } from '../diagram/DiagramPane';
import { EditPopover, type PopoverTarget } from '../diagram/Popovers';
import { EditorPane, type EditorApi } from '../editor/EditorPane';
import { examples } from './examples';
import { BLANK_MODEL, exportFileName } from './files';
import {
  preferredTheme,
  storageGet,
  storageGetJson,
  storageGetWorkingCopy,
  storageSet,
  storageSetWorkingCopy,
  type WorkingCopy,
} from './storage';
import { Toolbar } from './Toolbar';
import { startTour, TOUR_SEEN_KEY } from './tour';
import { usePipeline, type ModelState } from './usePipeline';

type ScheduleOk = Extract<ScheduleResult, { ok: true }>;

function SchedulePanel({
  sched,
  open,
  onToggle,
}: {
  sched: ScheduleOk;
  open: boolean;
  onToggle(): void;
}) {
  if (!open) {
    const maxBuffer = Math.max(0, ...sched.buffers.map(([, size]) => size));
    return (
      <button className="schedule-chip" title="Show the full schedule" onClick={onToggle}>
        schedule: {sched.schedule.length} firings, max buffer {maxBuffer}
      </button>
    );
  }
  return (
    <div className="schedule-panel">
      <button
        className="schedule-strip"
        title="One iteration of the static schedule; click to collapse"
        onClick={onToggle}
      >
        schedule: {sched.schedule.join(' ')}
      </button>
      <div className="schedule-tables">
        <table>
          <thead>
            <tr>
              <th>actor</th>
              <th>reps</th>
            </tr>
          </thead>
          <tbody>
            {[...sched.repetitions].map(([name, q]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{q}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <thead>
            <tr>
              <th>signal</th>
              <th>buffer</th>
            </tr>
          </thead>
          <tbody>
            {sched.buffers.map(([name, size]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const FLAG_LABELS: [keyof ShowFlags, string][] = [
  ['signals', 'signal names'],
  ['rates', 'rates'],
  ['buffers', 'buffer sizes'],
  ['repetitions', 'repetitions'],
  ['constructors', 'constructors'],
  ['functions', 'functions'],
];

function Legend() {
  return (
    <div className="legend">
      <div className="legend-title">Legend</div>
      <div className="legend-row">
        <span className="legend-swatch swatch-actor" />
        <span>actor: constructor, rates, function inside</span>
      </div>
      <div className="legend-row">
        <span className="legend-swatch swatch-delay" />
        <span>delay with its initial tokens [..]</span>
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
        <span className="legend-glyph legend-buffer">buf 4</span>
        <span>buffer: maximum tokens held on the signal</span>
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

const NOTICE_TIMEOUT_MS = 5000;
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

const initialAppTheme = (): string => storageGet('theme') ?? preferredTheme();

const initialDiagramTheme = (): 'modern' | 'lecture' =>
  storageGet('diagramTheme') === 'lecture' ? 'lecture' : 'modern';

/** Elk's boxes for every node of a laid-out model, placement's input. */
function elkBoxes(model: ModelState): PlacedBox[] {
  return (model.dg.graph.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? 0,
    height: c.height ?? 0,
  }));
}

/** Place every node of `model` over `pos`; see placement's placeOver. */
function placeModel(
  model: ModelState,
  pos: Map<string, Point>,
  hints: Map<string, Point>,
  known?: Set<string>,
) {
  return placeOver(elkBoxes(model), model.ir.signals, pos, hints, known);
}

/** Hints for a source actor created at `at`: the actor there, its io pills either side. */
function sourceActorHints(created: string[], at: Point): [string, Point][] {
  const [proc, inSig, outSig] = created;
  return [
    [proc!, at],
    [inSig!, { x: at.x - IO_HINT_OFFSET, y: at.y }],
    [outSig!, { x: at.x + IO_HINT_OFFSET, y: at.y }],
  ];
}

/** Signal carried by a source handle: `proc.out.sig` or `sig.io.src`. */
function handleSignal(handle: string): string | null {
  const parts = handle.split('.');
  if (parts[1] === 'out') return parts[2] ?? null;
  if (parts[1] === 'io') return parts[0] ?? null;
  return null;
}

export function App() {
  const editorRef = useRef<EditorApi>(null);
  const paneRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState('');
  const pipe = usePipeline(source);
  const model = pipe.model;

  const [initial] = useState(initialWorkingCopy);
  const [example, setExample] = useState(initial.example);
  // node positions keyed by process or io signal name; empty means pure elk layout
  const [positions, setPositions] = useState(initial.positions);
  // the replaced document's positions, shown until its model leaves the screen,
  // so the old diagram does not re-lay out under the new document's positions
  const [heldPositions, setHeldPositions] = useState<Map<string, Point> | null>(null);
  // the model on screen, for handlers and callbacks that must not go stale;
  // updated after the diagram's effects, so a fit consults the committed model
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const [showUnitRates, setShowUnitRates] = useState(false);
  const [showSchedule, setShowSchedule] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [showFlags, setShowFlags] = useState<ShowFlags>(() =>
    storageGetJson('showFlags', DEFAULT_FLAGS),
  );
  const [legendOpen, setLegendOpen] = useState(false);
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

  // gesture points (node centers) and popover renames waiting for the model they produce
  const [hints, setHints] = useState<Map<string, Point>>(() => new Map());
  const [renames, setRenames] = useState<[string, string][]>([]);
  const queueRenames = useCallback((pairs: [string, string][]) => {
    if (pairs.length) setRenames((r) => [...r, ...pairs]);
  }, []);

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
        prevModel && !heldPositions ? new Set(elkBoxes(prevModel).map((b) => b.id)) : undefined;
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
  // `at` is the right-click point in flow coordinates, where canvas adds land
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number; at: Point } | null>(
    null,
  );
  // source whose model the next fit waits for; null when none is pending
  const pendingFit = useRef<string | null>(null);
  const exportingRef = useRef(false);

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

  const onExportHs = () => {
    const doc = editorRef.current?.getDoc() ?? '';
    // stale ids kept for editor undo are not part of the file; filter only by
    // the model of this very text, else (errors, debounce) keep every position
    const ids = new Set(model?.dg.graph.children?.map((c) => c.id));
    const saved =
      model?.source === doc ? new Map([...positions].filter(([id]) => ids.has(id))) : positions;
    const url = URL.createObjectURL(
      new Blob([writeLayoutBlock(doc, saved)], { type: 'text/x-haskell' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(doc);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url)); // after the download has started
    markSaved(doc);
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
    void startTour(() => storageSet(TOUR_SEEN_KEY, '1'));
  }, [model]);

  // consulted by the diagram after each graph update, outside render
  // only once the model for the replaced text is on screen, not on the old
  // model's nodes moving to the new positions
  const consumePendingFit = useCallback(() => {
    if (pendingFit.current === null || pendingFit.current !== modelRef.current?.source)
      return false;
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

  const isValidConnection = useCallback(
    (sourceHandle: string, targetHandle: string): boolean => {
      if (!model) return false;
      const sig = handleSignal(sourceHandle);
      const parts = targetHandle.split('.');
      if (!sig || parts[1] !== 'in' || parts[2] !== '__new') return false;
      return addInput(model.ir, parts[0]!, sig) !== null;
    },
    [model],
  );

  const onConnect = useCallback(
    (sourceHandle: string, targetHandle: string) => {
      if (!model) return;
      if (editorRef.current?.getDoc() !== model.source) {
        setNotice({ text: 'diagram is stale, try again once it updates' });
        return;
      }
      const sig = handleSignal(sourceHandle);
      const proc = targetHandle.split('.')[0];
      if (!sig || !proc) return;
      const splices = addInput(model.ir, proc, sig);
      if (splices) editorRef.current?.applySplices(splices);
    },
    [model],
  );

  // ponytail: html-to-image deep-clones SVG subtrees without inlining computed
  // paint, so ancestor-scoped fill/stroke rules arrive blank at the rasterizer
  // (black nodes); pin the live values for the snapshot, then restore.
  const onExportPng = useCallback(() => {
    if (exportingRef.current) {
      setNotice({ text: 'export in progress' });
      return;
    }
    const el = paneRef.current;
    if (!el) {
      setNotice({ text: 'nothing to export yet' });
      return;
    }
    exportingRef.current = true;
    const saved: Array<[CSSStyleDeclaration, string, string]> = [];
    const restore = () => {
      for (const [style, prop, prior] of saved) {
        if (prior) style.setProperty(prop, prior);
        else style.removeProperty(prop);
      }
    };
    try {
      const pin = (selector: string, props: string[]) => {
        el.querySelectorAll<SVGGraphicsElement>(selector).forEach((node) => {
          const computed = getComputedStyle(node);
          props.forEach((prop) => {
            saved.push([node.style, prop, node.style.getPropertyValue(prop)]);
            node.style.setProperty(prop, computed.getPropertyValue(prop));
          });
        });
      };
      pin('circle.node-shape', ['fill', 'stroke']);
      pin('.react-flow__edge-path', ['stroke']);
      pin('#fsd-arrow .arrow-head', ['fill']);
    } catch {
      restore();
      exportingRef.current = false;
      setNotice({ text: 'export failed' });
      return;
    }
    void toPng(el, {
      filter: (n) =>
        !(n instanceof Element) ||
        (!n.classList?.contains('react-flow__minimap') &&
          !n.classList?.contains('react-flow__controls') &&
          !n.classList?.contains('react-flow__attribution') &&
          !n.classList?.contains('float-controls') &&
          !n.classList?.contains('legend') &&
          !n.classList?.contains('popover') &&
          !n.classList?.contains('schedule-panel') &&
          !n.classList?.contains('schedule-chip') &&
          !n.classList?.contains('status-chip') &&
          !n.classList?.contains('sched-banner') &&
          !n.classList?.contains('notice-toast') &&
          !n.classList?.contains('empty-canvas')),
    })
      .then((url) => {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagram.png';
        a.click();
      })
      .catch(() => setNotice({ text: 'export failed' }))
      .finally(() => {
        restore();
        exportingRef.current = false;
      });
  }, []);

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
        const meta = model.dg.edgeMeta.get(edgeId);
        if (!meta) return;
        const r = insertOnEdge(model.source, model.ir, meta.sig, kind);
        setHints((h) => new Map(h).set(r.created[0]!, at));
        queueRenames(outputRenames(model.ir, r.splices));
        editorRef.current?.applySplices(r.splices);
      } else if (kind === 'actor') {
        // dropped on empty canvas: a source actor; a floating delay has no valid text form
        const r = addSourceActor(model.source, model.ir);
        setHints((h) => new Map([...h, ...sourceActorHints(r.created, at)]));
        editorRef.current?.applySplices(r.splices);
      }
    },
    [model, queueRenames],
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
        const meta = model.dg.edgeMeta.get(menu.target.edgeId);
        if (action === 'insert-actor' || action === 'insert-delay') {
          if (!meta) return;
          const kind = action === 'insert-actor' ? 'actor' : 'delay';
          const r = insertOnEdge(model.source, model.ir, meta.sig, kind);
          const mid = edgeMidpoint(model.dg.graph, menu.target.edgeId, positions);
          if (mid) setHints((h) => new Map(h).set(r.created[0]!, mid));
          queueRenames(outputRenames(model.ir, r.splices));
          editor.applySplices(r.splices);
          setMenu(null);
        } else if (action === 'rename-signal') {
          if (!meta) return;
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
          queueRenames(outputRenames(model.ir, splices));
          setMenu(null);
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
      if (action === 'rename' || action === 'rates' || action === 'function' || action === 'tokens') {
        setMenu(null);
        setPopover({ target: { kind: 'node', name: p.name }, x: menu.x, y: menu.y });
      }
    },
    [model, menu, positions, queueRenames],
  );

  const onContextMenu = useCallback(
    (target: MenuTarget, cx: number, cy: number, at: Point) => {
      if (target.kind === 'node' && target.name === '') return;
      setPopover(null);
      setMenu({ target, at, ...paneCoords(cx, cy) });
    },
    [paneCoords],
  );

  const onConnectRefused = useCallback(
    (sourceHandle: string, targetHandle: string) => {
      if (!model) return;
      const sig = handleSignal(sourceHandle);
      const proc = targetHandle.split('.')[0];
      if (!sig || !proc) return;
      setNotice({ text: addInputError(model.ir, proc, sig) ?? 'connection not possible here' });
    },
    [model],
  );

  // the rank error on a disconnected graph teaches the wrong concept
  let schedError = pipe.schedule && !pipe.schedule.ok ? pipe.schedule.message : null;
  if (schedError && pipe.schedule && !pipe.schedule.ok && pipe.schedule.kind === 'rank' && model) {
    const parts = componentCount(model.ir);
    if (parts > 1)
      schedError = `the graph has ${parts} disconnected parts; every process must be connected to the rest of the system before a schedule exists`;
  }

  return (
    <div className="app">
      <Toolbar
        example={example}
        onExample={loadExample}
        onNew={onNew}
        onOpen={onOpen}
        onExportHs={onExportHs}
        onFit={() => setFitRequest((n) => n + 1)}
        onTidy={onTidy}
        showSchedule={showSchedule}
        onToggleSchedule={() => setShowSchedule((v) => !v)}
        onAddActor={onAddActor}
        onAddDelay={onAddDelay}
        onExportPng={onExportPng}
        onTour={() => void startTour(() => storageSet(TOUR_SEEN_KEY, '1'))}
        diagramTheme={diagramTheme}
        onToggleDiagramTheme={() => setDiagramTheme((t) => (t === 'modern' ? 'lecture' : 'modern'))}
        onToggleAppTheme={() => setAppTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />
      <main
        className="panes"
        ref={panesRef}
        style={{ ['--split' as string]: splitRatio }}
      >
        <section className="pane editor-pane">
          <ErrorBar
            diagnostics={pipe.diagnostics}
            onGoto={(offset) => editorRef.current?.gotoOffset(offset)}
          />
          <EditorPane
            ref={editorRef}
            onChange={setSource}
            diagnostics={pipe.diagnostics}
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
          <DiagramPane
            dg={model?.dg ?? null}
            showUnitRates={showUnitRates}
            stale={pipe.stale}
            showFlags={showFlags}
            fitRequest={fitRequest}
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
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDropInsert={onDropInsert}
            onConnectRefused={onConnectRefused}
            flash={flash}
            positions={heldPositions ?? positions}
            onPin={(pinned) => {
              // a held diagram belongs to the replaced document: pin into its map and
              // leave the new document's positions alone until its model arrives
              layoutEditedRef.current = true;
              if (heldPositions) setHeldPositions((h) => h && new Map([...h, ...pinned]));
              else setPositions((p) => new Map([...p, ...pinned]));
            }}
          />
          <div className="float-controls">
            <span className="detail-switch" title="Toggle each annotation on the diagram">
              <span className="switch-title">show</span>
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
          </div>
          {legendOpen && <Legend />}
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
                  popover.target.kind === 'edge'
                    ? edgeMidpoint(model.dg.graph, popover.target.edgeId, positions)
                    : null;
                if (mid) setHints((h) => new Map(h).set(proc, mid));
              }}
              onRenamed={(from, to) => setRenames((r) => [...r, [from, to]])}
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
                      signalName: model.dg.edgeMeta.get(menu.target.edgeId)?.sig.name ?? '',
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
          {schedError && <div className="sched-banner">Not schedulable: {schedError}</div>}
          {notice && (
            <div className="notice-toast">
              {notice.text}
              {notice.undo && <button onClick={notice.undo}>Undo</button>}
            </div>
          )}
          {showSchedule && pipe.schedule?.ok && (
            <SchedulePanel
              sched={pipe.schedule}
              open={scheduleOpen}
              onToggle={() => setScheduleOpen((v) => !v)}
            />
          )}
        </section>
      </main>
    </div>
  );
}
