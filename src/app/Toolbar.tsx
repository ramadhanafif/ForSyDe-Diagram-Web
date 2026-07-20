import { examples } from './examples';

export interface ToolbarProps {
  example: string;
  onExample(name: string): void;
  onFit(): void;
  showSchedule: boolean;
  onToggleSchedule(): void;
  onAddActor(): void;
  diagramTheme: 'modern' | 'lecture';
  onToggleDiagramTheme(): void;
  onToggleAppTheme(): void;
}

export function Toolbar(p: ToolbarProps) {
  return (
    <header className="toolbar">
      <span className="brand">ForSyDe Playground</span>
      <span className="toolbar-items">
        <select
          title="Load example"
          value={p.example}
          onChange={(e) => p.onExample(e.target.value)}
        >
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
      </span>
    </header>
  );
}
