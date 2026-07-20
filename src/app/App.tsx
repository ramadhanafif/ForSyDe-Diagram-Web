import { useCallback, useEffect, useRef, useState } from 'react';
import { addInput, addSourceActor, insertOnEdge } from '../core/edits';
import type { ScheduleResult } from '../core/schedule';
import { DiagramPane } from '../diagram/DiagramPane';
import { EditPopover, type PopoverTarget } from '../diagram/Popovers';
import { EditorPane, type EditorApi } from '../editor/EditorPane';
import { examples } from './examples';
import { Toolbar } from './Toolbar';
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

const initialAppTheme = (): string =>
  localStorage.getItem('theme') ??
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const initialDiagramTheme = (): 'modern' | 'lecture' =>
  localStorage.getItem('diagramTheme') === 'lecture' ? 'lecture' : 'modern';

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
  const [appTheme, setAppTheme] = useState(initialAppTheme);
  const [diagramTheme, setDiagramTheme] = useState(initialDiagramTheme);
  const [fitRequest, setFitRequest] = useState(0);
  const [popover, setPopover] = useState<{ target: PopoverTarget; x: number; y: number } | null>(
    null,
  );
  const pendingFit = useRef(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appTheme);
    localStorage.setItem('theme', appTheme);
  }, [appTheme]);
  useEffect(() => localStorage.setItem('diagramTheme', diagramTheme), [diagramTheme]);

  const loadExample = useCallback((name: string) => {
    const ex = examples.find((e) => e.name === name);
    if (!ex) return;
    setExample(name);
    setPopover(null);
    pendingFit.current = true;
    editorRef.current?.setSource(ex.source);
  }, []);

  // initial example: load into the editor once it is mounted (idempotent under StrictMode)
  useEffect(() => {
    const ex = examples.find((e) => e.name === example);
    if (ex) {
      pendingFit.current = true;
      editorRef.current?.setSource(ex.source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // consulted by the diagram after each graph update, outside render
  const consumePendingFit = useCallback(() => {
    if (!pendingFit.current) return false;
    pendingFit.current = false;
    return true;
  }, []);

  // splitter drag
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
      if (v) localStorage.setItem('splitRatio', v);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  };

  const paneCoords = (clientX: number, clientY: number) => {
    const rect = paneRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const isValidConnection = useCallback(
    (sourceHandle: string, targetHandle: string): boolean => {
      if (!model) return false;
      const sig = handleSignal(sourceHandle);
      const parts = targetHandle.split('.');
      if (!sig || parts[1] !== 'in' || parts[2] !== '__new') return false;
      return addInput(model.source, model.ir, parts[0]!, sig) !== null;
    },
    [model],
  );

  const onConnect = useCallback(
    (sourceHandle: string, targetHandle: string) => {
      if (!model || editorRef.current?.getDoc() !== model.source) return;
      const sig = handleSignal(sourceHandle);
      const proc = targetHandle.split('.')[0];
      if (!sig || !proc) return;
      const splices = addInput(model.source, model.ir, proc, sig);
      if (splices) editorRef.current?.applySplices(splices);
    },
    [model],
  );

  const onAddActor = () => {
    if (!model || editorRef.current?.getDoc() !== model.source) return;
    editorRef.current?.applySplices(addSourceActor(model.source, model.ir).splices);
  };

  const onDropInsert = useCallback(
    (kind: 'actor' | 'delay', edgeId: string | null) => {
      if (!model || editorRef.current?.getDoc() !== model.source) return;
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

  const schedError = pipe.schedule && !pipe.schedule.ok ? pipe.schedule.message : null;

  return (
    <div className="app">
      <Toolbar
        example={example}
        onExample={loadExample}
        onFit={() => setFitRequest((n) => n + 1)}
        showUnitRates={showUnitRates}
        onToggleUnitRates={() => setShowUnitRates((v) => !v)}
        showSchedule={showSchedule}
        onToggleSchedule={() => setShowSchedule((v) => !v)}
        onAddActor={onAddActor}
        diagramTheme={diagramTheme}
        onToggleDiagramTheme={() => setDiagramTheme((t) => (t === 'modern' ? 'lecture' : 'modern'))}
        onToggleAppTheme={() => setAppTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />
      <main
        className="panes"
        ref={panesRef}
        style={{ ['--split' as string]: localStorage.getItem('splitRatio') ?? '45%' }}
      >
        <section className="pane editor-pane">
          <EditorPane ref={editorRef} onChange={setSource} diagnostics={pipe.diagnostics} />
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
            fitRequest={fitRequest}
            consumePendingFit={consumePendingFit}
            onNodeClick={(id, cx, cy) => {
              if (!model?.ir.processes.some((q) => q.name === id)) return;
              setPopover({ target: { kind: 'node', name: id }, ...paneCoords(cx, cy) });
            }}
            onEdgeClick={(edgeId, cx, cy) =>
              setPopover({ target: { kind: 'edge', edgeId }, ...paneCoords(cx, cy) })
            }
            onPaneClick={() => setPopover(null)}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDropInsert={onDropInsert}
          />
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
          {pipe.stale && model && (
            <div className="status-chip">
              Showing last valid diagram: {pipe.errorCount} error{pipe.errorCount === 1 ? '' : 's'}
            </div>
          )}
          {schedError && <div className="sched-banner">Not schedulable: {schedError}</div>}
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
