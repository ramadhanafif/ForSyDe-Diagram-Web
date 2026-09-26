import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests (tests/e2e). Where the browser runs:
 *
 * - `npm run e2e`: on this machine. CHROMIUM_PATH if set, else a system
 *   Chromium at /usr/bin/chromium-browser if there is one, else Playwright's
 *   own (`npx playwright install chromium`). On CI always Playwright's own.
 * - `npm run e2e:remote`: in the Playwright server container on devbox
 *   (PW_WS_ENDPOINT to use another, e.g. ws://dator-cos:3100/). The server
 *   image's version must match @playwright/test. The remote browser reaches
 *   the dev server here through the connection (exposeNetwork).
 */

const PORT = 5199;
const SYSTEM_CHROMIUM = '/usr/bin/chromium-browser';
const remote = !!process.env.PW_REMOTE;
// never a system browser on CI, whatever the environment says
const executablePath = process.env.CI
  ? undefined
  : (process.env.CHROMIUM_PATH ?? (existsSync(SYSTEM_CHROMIUM) ? SYSTEM_CHROMIUM : undefined));

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  outputDir: 'layout-out/playwright',
  // the scenarios time animations and measure frame rates: one at a time
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    ...(remote
      ? {
          connectOptions: {
            wsEndpoint: process.env.PW_WS_ENDPOINT ?? 'ws://devbox:3100/',
            exposeNetwork: '<loopback>',
          },
        }
      : { launchOptions: executablePath ? { executablePath } : {} }),
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: { BASE_PATH: '/' },
    url: `http://localhost:${PORT}/`,
    // always our own server: another worktree's vite on this port would be
    // testing other code, and --strictPort fails loudly instead
    reuseExistingServer: false,
    timeout: 60000,
  },
});
