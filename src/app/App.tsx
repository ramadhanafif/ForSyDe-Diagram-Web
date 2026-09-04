import { toPng } from 'html-to-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { orderDiagnostics, type Diagnostic } from '../core/ast';
import { addInput, addInputError, addSourceActor, deleteProcess, insertOnEdge } from '../core/edits';
import { isDelay, type IRSystem } from '../core/ir';
import type { ScheduleResult } from '../core/schedule';
import { Menu, menuItems, type MenuTarget } from '../diagram/ContextMenu';
import { findDefinitionOffset } from '../diagram/labels';
import { DEFAULT_FLAGS, DiagramPane, type ShowFlags } from '../diagram/DiagramPane';
import { EditPopover, type PopoverTarget } from '../diagram/Popovers';
import { EditorPane, type EditorApi } from '../editor/EditorPane';
import { examples } from './examples';
import { preferredTheme, storageGet, storageGetJson, storageSet } from './storage';
import { Toolbar } from './Toolbar';
import { startTour, TOUR_SEEN_KEY } from './tour';
import { usePipeline } from './usePipeline';

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

const initialAppTheme = (): string => storageGet('theme') ?? preferredTheme();

const initialDiagramTheme = (): 'modern' | 'lecture' =>
  storageGet('diagramTheme') === 'lecture' ? 'lecture' : 'modern';

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

  const [example, setExample] = useState(
    () => (examples.find((e) => e.name === 'SDF_example_002') ?? examples[0])?.name ?? '',
  );
  const [showUnitRates, setShowUnitRates] = useState(false);
  const [showSchedule, setShowSchedule] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [showFlags, setShowFlags] = useState<ShowFlags>(() =>
    storageGetJson('showFlags', DEFAULT_FLAGS),
  );
  const [legendOpen, setLegendOpen] = useState(false);
  useEffect(() => storageSet('showFlags', JSON.stringify(showFlags)), [showFlags]);

  // transient toast for refused gestures
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), NOTICE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const [appTheme, setAppTheme] = useState(initialAppTheme);
  const [diagramTheme, setDiagramTheme] = useState(initialDiagramTheme);
  const [fitRequest, setFitRequest] = useState(0);

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
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number } | null>(null);
  const pendingFit = useRef(false);
  const exportingRef = useRef(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appTheme);
    storageSet('theme', appTheme);
  }, [appTheme]);
  useEffect(() => storageSet('diagramTheme', diagramTheme), [diagramTheme]);

  const loadExample = useCallback(
    (name: string) => {
      const ex = examples.find((e) => e.name === name);
      if (!ex) return;
      const cur = examples.find((e) => e.name === example);
      if (cur && editorRef.current?.getDoc() !== cur.source) {
        if (!window.confirm('Discard unsaved changes and load this example?')) return;
      }
      setExample(name);
      setPopover(null);
      setMenu(null);
      pendingFit.current = true;
      editorRef.current?.setSource(ex.source);
    },
    [example],
  );

  // initial example: load into the editor once it is mounted (idempotent under StrictMode)
  useEffect(() => {
    const ex = examples.find((e) => e.name === example);
    if (ex) {
      pendingFit.current = true;
      editorRef.current?.setSource(ex.source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // first-run tour: once a valid model is on screen, never on a broken/empty first paint
  const tourStarted = useRef(false);
  useEffect(() => {
    if (tourStarted.current || storageGet(TOUR_SEEN_KEY) || !model) return;
    tourStarted.current = true;
    void startTour(() => storageSet(TOUR_SEEN_KEY, '1'));
  }, [model]);

  // consulted by the diagram after each graph update, outside render
  const consumePendingFit = useCallback(() => {
    if (!pendingFit.current) return false;
    pendingFit.current = false;
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
        setNotice('diagram is stale, try again once it updates');
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
      setNotice('export in progress');
      return;
    }
    const el = paneRef.current;
    if (!el) {
      setNotice('nothing to export yet');
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
      setNotice('export failed');
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
      .catch(() => setNotice('export failed'))
      .finally(() => {
        restore();
        exportingRef.current = false;
      });
  }, []);

  const onAddDelay = () => {
    setNotice('a delay needs a signal: drag the delay chip onto an edge');
  };

  const onAddActor = () => {
    if (!model) return;
    if (editorRef.current?.getDoc() !== model.source) {
      setNotice('diagram is stale, try again once it updates');
      return;
    }
    editorRef.current?.applySplices(addSourceActor(model.source, model.ir).splices);
  };

  const onDropInsert = useCallback(
    (kind: 'actor' | 'delay', edgeId: string | null) => {
      if (!model) return;
      if (editorRef.current?.getDoc() !== model.source) {
        setNotice('diagram is stale, try again once it updates');
        return;
      }
      if (edgeId) {
        const meta = model.dg.edgeMeta.get(edgeId);
        if (!meta) return;
        editorRef.current?.applySplices(
          insertOnEdge(model.source, model.ir, meta.sig, kind).splices,
        );
      } else if (kind === 'actor') {
        // dropped on empty canvas: a source actor; a floating delay has no valid text form
        editorRef.current?.applySplices(addSourceActor(model.source, model.ir).splices);
      }
    },
    [model],
  );

  /** Menu shortcut into the popover: same targets, actions inline, same staleness guard. */
  const onMenuPick = useCallback(
    (action: string) => {
      if (!model || !menu) return;
      if (editorRef.current?.getDoc() !== model.source) {
        setNotice('diagram is stale, try again once it updates');
        return;
      }
      const editor = editorRef.current!;
      if (menu.target.kind === 'canvas') {
        if (action === 'add-actor') {
          editor.applySplices(addSourceActor(model.source, model.ir).splices);
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
          editor.applySplices(
            insertOnEdge(model.source, model.ir, meta.sig, action === 'insert-actor' ? 'actor' : 'delay').splices,
          );
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
    [model, menu],
  );

  const onContextMenu = useCallback(
    (target: MenuTarget, cx: number, cy: number) => {
      if (target.kind === 'node' && target.name === '') return;
      setPopover(null);
      setMenu({ target, ...paneCoords(cx, cy) });
    },
    [paneCoords],
  );

  const onConnectRefused = useCallback(
    (sourceHandle: string, targetHandle: string) => {
      if (!model) return;
      const sig = handleSignal(sourceHandle);
      const proc = targetHandle.split('.')[0];
      if (!sig || !proc) return;
      setNotice(addInputError(model.ir, proc, sig) ?? 'connection not possible here');
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
        onFit={() => setFitRequest((n) => n + 1)}
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
          {notice && <div className="notice-toast">{notice}</div>}
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
