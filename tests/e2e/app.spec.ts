import { expect, test } from '@playwright/test';
import { harness } from './harness';
import { scenarios, TIMEOUTS } from './scenarios.mjs';

/**
 * Every scenario in scenarios.mjs as a Playwright test, each in a fresh
 * browser context. A scenario throws on its first failed expectation; a
 * console error, failed console.assert or uncaught exception on the page
 * fails it too, and is attached to the report when the scenario throws.
 */

// frame timing measures the machine as much as the code: shared CI runners
// have no GPU and noisy neighbours, so it runs locally and on devbox only
const LOCAL_ONLY: Record<string, string> = {
  frameRate: 'frame timing depends on the machine; run it locally or with e2e:remote',
};

for (const [name, run] of Object.entries(scenarios)) {
  test(name, async ({ page, baseURL }) => {
    test.skip(!!process.env.CI && name in LOCAL_ONLY, LOCAL_ONLY[name]);
    if (TIMEOUTS[name]) test.setTimeout(TIMEOUTS[name]);
    // set before the app boots: no first-run tour over the diagram
    await page.addInitScript(() => {
      try {
        localStorage.setItem('tourSeen', '1');
      } catch {
        // storage blocked: the tour shows, the scenarios close it
      }
    });
    const h = harness(page);
    try {
      await run(h, { url: baseURL, name });
    } finally {
      // errors are collected asynchronously: give late ones a moment to land.
      // Reported even when the scenario threw: they usually explain why.
      await page.waitForTimeout(100);
      if (h.errors.length) await test.info().attach('page errors', { body: h.errors.join('\n') });
    }
    expect(h.errors).toEqual([]);
  });
}
