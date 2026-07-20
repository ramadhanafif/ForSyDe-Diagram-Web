import { createShell } from './app/shell';
import { setupEditUi, type ModelState } from './app/editui';
import { examples } from './app/examples';
import { runPipeline } from './app/pipeline';
import { createEditor } from './editor/editor';
import { initSvg, render } from './diagram/render';
import { setupZoom } from './diagram/interact';
import type { ElkNode } from 'elkjs/lib/elk-api';
import './diagram/theme.css';

const shell = createShell(document.getElementById('app') as HTMLElement);

// --- diagram pane ------------------------------------------------------
shell.diagramPane.innerHTML = `
  <svg class="diagram"></svg>
  <div class="status-chip" hidden></div>
  <div class="sched-banner" hidden></div>
`;
const svg = shell.diagramPane.querySelector('svg') as SVGSVGElement;
const statusChip = shell.diagramPane.querySelector('.status-chip') as HTMLElement;
const schedBanner = shell.diagramPane.querySelector('.sched-banner') as HTMLElement;
const viewportGroup = initSvg(svg);
const viewport = setupZoom(svg, viewportGroup);

let showUnitRates = false;
let lastGraph: ElkNode | null = null;
let lastModel: ModelState | null = null;
let firstRender = true;

function draw(): void {
  if (lastGraph) render(viewportGroup, lastGraph, { showUnitRates });
}

// --- toolbar -----------------------------------------------------------
const select = document.createElement('select');
select.title = 'Load example';
for (const ex of examples) {
  const opt = document.createElement('option');
  opt.value = ex.name;
  opt.textContent = ex.name;
  select.appendChild(opt);
}
select.addEventListener('change', () => {
  const ex = examples.find((e) => e.name === select.value);
  if (ex) {
    firstRender = true;
    editor.setSource(ex.source);
  }
});

const fitBtn = document.createElement('button');
fitBtn.textContent = 'Fit';
fitBtn.addEventListener('click', () => lastGraph && viewport.fit(lastGraph));

const ratesBtn = document.createElement('button');
ratesBtn.textContent = 'All rates';
ratesBtn.title = 'Also show rates equal to 1';
ratesBtn.addEventListener('click', () => {
  showUnitRates = !showUnitRates;
  ratesBtn.classList.toggle('active', showUnitRates);
  draw();
});

const addActorBtn = document.createElement('button');
addActorBtn.textContent = 'Add actor';
addActorBtn.title = 'Add an actor fed by a new system input';
addActorBtn.addEventListener('click', () => editUi.addActor());

const themeBtn = document.createElement('button');
themeBtn.textContent = 'Theme';
const applyTheme = (t: string) => document.documentElement.setAttribute('data-theme', t);
let theme =
  localStorage.getItem('theme') ??
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  applyTheme(theme);
});

shell.toolbar.append(select, fitBtn, ratesBtn, addActorBtn, themeBtn);

// --- pipeline loop -----------------------------------------------------
let debounce: ReturnType<typeof setTimeout> | undefined;

async function update(source: string): Promise<void> {
  const result = await runPipeline(source);
  if (result === 'stale') return;
  editor.setDiagnostics(result.diagnostics);

  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  if (result.graph) {
    lastGraph = result.graph;
    lastModel = result.ir ? { ir: result.ir, graph: result.graph, source } : null;
    svg.classList.remove('stale');
    statusChip.hidden = true;
    draw();
    if (firstRender) {
      viewport.fit(result.graph);
      firstRender = false;
    }
  } else {
    svg.classList.add('stale');
    statusChip.hidden = false;
    statusChip.textContent = `Showing last valid diagram: ${errors} error${errors === 1 ? '' : 's'}`;
  }

  if (result.schedule && !result.schedule.ok) {
    schedBanner.hidden = false;
    schedBanner.textContent = `Not schedulable: ${result.schedule.message}`;
  } else {
    schedBanner.hidden = true;
  }
}

const editor = createEditor(shell.editorPane, (source) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void update(source), 250);
});

const editUi = setupEditUi({
  svg,
  pane: shell.diagramPane,
  view: editor.view,
  current: () => lastModel,
});

const initial = examples.find((e) => e.name === 'SDF_example_002') ?? examples[0];
if (initial) {
  select.value = initial.name;
  editor.setSource(initial.source);
}
