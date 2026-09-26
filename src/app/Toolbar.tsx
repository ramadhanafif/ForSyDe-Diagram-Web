import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  ChevronDown,
  CircleHelp,
  Code,
  Compass,
  Copy,
  Download,
  Ellipsis,
  FileCode,
  FilePlus,
  FileText,
  FolderOpen,
  GraduationCap,
  Hourglass,
  Image,
  LayoutGrid,
  Moon,
  Pause,
  Play,
  Plus,
  Presentation,
  Shapes,
  Square,
  SquareCheck,
  Sun,
  TriangleAlert,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import pkg from '../../package.json';
import { examples } from './examples';

export type ExportKind = 'hs' | 'png' | 'svg' | 'tikz' | 'copy-tikz';

const REPO = 'https://github.com/ramadhanafif/ForSyDe-Diagram-Web';
const FORSYDE = 'https://forsyde.github.io/';

const EXPORTS: [ExportKind, string, string, LucideIcon][] = [
  ['hs', 'Haskell (.hs)', 'Download the source with the node positions, as a .hs file', FileCode],
  ['png', 'PNG image', 'Download the diagram as a PNG image (2x)', Image],
  ['svg', 'SVG', 'Download the diagram as a standalone SVG, for Inkscape or the web', Shapes],
  [
    'tikz',
    'TikZ (.tex)',
    'Download a standalone LaTeX document drawing the diagram in TikZ',
    FileText,
  ],
  ['copy-tikz', 'Copy TikZ', 'Copy only the tikzpicture, to paste into your own document', Copy],
];

const SHORTCUTS: [string, string][] = [
  ['P', 'present, or leave it'],
  ['Space', 'play or pause (presenting)'],
  ['← →', 'step (presenting)'],
  ['Esc', 'leave present, close a menu'],
  ['Ctrl-Space', 'complete a name in the editor'],
];

export interface ToolbarProps {
  example: string;
  /** The text differs from the example it was loaded from. */
  edited: boolean;
  onExample(name: string): void;
  showSchedule: boolean;
  onToggleSchedule(): void;
  onAddActor(): void;
  onExport(kind: ExportKind): void;
  onNew(): void;
  onOpen(file: File): void;
  /** Back to the automatic layout, dropping the dragged node positions. */
  onTidy(): void;
  onTour(): void;
  onLearn(): void;
  /** The simulation is playing. */
  animating: boolean;
  /** A model is on screen; Animate explains itself when it has nothing to play. */
  canAnimate: boolean;
  /** Why there is nothing to play (no schedule, errors); null when there is. */
  animateBlocked?: string | null;
  /** The model plays but has no schedule: it runs until it gets stuck. */
  animateWarning?: string | null;
  /** The text has errors and the diagram is the last valid one. */
  stale: boolean;
  onAnimate(): void;
  diagramTheme: 'modern' | 'lecture';
  onDiagramTheme(t: 'modern' | 'lecture'): void;
  appTheme: 'light' | 'dark';
  onToggleAppTheme(): void;
  presenting: boolean;
  onPresent(): void;
}

/**
 * A disclosure that behaves as a menu: focus on the first item when it opens,
 * arrows move between items, Esc and a click outside close it, a picked item
 * closes it. Its items render only while open.
 */
