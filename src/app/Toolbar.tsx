import { examples } from './examples';

export interface ToolbarProps {
  example: string;
  onExample(name: string): void;
  onFit(): void;
  showUnitRates: boolean;
  onToggleUnitRates(): void;
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
          className={p.showUnitRates ? 'active' : ''}
          title="Also show rates equal to 1"
          onClick={p.onToggleUnitRates}
        >
          All rates
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
