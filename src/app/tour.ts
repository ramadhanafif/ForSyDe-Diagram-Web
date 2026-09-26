/** First-run guided tour, built on driver.js v1. Missing anchors are skipped. */

import { motionOn } from '../render/animate';

export const TOUR_SEEN_KEY = 'tourSeen';

export interface TourHooks {
  /** Start the simulation playing, so the Animate step shows it running. */
  animate?(): void;
}

const stepsFor = (hooks: TourHooks) => [
  {
    element: '.editor-pane',
    popover: {
      title: 'Editor',
      description: 'Write your ForSyDe model here; the diagram updates as you type.',
    },
  },
  {
    element: '.diagram-wrap',
    popover: {
      title: 'Diagram',
      description: 'The dataflow graph lays out automatically; drag nodes to rearrange.',
    },
  },
  {
    element: '.toolbar .palette',
    popover: {
      title: 'Palette',
      description: 'Drag an actor or delay chip onto an edge to insert it into the model.',
    },
  },
  {
    element: '.detail-switch',
    popover: {
      title: 'Show',
      description: 'Toggle signal names, rates, buffers, and other annotations here.',
    },
  },
  {
    element: '.animate-button',
    popover: {
      title: 'Animate',
      description:
        'Watch the model run: the inputs produce tokens, the tokens travel along the edges into the FIFO buffers, and each actor takes its tokens out of its buffers when it fires. A model that deadlocks plays until it gets stuck.',
    },
    // play it right away, behind the popover, so the tokens are already moving
    onHighlighted: () => hooks.animate?.(),
  },
  {
    element: '.schedule-chip, .timeline',
    popover: {
      title: 'Schedule',
      description:
        'The static schedule as a playable timeline: step through one period and watch the buffers fill and drain. "tables" lists repetitions and buffer sizes.',
    },
  },
];

let driving = false;

/** Start the tour; resolves when it is dismissed. Dynamic imports keep the css out of tests. */
export async function startTour(onDone?: () => void, hooks: TourHooks = {}): Promise<void> {
  const steps = stepsFor(hooks);
  if (driving) return;
  driving = true;
  try {
    const { driver } = await import('driver.js');
    await import('driver.js/dist/driver.css');
    await new Promise<void>((resolve) => {
      driver({
        steps,
        showProgress: true,
        animate: motionOn(),
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
