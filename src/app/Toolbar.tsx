import { useRef, useState } from 'react';
import pkg from '../../package.json';
import { examples } from './examples';

export type ExportKind = 'hs' | 'png' | 'svg' | 'tikz' | 'copy-tikz';

const EXPORTS: [ExportKind, string, string][] = [
  ['hs', 'Haskell (.hs)', 'Download the source with the node positions, as a .hs file'],
  ['png', 'PNG image', 'Download the diagram as a PNG image (2x)'],
  ['svg', 'SVG', 'Download the diagram as a standalone SVG, for Inkscape or the web'],
  ['tikz', 'TikZ (.tex)', 'Download a standalone LaTeX document drawing the diagram in TikZ'],
  ['copy-tikz', 'Copy TikZ', 'Copy only the tikzpicture, to paste into your own document'],
];

export interface ToolbarProps {
  example: string;
  onExample(name: string): void;
  onFit(): void;
  showSchedule: boolean;
  onToggleSchedule(): void;
  onAddActor(): void;
  onAddDelay(): void;
  onExport(kind: ExportKind): void;
  onNew(): void;
  onOpen(file: File): void;
  /** Back to the automatic layout, dropping the dragged node positions. */
  onTidy(): void;
  onTour(): void;
  /** The simulation is playing. */
  animating: boolean;
  /** A model is on screen; Animate explains itself when it has nothing to play. */
  canAnimate: boolean;
  /** Why there is nothing to play (no schedule, errors); null when there is. */
  animateBlocked?: string | null;
  onAnimate(): void;
  diagramTheme: 'modern' | 'lecture';
  onToggleDiagramTheme(): void;
  onToggleAppTheme(): void;
}

export function Toolbar(p: ToolbarProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <header className="toolbar">
      <span className="brand">ForSyDe Playground</span>
      <span className="version" title="App version">
        v{pkg.version}
      </span>
      <span className="toolbar-items">
        <button title="Start a blank model" onClick={p.onNew}>
          New
        </button>
        <button title="Open a .hs file" onClick={() => fileRef.current?.click()}>
          Open .hs
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".hs"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // reopening the same file must fire change again
            if (file) p.onOpen(file);
          }}
        />
        <select
          title="Load example"
          value={p.example}
          onChange={(e) => p.onExample(e.target.value)}
        >
          {p.example === '' && <option value="">untitled</option>}
          {(['Lessons', 'Test fixtures'] as const).map((group) => (
            <optgroup key={group} label={group}>
              {examples
                .filter((ex) => ex.group === group)
                .map((ex) => (
                  <option key={ex.name} value={ex.name}>
                    {ex.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button onClick={p.onFit}>Fit</button>
        <button
          title="Re-run the automatic layout, discarding dragged node positions"
          onClick={p.onTidy}
        >
          Tidy
        </button>
        <button
          className={`animate-button${p.animating ? ' active' : ''}`}
          aria-pressed={p.animating}
          disabled={!p.canAnimate}
          title={
            p.animateBlocked ??
            (p.canAnimate
              ? 'Run the model: inputs produce tokens, they travel through the buffers and the actors fire'
              : 'Nothing to run: fix the errors or connect the model first')
          }
          onClick={p.onAnimate}
        >
          {p.animating ? '■ Stop' : '▶ Animate'}
        </button>
        <button
          className={p.showSchedule ? 'active' : ''}
          title="Show or hide the schedule results: firing order, repetitions and buffer sizes"
          onClick={p.onToggleSchedule}
        >
          Schedule
        </button>
        <button title="Add an actor fed by a new system input" onClick={p.onAddActor}>
          Add actor
        </button>
        <button
          title="A delay lives on a signal, so it must be dropped onto an edge"
          onClick={p.onAddDelay}
        >
          Add delay
        </button>
        <details
          className="export-menu"
          open={exportOpen}
          onToggle={(e) => setExportOpen(e.currentTarget.open)}
        >
          <summary title="Save the diagram as an image or as LaTeX">Export</summary>
          {/* only while open: a closed menu must not answer queries for [role=menu] */}
          {exportOpen && (
            <div role="menu">
              {EXPORTS.map(([kind, label, title]) => (
                <button
                  key={kind}
                  role="menuitem"
                  data-export={kind}
                  title={title}
                  onClick={() => {
                    setExportOpen(false);
                    p.onExport(kind);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </details>
        <span className="palette" title="Drag onto an edge to insert it there">
          <span
            className="chip"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/forsyde-node', 'actor')}
          >
            actor
          </span>
          <span
            className="chip"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/forsyde-node', 'delay')}
          >
            delay
          </span>
        </span>
        <button
          title="Switch between modern and lecture-notes diagram styles"
          onClick={p.onToggleDiagramTheme}
        >
          {p.diagramTheme === 'modern' ? 'Lecture style' : 'Modern style'}
        </button>
        <button onClick={p.onToggleAppTheme}>Theme</button>
        <button
          className="tour-replay"
          title="Replay the guided tour of the interface"
          onClick={p.onTour}
        >
          Tour
        </button>
      </span>
    </header>
  );
}
