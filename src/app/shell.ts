/**
 * Application shell: toolbar, split panes, splitter drag.
 * The editor and diagram mount into the panes created here.
 */

export interface Shell {
  toolbar: HTMLElement;
  editorPane: HTMLElement;
  diagramPane: HTMLElement;
}

export function createShell(root: HTMLElement): Shell {
  root.innerHTML = `
    <div class="app">
      <header class="toolbar">
        <span class="brand">ForSyDe Playground</span>
        <span class="toolbar-items"></span>
      </header>
      <main class="panes">
        <section class="pane editor-pane"></section>
        <div class="splitter" role="separator" aria-orientation="vertical"></div>
        <section class="pane diagram-pane"></section>
      </main>
    </div>
  `;

  const panes = root.querySelector('.panes') as HTMLElement;
  const splitter = root.querySelector('.splitter') as HTMLElement;
  const editorPane = root.querySelector('.editor-pane') as HTMLElement;
  const diagramPane = root.querySelector('.diagram-pane') as HTMLElement;
  const toolbar = root.querySelector('.toolbar-items') as HTMLElement;

  const saved = localStorage.getItem('splitRatio');
  if (saved) panes.style.setProperty('--split', saved);

  splitter.addEventListener('pointerdown', (down) => {
    splitter.setPointerCapture(down.pointerId);
    const onMove = (move: PointerEvent) => {
      const rect = panes.getBoundingClientRect();
      const ratio = Math.min(0.8, Math.max(0.2, (move.clientX - rect.left) / rect.width));
      panes.style.setProperty('--split', `${(ratio * 100).toFixed(1)}%`);
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      localStorage.setItem('splitRatio', panes.style.getPropertyValue('--split'));
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });

  return { toolbar, editorPane, diagramPane };
}
