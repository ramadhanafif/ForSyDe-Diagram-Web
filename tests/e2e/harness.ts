import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { SHOT_DIR } from './util.mjs';

/**
 * The page the scenarios in scenarios.mjs are written against, on top of a
 * Playwright page. The scenarios predate Playwright (they drove Chromium over
 * raw CDP); keeping their small interface keeps them unchanged, and every
 * method here is plain Playwright, so it works on a local browser and over a
 * remote connection alike.
 */

type Pt = { x: number; y: number };
type Button = 'left' | 'right' | 'middle';

/** CDP modifier bits, as the scenarios pass them. */
const MODIFIERS: [number, string][] = [
  [1, 'Alt'],
  [2, 'Control'],
  [4, 'Meta'],
  [8, 'Shift'],
];

export function harness(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    // the app ships no favicon; the browser's own request for one is not an app error
    if (['error', 'assert'].includes(m.type()) && !m.location().url.endsWith('/favicon.ico'))
      errors.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`exception: ${e.message}`));
  // loadExample asks window.confirm before discarding edits: always accept
  page.on('dialog', (d) => void d.accept().catch(() => {}));

  const h = {
    errors,

    async goto(url: string) {
      await page.goto(url);
    },

    /** Evaluate a function (with arguments) or an expression string in the page. */
    async eval(fn: ((...a: never[]) => unknown) | string, ...args: unknown[]): Promise<unknown> {
      if (typeof fn === 'string') return page.evaluate(fn);
      try {
        return await page.evaluate(({ src, args }) => (0, eval)(`(${src})`)(...args), {
          src: fn.toString(),
          args,
        });
      } catch (err) {
        throw new Error(`page eval: ${err instanceof Error ? err.message : err}`);
      }
    },

    /** Viewport-space centre and rect of the first element matching `selector`, or null. */
    box(selector: string) {
      return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          left: r.x,
          top: r.y,
          w: r.width,
          h: r.height,
        };
      }, selector);
    },

    mouseMove: (x: number, y: number) => page.mouse.move(x, y),
    mouseDown: (button: Button = 'left', clickCount = 1) => page.mouse.down({ button, clickCount }),
    mouseUp: (button: Button = 'left', clickCount = 1) => page.mouse.up({ button, clickCount }),

    /** `modifiers`: a bitmask, Alt 1, Ctrl 2, Meta 4, Shift 8. */
    async click(x: number, y: number, button: Button = 'left', modifiers = 0) {
      const held = MODIFIERS.filter(([bit]) => modifiers & bit).map(([, key]) => key);
      for (const k of held) await page.keyboard.down(k);
      try {
        await page.mouse.click(x, y, { button });
      } finally {
        for (const k of held) await page.keyboard.up(k);
      }
    },

    dblclick: (x: number, y: number) => page.mouse.dblclick(x, y),

    /** Pointer drag in `steps` moves, so drag thresholds and pointermove handlers fire. */
    async drag(from: Pt, to: Pt, steps = 12) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps });
      await page.mouse.up();
    },

    /** A real HTML5 drag: Playwright drives Chromium's drag through the mouse. */
    async dragAndDrop(from: Pt, to: Pt, steps = 8) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      // a few pixels first, so the page's dragstart fires before the long move
      await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });
      await page.mouse.move(to.x, to.y, { steps });
      await page.mouse.up();
    },

    async wheel(x: number, y: number, deltaY: number, deltaX = 0) {
      await page.mouse.move(x, y);
      await page.mouse.wheel(deltaX, deltaY);
    },

    /** Press a named key ('Enter', 'Escape', 'F2', ...) or a single character. */
    key: (key: string) => page.keyboard.press(key),

    /** Insert text at the focus, as typing it would. */
    type: (text: string) => page.keyboard.insertText(text),

    async screenshot(name: string) {
      mkdirSync(SHOT_DIR, { recursive: true });
      const file = join(SHOT_DIR, `${name}.png`);
      await page.screenshot({ path: file });
      return file;
    },

    /** Run `action` and return the file it downloads (or null within 15 s). */
    async download(action: () => Promise<unknown>) {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
        action(),
      ]);
      if (!dl) return null;
      // read through the connection: with a remote browser the file lives there
      const stream = await dl.createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      return { name: dl.suggestedFilename(), bytes: Buffer.concat(chunks) };
    },

    /** Hand a file to the file input `selector`, as the file picker would. */
    async upload(selector: string, name: string, content: string) {
      await page.setInputFiles(selector, {
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(content, 'utf8'),
      });
    },

    /** The few DevTools calls the scenarios make, in Playwright terms. */
    async send(method: string, params: Record<string, unknown>) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument')
        return page.addInitScript(String(params.source));
      if (method === 'Emulation.setEmulatedMedia') {
        const features = (params.features ?? []) as { name: string; value: string }[];
        const reduced = features.find((f) => f.name === 'prefers-reduced-motion');
        return page.emulateMedia({
          reducedMotion: reduced?.value === 'reduce' ? 'reduce' : 'no-preference',
        });
      }
      throw new Error(`no Playwright equivalent for ${method}`);
    },
  };
  return h;
}
