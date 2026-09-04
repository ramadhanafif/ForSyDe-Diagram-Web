/** First-run guided tour, built on driver.js v1. Missing anchors are skipped. */

export const TOUR_SEEN_KEY = 'tourSeen';

const steps = [
  {
    element: '.editor-pane',
    popover: { title: 'Editor', description: 'Write your ForSyDe model here; the diagram updates as you type.' },
  },
  {
    element: '.diagram-wrap',
    popover: { title: 'Diagram', description: 'The dataflow graph lays out automatically; drag nodes to rearrange.' },
  },
  {
    element: '.toolbar .palette',
    popover: { title: 'Palette', description: 'Drag an actor or delay chip onto an edge to insert it into the model.' },
  },
  {
    element: '.detail-switch',
    popover: { title: 'Show', description: 'Toggle signal names, rates, buffers, and other annotations here.' },
  },
  {
    element: '.schedule-chip, .schedule-strip',
    popover: { title: 'Schedule', description: 'The static schedule: firing order, repetitions, and buffer sizes.' },
  },
];

let driving = false;

/** Start the tour; resolves when it is dismissed. Dynamic imports keep the css out of tests. */
export async function startTour(onDone?: () => void): Promise<void> {
  if (driving) return;
  driving = true;
  try {
    const { driver } = await import('driver.js');
    await import('driver.js/dist/driver.css');
    await new Promise<void>((resolve) => {
      driver({
        steps,
        showProgress: true,
        skipMissingElement: true,
        onDestroyed: () => {
          onDone?.();
          resolve();
        },
      }).drive();
    });
  } finally {
    driving = false;
  }
}
