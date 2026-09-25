import { useRef } from 'react';
import pkg from '../../package.json';
import { examples } from './examples';

export interface ToolbarProps {
  example: string;
  onExample(name: string): void;
  onNew(): void;
  onOpen(file: File): void;
  onExportHs(): void;
  onFit(): void;
  showSchedule: boolean;
  onToggleSchedule(): void;
  onAddActor(): void;
  onAddDelay(): void;
  onExportPng(): void;
  onTour(): void;
  diagramTheme: 'modern' | 'lecture';
  onToggleDiagramTheme(): void;
  onToggleAppTheme(): void;
}

export function Toolbar(p: ToolbarProps) {
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
        <button title="Download the source with node positions as a .hs file" onClick={p.onExportHs}>
          Export .hs
        </button>
        <select
          title="Load example"
          value={p.example}
          onChange={(e) => p.onExample(e.target.value)}
        >
          {p.example === '' && <option value="">untitled</option>}
          {examples.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.name}
            </option>
          ))}
        </select>
        <button onClick={p.onFit}>Fit</button>
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
        <button title="Download the diagram as a PNG image" onClick={p.onExportPng}>
          Export PNG
        </button>
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