function Menu(p: {
  className: string;
  summary: ReactNode;
  title: string;
  label?: string;
  /** 'menu' when every item is an action; the help panel also holds text and links. */
  role?: 'menu';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    // skip what this width hides (the help menu's phone and fold sections)
    const items = () =>
      [...el.querySelectorAll<HTMLElement>('.menu-panel button, .menu-panel a')].filter(
        (i) => i.getClientRects().length,
      );
    items()[0]?.focus();
    const close = () => {
      setOpen(false);
      el.querySelector('summary')?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const all = items();
        const i = all.indexOf(document.activeElement as HTMLElement);
        const d = e.key === 'ArrowDown' ? 1 : -1;
        all[(i + d + all.length) % all.length]?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('pointerdown', onDown);
    el.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <details
      ref={ref}
      className={`menu ${p.className}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary title={p.title} aria-label={p.label}>
        {p.summary}
      </summary>
      {/* only while open: a closed menu must not answer queries for its items */}
      {open && (
        <div
          className="menu-panel"
          role={p.role}
          onClick={(e) => {
            if ((e.target as Element).closest('button, a')) setOpen(false);
          }}
        >
          {p.children}
        </div>
      )}
    </details>
  );
}

/** Icon size in the toolbar and its menus, px. */
const ICON = 15;
const Caret = () => <ChevronDown className="caret" size={13} />;

export function Toolbar(p: ToolbarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const openFile = () => fileRef.current?.click();
  const exportItems = (role: 'menuitem' | undefined) =>
    EXPORTS.map(([kind, label, title, Icon]) => (
      <button
        key={kind}
        role={role}
        data-export={role ? kind : undefined}
        title={title}
        onClick={() => p.onExport(kind)}
      >
        <Icon size={ICON} />
        {role || kind === 'copy-tikz' ? label : `Export ${label}`}
      </button>
    ));
  const styleSwitch = (
    <span className="seg keep fold" role="radiogroup" aria-label="Diagram style">
      {(['modern', 'lecture'] as const).map((t) => (
        <button
          key={t}
          role="radio"
          aria-checked={p.diagramTheme === t}
          title={
            t === 'modern'
              ? 'Modern diagram style: coloured shapes'
              : 'Lecture-notes diagram style: the ForSyDe TikZ figures'
          }
          onClick={() => p.onDiagramTheme(t)}
        >
          {t === 'modern' ? 'Modern' : 'Lecture'}
        </button>
      ))}
    </span>
  );
  const dark = p.appTheme === 'dark';
  const blocked = p.canAnimate && !!(p.animateBlocked || p.animateWarning);
  return (
    <header className="toolbar">
      <a
        className="brand"
        href={REPO}
        target="_blank"
        rel="noreferrer"
        title="Source on GitHub"
        aria-label="ForSyDe Playground, source on GitHub"
      >
        <Workflow className="brand-mark" size={17} />
        <span className="brand-name">ForSyDe Playground</span>
      </a>
      <a
        className="version"
        href={`${REPO}/releases/tag/v${pkg.version}`}
        target="_blank"
        rel="noreferrer"
        title="What changed in this version"
      >
        v{pkg.version}
      </a>
      <span className="toolbar-items">
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
          className="keep row"
          title="Load a lesson or an example"
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
                    {p.edited && ex.name === p.example ? ' (edited)' : ''}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <Menu
          className="file-menu"
          summary={
            <>
              File
              <Caret />
            </>
          }
          title="Start a blank model or open a .hs file"
          role="menu"
        >
          <button role="menuitem" title="Start a blank model" onClick={p.onNew}>
            <FilePlus size={ICON} />
            New
          </button>
          <button role="menuitem" title="Open a .hs file" onClick={openFile}>
            <FolderOpen size={ICON} />
            Open .hs…
          </button>
        </Menu>
        <span className="sep" />
        <button
          className={`animate-button keep row${blocked ? ' blocked' : ''}`}
          disabled={!p.canAnimate}
          title={
            p.animateBlocked ??
            (p.animateWarning
              ? `${p.animateWarning}. Animate plays until the model gets stuck.`
              : !p.canAnimate
                ? 'Nothing to run: fix the errors or connect the model first'
                : p.stale
                  ? 'Run the last valid model: the text has errors'
                  : 'Run the model: inputs produce tokens, they travel through the buffers and the actors fire (Space when presenting)')
          }
          onClick={p.onAnimate}
        >
          {p.animating ? (
            <>
              <Pause size={ICON} fill="currentColor" />
              Pause
            </>
          ) : (
            <>
              {blocked ? <TriangleAlert size={ICON} /> : <Play size={ICON} fill="currentColor" />}
              Animate
            </>
          )}
        </button>
        <button
          className="toggle"
          aria-pressed={p.showSchedule}
          title="Show or hide the schedule results: firing order, repetitions and buffer sizes"
          onClick={p.onToggleSchedule}
        >
          {p.showSchedule ? <SquareCheck size={ICON} /> : <Square size={ICON} />}
          Schedule
        </button>
        <span className="sep" />
        <span className="palette">
          <span
            className="chip chip-actor"
            role="button"
            tabIndex={0}
            draggable
            title="Click to add an actor fed by a new input; drag onto an edge to insert it there"
            onClick={p.onAddActor}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              p.onAddActor();
            }}
            onDragStart={(e) => e.dataTransfer.setData('application/forsyde-node', 'actor')}
          >
            <Plus size={ICON} />
            actor
          </span>
          <span
            className="chip chip-delay"
            draggable
            title="Drag onto an edge to delay that signal (mouse only)"
            onDragStart={(e) => e.dataTransfer.setData('application/forsyde-node', 'delay')}
          >
            <Hourglass size={ICON} />
            delay
          </span>
        </span>
        <button
          className="fold"
          title="Re-run the automatic layout, discarding dragged node positions"
          onClick={p.onTidy}
        >
          <LayoutGrid size={ICON} />
          Tidy
        </button>
        <span className="spacer" />
        <Menu
          className="export-menu"
          summary={
            <>
              <Download size={ICON} />
              Export
              <Caret />
            </>
          }
          title="Save the diagram as an image or as LaTeX"
          role="menu"
        >
          {exportItems('menuitem')}
        </Menu>
        <span className="sep fold" />
        {styleSwitch}
        <button
          className="theme-button keep fold"
          aria-pressed={dark}
          aria-label="Dark theme"
          title={dark ? 'Dark theme: click for light' : 'Light theme: click for dark'}
          onClick={p.onToggleAppTheme}
        >
          {dark ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <span className="sep" />
        <button
          className={`present-button keep${p.presenting ? ' active' : ''}`}
          title={
            p.presenting
              ? 'Back to the editor (Esc)'
              : 'Present: the diagram fills the screen; Space plays, arrow keys step (P)'
          }
          onClick={p.onPresent}
        >
          {p.presenting ? <X size={ICON} /> : <Presentation size={ICON} />}
          {p.presenting ? 'Exit present' : 'Present'}
        </button>
        <button
          className="learn"
          title="Learn SDF on the lessons: rates, repetitions, buffers, the topology matrix, deadlock"
          onClick={p.onLearn}
        >
          <GraduationCap size={ICON} />
          Learn SDF
        </button>
        <Menu
          className="more-menu row"
          summary={
            <>
              <CircleHelp className="more-help" size={16} />
              <Ellipsis className="more-dots" size={16} />
            </>
          }
          label="More and help"
          title="Help, shortcuts and more"
        >
          <div className="m-compact">
            <button onClick={p.onLearn}>
              <GraduationCap size={ICON} />
              Learn SDF
            </button>
            <button onClick={p.onPresent}>
              <Presentation size={ICON} />
              Present
            </button>
            <button aria-pressed={p.showSchedule} onClick={p.onToggleSchedule}>
              {p.showSchedule ? <SquareCheck size={ICON} /> : <Square size={ICON} />}
              Schedule
            </button>
            <button onClick={p.onAddActor}>
              <Plus size={ICON} />
              Add actor
            </button>
            <button onClick={p.onNew}>
              <FilePlus size={ICON} />
              New model
            </button>
            <button onClick={openFile}>
              <FolderOpen size={ICON} />
              Open .hs…
            </button>
            {exportItems(undefined)}
          </div>
          <div className="m-fold">
            <button onClick={p.onTidy}>
              <LayoutGrid size={ICON} />
              Tidy layout
            </button>
            <span className="m-label">Style</span>
            {styleSwitch}
            <button aria-pressed={dark} onClick={p.onToggleAppTheme}>
              <Moon size={ICON} />
              Dark theme
            </button>
          </div>
          <button
            className="tour-replay"
            title="Replay the guided tour of the interface"
            onClick={p.onTour}
          >
            <Compass size={ICON} />
            Tour
          </button>
          <span className="m-label m-keys">Keyboard</span>
          <dl className="shortcuts">
            {SHORTCUTS.map(([k, what]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <a href={FORSYDE} target="_blank" rel="noreferrer">
            <BookOpen size={ICON} />
            About ForSyDe
          </a>
          <a href={REPO} target="_blank" rel="noreferrer">
            <Code size={ICON} />
            Source and issues
          </a>
        </Menu>
      </span>
    </header>
  );
}
