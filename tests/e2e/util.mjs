// Shared by the scenarios and the Playwright harness.

export const SHOT_DIR = 'layout-out/e2e';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value; throws `what` on timeout. */
export async function until(fn, what, timeout = 5000, every = 50) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
