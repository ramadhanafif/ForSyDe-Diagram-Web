/** First-run guided tour, built on driver.js v1. Missing anchors are skipped. */

import { motionOn } from '../render/animate';

export const TOUR_SEEN_KEY = 'tourSeen';

export interface TourHooks {
  /** Start the simulation playing, so the Animate step shows it running. */
  animate?(): void;
  /** Phones show one pane at a time: bring the step's pane on screen. */
  tab?(tab: 'code' | 'diagram'): void;
  /** A phone: skip what a finger cannot do (drag the palette chips). */
  compact?: boolean;
}

const stepsFor = (hooks: TourHooks) =>
  [
    {
      element: '.editor-pane',
      popover: {
        title: 'Editor',
        description: 'Write your ForSyDe model here; the diagram updates as you type.',
      },
      onHighlightStarted: () => hooks.tab?.('code'),
    },
    {
      element: '.diagram-wrap',
      popover: {
        title: 'Diagram',
        description: 'The dataflow graph lays out automatically; drag nodes to rearrange.',
      },
      onHighlightStarted: () => hooks.tab?.('diagram'),
    },
    hooks.compact
      ? null
      : {
          element: '.toolbar .palette',
          popover: {
            title: 'Palette',
            description:
              'Click the actor chip to add an actor, or drag a chip onto an edge to insert it there.',
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
      // play it right away, with the overlay lifted, so the tokens are seen moving
      onHighlighted: () => {
        lift(true);
        hooks.animate?.();
      },
      onDeselected: () => lift(false),
    },
    {
      element: '.schedule-chip, .timeline',
      popover: {
        title: 'Schedule',
        description:
          'The static schedule as a playable timeline: step through one iteration and watch the buffers fill and drain. "analysis" shows the topology matrix, the balance equations and the repetition vector.',
      },
    },
  ].filter((s) => s !== null);

/** A lighter overlay while tokens move, so they are not dimmed behind it. */
const lift = (on: boolean) => document.body.classList.toggle('tour-lift', on);

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

export interface LearnHooks {
  /** Load a lesson; false when the user kept their unsaved text instead. */
  load(name: string): Promise<boolean>;
  animate(): void;
}

interface LearnStep {
  load?: string;
  before?(): void;
  element: string;
  title: string;
  description: string;
  lifted?: boolean;
}

/** SDF itself, taught on the lessons: rates, repetitions, buffers, Γ, deadlock, inconsistency. */
const LEARN: LearnStep[] = [
  {
    load: '02_multirate_chain',
    element: '[data-edge-id="e_s_1_a_up_a_down"]',
    title: 'Rates',
    description:
      'The number at each end of an edge is a rate: a_up writes 2 tokens onto s_1 every time it fires, and a_down reads 3. A rate of 1 is drawn faint.',
  },
  {
    element: '[data-label-id="a_up#badge"]',
    title: 'Repetitions',
    description:
      'Over one iteration s_1 must end as it started, so 2·q(a_up) = 3·q(a_down). The smallest whole solution is q(a_up) = 3 and q(a_down) = 2: the ×3 and ×2 badges.',
  },
  {
    element: '.diagram-wrap',
    title: 'Buffers',
    description:
      'One iteration plays now: the inputs produce, a_up fires 3 times and a_down twice. The strip on s_1 has one slot per token it ever holds under this schedule.',
    lifted: true,
  },
  {
    before: () =>
      document
        .querySelector<HTMLButtonElement>(
          '.timeline button[aria-pressed="false"][title^="Topology"]',
        )
        ?.click(),
    element: '.analysis',
    title: 'The same in matrix form',
    description:
      'The topology matrix Γ has a row per channel: + tokens written, − tokens read. For a connected graph the rates are consistent when rank Γ = actors − 1, and q solves Γ·q = 0.',
  },
  {
    load: '05_deadlock',
    element: '.sched-banner',
    title: 'Deadlock',
    description:
      'A loop with no token on it: a_acc waits for a_back and a_back waits for a_acc. The button inserts a delay with one initial token, and the model gets a schedule.',
  },
  {
    load: '06_inconsistent_rates',
    element: '.sched-banner',
    title: 'Inconsistent rates',
    description:
      'The two paths from a_split to a_join ask for different firing ratios. No buffer is ever big enough: tokens pile up on s_3. Change one rate on the paths to fix it.',
  },
];

/** Resolves once `selector` is on screen, or after `ms`. */
async function present(selector: string, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (document.querySelector(selector)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Walk the lessons; each step loads what it points at before the popover moves there. */
export async function startLearn(hooks: LearnHooks): Promise<void> {
  if (driving) return;
  driving = true;
  try {
    const prepare = async (s: LearnStep) => {
      if (s.load && !(await hooks.load(s.load))) return false;
      if (s.lifted) hooks.animate();
      s.before?.();
      await present(s.element);
      return true;
    };
    if (!(await prepare(LEARN[0]!))) return;
    const { driver } = await import('driver.js');
    await import('driver.js/dist/driver.css');
    await new Promise<void>((resolve) => {
      const d = driver({
        showProgress: true,
        showButtons: ['next', 'close'],
        animate: motionOn(),
        steps: LEARN.map((s, i) => ({
          element: s.element,
          onHighlighted: () => lift(!!s.lifted),
          popover: {
            title: s.title,
            description: s.description,
            onNextClick: () => {
              const next = LEARN[i + 1];
              if (!next) return d.destroy();
              void prepare(next).then((ok) => (ok ? d.moveNext() : d.destroy()));
            },
          },
        })),
        onDestroyed: () => {
          lift(false);
          resolve();
        },
      });
      d.drive();
    });
  } finally {
    driving = false;
  }
}
