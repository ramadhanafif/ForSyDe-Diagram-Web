// E2E scenarios against the scene renderer's DOM contract (see
// docs/diagram-engine-plan.md). Each scenario gets a fresh browser context
// and throws on the first failed expectation.
import { SHOT_DIR, until } from './util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-scenario timeouts beyond the runner default. */
export const TIMEOUTS = { overlap: 300000, render: 120000, bufferStrip: 120000 };

// Same model as tests/edits.test.ts: point-free actors, one delay, 1-in-1-out everywhere.
const MODEL = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor11SDF 1 2 f
d_d = delaySDF [0]
a_b = actor11SDF 2 1 g
f :: [Int] -> [Int]
f [x] = [x, x]
g :: [Int] -> [Int]
g [x, y] = [x + y]
`;

// s_x is a system input nobody consumes yet: a legal io source for drag-to-connect.
const MODEL_FREE_INPUT = `module M where
import ForSyDe.Shallow
system s_in s_x = s_out
  where
    s_1 = a_a s_in
    s_out = a_b s_1
a_a = actor11SDF 1 1 f
a_b = actor11SDF 1 1 f
f :: [Int] -> [Int]
f [x] = [x]
`;

// ---------------------------------------------------------------------------
// page-side helpers, installed as window.__e2e before the app boots

function pageHelpers() {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const attr = (name, v) => `[${name}="${CSS.escape(v)}"]`;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const SHAPES = 'circle,ellipse,rect,path,polygon';

  /** The drawn outline of a node: the node element itself, or its first shape child that is not a port. */
  function shapeEl(el) {
    if (!(el instanceof SVGElement) || el.matches(SHAPES)) return el;
    for (const c of el.querySelectorAll(SHAPES))
      if (!c.closest('[data-port-id],[data-new-input]')) return c;
    return el;
  }
  const nodeEl = (id) => q(attr('data-node-id', id));
  const nodeRect = (id) => {
    const el = nodeEl(id);
    return el ? rect(shapeEl(el)) : null;
  };

  function transform() {
    const el = q('.scene-viewport');
    if (!el) return null;
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { k: m.a, tx: m.e, ty: m.f };
  }

  /** Node `id`'s drawn outline in scene coordinates, whatever the pan and zoom. */
  function sceneBox(id) {
    const r = nodeRect(id);
    const t = transform();
    const vp = q('.scene-viewport')?.getBoundingClientRect();
    if (!r || !t || !vp) return null;
    return { x: (r.x - vp.x) / t.k, y: (r.y - vp.y) / t.k, w: r.w / t.k, h: r.h / t.k };
  }

  // captured before the app boots, so frame-cost instrumentation does not count the sampler
  const raf = window.requestAnimationFrame.bind(window);
  /** Run `start`, then collect `sample()` on every animation frame for `ms`. */
  function record(ms, sample, start) {
    return new Promise((resolve) => {
      const out = [];
      const t0 = performance.now();
      start?.();
      const loop = (now) => {
        out.push({ t: now, ...sample() });
        if (performance.now() - t0 < ms) raf(loop);
        else resolve(out);
      };
      raf(loop);
    });
  }

  const tokenIds = new WeakMap();
  let nextToken = 0;
  /** Visible travelling tokens in scene coordinates, each with a stable id. */
  function tokens() {
    return qa('.token')
      .filter((c) => c.style.display !== 'none')
      .map((c) => {
        if (!tokenIds.has(c)) tokenIds.set(c, nextToken++);
        const at = (a) => Number(c.getAttribute(a));
        return { id: tokenIds.get(c), x: at('cx'), y: at('cy') };
      });
  }

  /** The DOM shows exactly the current scene's nodes and edges. */
  function settled() {
    const s = window.__fsd?.scene();
    if (!s) return false;
    return (
      qa('[data-node-id]').length === s.nodes.length &&
      qa('[data-edge-id]').length === s.edges.length &&
      s.nodes.every((n) => nodeEl(n.id))
    );
  }
  /**
   * Fingerprint for "nothing is moving any more" polling; null while a layout
   * transition or token travel runs (only `kind`, when given).
   */
  function snapshot(kind) {
    if (!settled() || window.__fsd.animating(kind)) return null;
    const t = transform();
    const boxes = qa('[data-node-id]').map((el) => {
      const r = rect(shapeEl(el));
      return `${r.x.toFixed(1)},${r.y.toFixed(1)}`;
    });
    return JSON.stringify([t, boxes]);
  }
  function mark() {
    window.__e2eMark = window.__fsd.scene();
  }
  function changed() {
    const s = window.__fsd.scene();
    return !!s && s !== window.__e2eMark && settled();
  }

  const edgePath = (el) => (el instanceof SVGGeometryElement ? el : el.querySelector('path'));
  /** Client point on edge `id` that actually hits it (not a label or node on top). */
  function edgePoint(id) {
    const el = q(attr('data-edge-id', id));
    if (!el) return null;
    const path = edgePath(el);
    const len = path.getTotalLength();
    const m = path.getScreenCTM();
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
      const p = path.getPointAtLength(len * f);
      const c = new DOMPoint(p.x, p.y).matrixTransform(m);
      const hit = document.elementFromPoint(c.x, c.y)?.closest('[data-edge-id]');
      if (hit?.getAttribute('data-edge-id') === id) return { x: c.x, y: c.y };
    }
    return null;
  }
  /** Client coordinates of both ends of edge `id`. */
  function edgeEnds(id) {
    const el = q(attr('data-edge-id', id));
    if (!el) return null;
    const path = edgePath(el);
    const m = path.getScreenCTM();
    const at = (l) => {
      const p = path.getPointAtLength(l);
      const c = new DOMPoint(p.x, p.y).matrixTransform(m);
      return { x: c.x, y: c.y };
    };
    return { start: at(0), end: at(path.getTotalLength()) };
  }

  const BUSY =
    '[data-node-id],[data-edge-id],[data-label-id],[data-port-id],[data-new-input],.popover,[role=menu],button,input,select';
  /** A canvas point with nothing interactive within 24 px. */
  function emptyPoint() {
    const wrap = q('.diagram-wrap');
    if (!wrap) return null;
    const r = rect(wrap);
    const free = (x, y) => {
      const e = document.elementFromPoint(x, y);
      return !!e && wrap.contains(e) && !e.closest(BUSY);
    };
    for (let y = r.y + r.h - 40; y > r.y + 40; y -= 20)
      for (let x = r.x + 40; x < r.x + r.w - 40; x += 20)
        if (
          [
            [0, 0],
            [24, 0],
            [-24, 0],
            [0, 24],
            [0, -24],
          ].every(([dx, dy]) => free(x + dx, y + dy))
        )
          return { x, y };
    return null;
  }

  /** Centre of the button under `scope` whose text is `text`. */
  function button(scope, text) {
    const b = qa(`${scope} button`).find((el) => el.textContent.trim() === text);
    return b ? center(rect(b)) : null;
  }
  /** Set a popover row's input (React-controlled) by its row label. */
  function fill(label, value) {
    const row = qa('.popover label.row').find(
      (l) => l.querySelector('span')?.textContent.trim() === label,
    );
    const input = row?.querySelector('input');
    if (!input) throw new Error(`no popover row '${label}'`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  /** Change the toolbar example <select> the way a user does. */
  function selectExample(name) {
    const sel = q('.toolbar select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, name);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Live label overlap check with real fonts: label/label boxes overlapping by
   * more than 1 px in both axes, and labels reaching more than 1 px into a
   * node's rounded shape (radius min(w, h) / 2, as src/scene/metrics.ts), except
   * a stack label inside its own node.
   */
  function overlaps() {
    const s = window.__fsd.scene();
    const meta = new Map(s.labels.map((l) => [l.id, l]));
    const labels = qa('.scene-labels [data-label-id]')
      .map((el) => {
        const id = el.getAttribute('data-label-id');
        return {
          id,
          kind: el.getAttribute('data-label-kind'),
          owner: meta.get(id)?.owner,
          r: rect(el),
        };
      })
      .filter((l) => l.r.w > 0 && l.r.h > 0);
    const nodes = qa('[data-node-id]').map((el) => ({
      id: el.getAttribute('data-node-id'),
      r: rect(shapeEl(el)),
    }));
    const out = [];
    const f = (v) => v.toFixed(1);
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i].r;
        const b = labels[j].r;
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w > 1 && h > 1)
          out.push(
            `label ${labels[i].id} (${labels[i].kind}) x label ${labels[j].id} (${labels[j].kind}) by ${f(w)}x${f(h)}`,
          );
      }
    for (const l of labels)
      for (const n of nodes) {
        if (l.kind === 'stack' && l.owner === n.id) continue;
        const b = n.r;
        const rad = Math.min(b.w, b.h) / 2;
        // core segment of the rounded shape, as a degenerate rect
        const c =
          b.w >= b.h
            ? { x: b.x + rad, y: b.y + rad, w: b.w - 2 * rad, h: 0 }
            : { x: b.x + rad, y: b.y + rad, w: 0, h: b.h - 2 * rad };
        const dx = Math.max(0, c.x - (l.r.x + l.r.w), l.r.x - (c.x + c.w));
        const dy = Math.max(0, c.y - (l.r.y + l.r.h), l.r.y - (c.y + c.h));
        const depth = rad - Math.hypot(dx, dy);
        if (depth > 1) out.push(`label ${l.id} (${l.kind}) into node ${n.id} by ${f(depth)}`);
      }
    return out;
  }

  window.__e2e = {
    q,
    qa,
    attr,
    rect,
    center,
    shapeEl,
    nodeRect,
    transform,
    settled,
    snapshot,
    mark,
    changed,
    edgePoint,
    edgeEnds,
    emptyPoint,
    button,
    fill,
    selectExample,
    overlaps,
    sceneBox,
    record,
    tokens,
  };
}

// ---------------------------------------------------------------------------
// node-side helpers

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const doc = (page) => page.eval(() => window.__fsd.getDoc());
const ir = (page) => page.eval(() => window.__fsd.ir());
const scene = (page) => page.eval(() => window.__fsd.scene());
const count = (text, re) => (text.match(re) ?? []).length;

/**
 * Wait until the DOM matches the scene and nothing moves: fit animations,
 * layout transitions and token travel (only `kind` of the last two, when given).
 */
async function settle(page, what = 'scene to settle', kind = undefined) {
  let prev = null;
  let same = 0;
  await until(
    async () => {
      const snap = await page.eval(
        (k) => window.__e2e?.snapshot(k ?? undefined) ?? null,
        kind ?? null,
      );
      same = snap !== null && snap === prev ? same + 1 : 0;
      prev = snap;
      return same >= 2;
    },
    what,
    8000,
    60,
  );
}

async function open(page, url) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${pageHelpers})()` });
  await page.goto(url);
  await until(() => page.eval(() => !!window.__fsd?.scene()), 'window.__fsd with a scene', 15000);
  await settle(page);
}

/** Run `action` and wait for a new scene to be rendered. */
async function sceneChange(page, action, what, kind = undefined) {
  await page.eval(() => window.__e2e.mark());
  await action();
  await until(() => page.eval(() => window.__e2e.changed()), what, 8000);
  await settle(page, `${what} to settle`, kind);
}

/** Run `action`, expect the source text to change, then wait for the new scene. */
async function edit(page, action, what) {
  const before = await doc(page);
  await sceneChange(page, action, what);
  const after = await doc(page);
  expect(after !== before, `${what}: source text did not change`);
  return { before, after };
}

/** Run `action` and expect the source text to stay the same. */
async function noEdit(page, action, what, wait = 600) {
  const before = await doc(page);
  await action();
  await sleep(wait);
  expect((await doc(page)) === before, `${what}: source text changed`);
}

/** `kind`: settle on layout transitions only (tokens keep travelling during playback). */
async function load(page, src, kind = undefined) {
  if ((await doc(page)) === src) return;
  await sceneChange(
    page,
    () => page.eval((s) => window.__fsd.setSource(s), src),
    'scene after setSource',
    kind,
  );
}

async function clickButton(page, scope, text, button = 'left') {
  const at = await page.eval((s, t) => window.__e2e.button(s, t), scope, text);
  expect(at, `no button '${text}' in ${scope}`);
  await page.click(at.x, at.y, button);
}

async function nodeCenter(page, id) {
  const r = await page.eval((i) => window.__e2e.nodeRect(i), id);
  expect(r, `no node ${id}`);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

async function edgePoint(page, id) {
  const p = await page.eval((i) => window.__e2e.edgePoint(i), id);
  expect(p, `no clickable point on edge ${id}`);
  return p;
}

async function emptyPoint(page) {
  const p = await page.eval(() => window.__e2e.emptyPoint());
  expect(p, 'no empty canvas point');
  return p;
}

const exists = (page, sel) => page.eval((s) => !!document.querySelector(s), sel);
const waitFor = (page, sel, what = sel, timeout = 3000) =>
  until(() => exists(page, sel), what, timeout);
const waitGone = (page, sel, what = `${sel} to close`) =>
  until(async () => !(await exists(page, sel)), what, 3000);

const nodeIds = (page) =>
  page.eval(() => window.__e2e.qa('[data-node-id]').map((el) => el.getAttribute('data-node-id')));

const menuLabels = (page) =>
  page.eval(() =>
    window.__e2e.qa('[role=menu] [role=menuitem]').map((el) => el.textContent.trim()),
  );

async function clickNode(page, id) {
  const c = await nodeCenter(page, id);
  await page.click(c.x, c.y);
  await waitFor(page, '.popover', `popover for node ${id}`);
}

async function clickEdge(page, id) {
  const p = await edgePoint(page, id);
  await page.click(p.x, p.y);
  await waitFor(page, '.popover', `popover for edge ${id}`);
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

async function selectExample(page, name) {
  const current = await page.eval(() => document.querySelector('.toolbar select').value);
  if (current === name) return settle(page);
  await sceneChange(
    page,
    () => page.eval((n) => window.__e2e.selectExample(n), name),
    `example ${name}`,
  );
}

const exampleNames = (page) =>
  page.eval(() => window.__e2e.qa('.toolbar select option').map((o) => o.value));

const FLAG_BUTTONS = [
  'signal names',
  'rates',
  'buffer sizes',
  'repetitions',
  'constructors',
  'functions',
  'rates equal to 1',
];

/** Set SHOW flags by button label; unlisted flags keep their state. */
async function setFlags(page, want) {
  const toClick = await page.eval(
    (want, order) => {
      const buttons = window.__e2e.qa('.detail-switch button');
      return order.filter((label) => {
        const b = buttons.find((el) => el.textContent.trim() === label);
        if (!b) throw new Error(`no SHOW button '${label}'`);
        return label in want && b.classList.contains('active') !== want[label];
      });
    },
    want,
    FLAG_BUTTONS,
  );
  if (!toClick.length) return;
  await sceneChange(
    page,
    // main flags before 'rates equal to 1', which is disabled while rates are off
    () =>
      page.eval((labels) => {
        for (const label of labels)
          window.__e2e
            .qa('.detail-switch button')
            .find((el) => el.textContent.trim() === label)
            .click();
      }, toClick),
    `SHOW ${toClick.join(', ')}`,
  );
}

async function setStyle(page, style) {
  const label = style === 'lecture' ? 'Lecture' : 'Modern';
  const checked = (t) =>
    page.eval(
      (l) =>
        window.__e2e
          .qa('.toolbar-items > .seg [role=radio]')
          .find((b) => b.textContent.trim() === l)
          ?.getAttribute('aria-checked') === 'true',
      t,
    );
  if (await checked(label)) return;
  await clickButton(page, '.toolbar-items > .seg', label);
  await until(() => checked(label), `${style} style`);
  await settle(page);
}

const DEFAULT_SHOW = Object.fromEntries(FLAG_BUTTONS.map((l) => [l, true]));
const NO_UNIT_SHOW = { ...DEFAULT_SHOW, 'rates equal to 1': false };

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// scenarios

async function render(page, { url }) {
  await open(page, url);
  const names = await exampleNames(page);
  expect(names.length > 0, 'example select is empty');
  const problems = [];
  for (const name of names) {
    await selectExample(page, name);
    const { want, wantEdges, got, gotEdges } = await page.eval(() => {
      const m = window.__fsd.ir();
      const qa = window.__e2e.qa;
      return {
        want: [...new Set([...m.processes.map((p) => p.name), ...m.inputs, ...m.outputs])],
        wantEdges: m.signals.map((s) => `e_${s.name}_${s.source.name}_${s.target.name}`),
        got: qa('[data-node-id]').map((el) => el.getAttribute('data-node-id')),
        gotEdges: qa('[data-edge-id]').map((el) => el.getAttribute('data-edge-id')),
      };
    });
    if (!sameSet(want, got)) problems.push(`${name}: nodes [${got}] want [${want}]`);
    if (!sameSet(wantEdges, gotEdges))
      problems.push(`${name}: edges [${gotEdges}] want [${wantEdges}]`);
  }
  expect(!problems.length, problems.join('\n    '));
}

async function overlap(page, { url }) {
  await open(page, url);
  const names = await exampleNames(page);
  const offenders = [];
  for (const style of ['modern', 'lecture']) {
    await setStyle(page, style);
    for (const [flagName, flags] of [
      ['default', DEFAULT_SHOW],
      ['no-unit-rates', NO_UNIT_SHOW],
    ]) {
      await setFlags(page, flags);
      for (const name of names) {
        await selectExample(page, name);
        await page.eval(() => document.fonts.ready.then(() => undefined));
        const found = await page.eval(() => window.__e2e.overlaps());
        if (found.length) {
          offenders.push(...found.map((f) => `${name} ${style} ${flagName}: ${f}`));
          await page.screenshot(`overlap-${name}-${style}-${flagName}`);
        }
      }
    }
  }
  expect(
    !offenders.length,
    `${offenders.length} overlaps (screenshots in ${SHOT_DIR}):\n    ${offenders.slice(0, 40).join('\n    ')}`,
  );
}

async function insertOnEdge(page, { url }) {
  await open(page, url);
  await load(page, MODEL);

  let ids = await nodeIds(page);
  await clickEdge(page, 'e_s_1_a_a_d_d');
  const a = await edit(page, () => clickButton(page, '.popover', 'actor'), 'insert actor');
  expect(
    count(a.after, /actor11SDF/g) === count(a.before, /actor11SDF/g) + 1,
    'insert actor: no new actor11SDF spec in the source',
  );
  let added = (await nodeIds(page)).filter((id) => !ids.includes(id));
  expect(added.length === 1, `insert actor: new nodes [${added}]`);
  expect(
    await exists(page, `[data-node-id="${added[0]}"].kind-actor`),
    `insert actor: node ${added[0]} is not .kind-actor`,
  );

  ids = await nodeIds(page);
  await clickEdge(page, 'e_s_2_d_d_a_b');
  const d = await edit(page, () => clickButton(page, '.popover', 'delay'), 'insert delay');
  expect(
    count(d.after, /delaySDF/g) === count(d.before, /delaySDF/g) + 1,
    'insert delay: no new delaySDF spec in the source',
  );
  added = (await nodeIds(page)).filter((id) => !ids.includes(id));
  expect(added.length === 1, `insert delay: new nodes [${added}]`);
  expect(
    await exists(page, `[data-node-id="${added[0]}"].kind-delay`),
    `insert delay: node ${added[0]} is not .kind-delay`,
  );
}

async function nodePopover(page, { url }) {
  await open(page, url);
  await load(page, MODEL);

  await clickNode(page, 'a_a');
  await page.eval(() => window.__e2e.fill('in rates', '3'));
  const r = await edit(page, () => clickButton(page, '.popover', 'apply'), 'set rates');
  expect(r.after.includes('a_a = actor11SDF 3 2 f'), 'set rates: expected a_a = actor11SDF 3 2 f');
  await waitGone(page, '.popover');

  const uses = count(r.after, /\ba_b\b/g);
  await clickNode(page, 'a_b');
  await page.eval(() => window.__e2e.fill('name', 'a_zz'));
  const n = await edit(page, () => clickButton(page, '.popover', 'apply'), 'rename');
  expect(count(n.after, /\ba_b\b/g) === 0, 'rename: a_b still occurs in the source');
  expect(
    count(n.after, /\ba_zz\b/g) === uses,
    `rename: a_zz occurs ${count(n.after, /\ba_zz\b/g)} times, want ${uses}`,
  );
  expect(await exists(page, '[data-node-id="a_zz"]'), 'rename: no node a_zz');

  await clickNode(page, 'd_d');
  await noEdit(page, () => clickButton(page, '.popover', 'delete'), 'first delete click');
  expect(
    await page.eval(() => !!window.__e2e.button('.popover', 'confirm delete?')),
    'delete: no confirm step',
  );
  const del = await edit(page, () => clickButton(page, '.popover', 'confirm delete?'), 'delete');
  expect(!/\bd_d\b/.test(del.after), 'delete: d_d still in the source');
  expect(!(await exists(page, '[data-node-id="d_d"]')), 'delete: node d_d still drawn');
}

async function contextMenus(page, { url }) {
  await open(page, url);
  await load(page, MODEL);

  const menuAt = async (p, what) => {
    await page.click(p.x, p.y, 'right');
    await waitFor(page, '[role=menu]', `context menu on ${what}`);
    return menuLabels(page);
  };
  const close = async () => {
    await page.key('Escape');
    await waitGone(page, '[role=menu]');
  };
  const check = (got, want, what) =>
    expect(got.join('|') === want.join('|'), `${what} menu [${got}] want [${want}]`);

  check(
    await menuAt(await nodeCenter(page, 'a_a'), 'a_a'),
    ['rename a_a', 'set rates', 'set function', 'goto f', 'delete'],
    'actor',
  );
  await close();
  check(
    await menuAt(await nodeCenter(page, 'd_d'), 'd_d'),
    ['rename d_d', 'set tokens', 'delete'],
    'delay',
  );
  await close();
  check(
    await menuAt(await edgePoint(page, 'e_s_1_a_a_d_d'), 'edge s_1'),
    ['insert actor', 'insert delay', 'rename signal s_1'],
    'edge',
  );
  await close();
  check(await menuAt(await emptyPoint(page), 'canvas'), ['add actor', 'fit view'], 'canvas');

  const before = await ir(page);
  await edit(
    page,
    async () => {
      const at = await page.eval(() => {
        const b = window.__e2e
          .qa('[role=menu] [role=menuitem]')
          .find((el) => el.textContent.trim() === 'add actor');
        return b && window.__e2e.center(window.__e2e.rect(b));
      });
      expect(at, 'no add actor item');
      await page.click(at.x, at.y);
    },
    'canvas add actor',
  );
  const after = await ir(page);
  expect(after.inputs.length === before.inputs.length + 1, 'add actor: no new system input');
  expect(after.outputs.length === before.outputs.length + 1, 'add actor: no new system output');
  expect(after.processes.length === before.processes.length + 1, 'add actor: no new actor');
}

async function chip(page, label) {
  const at = await page.eval((t) => {
    const c = window.__e2e.qa('.toolbar .palette .chip').find((el) => el.textContent.trim() === t);
    return c && window.__e2e.center(window.__e2e.rect(c));
  }, label);
  expect(at, `no palette chip '${label}'`);
  return at;
}

async function paletteDrag(page, { url }) {
  await open(page, url);
  await load(page, MODEL);

  let before = await ir(page);
  await edit(
    page,
    async () => page.dragAndDrop(await chip(page, 'actor'), await edgePoint(page, 'e_s_1_a_a_d_d')),
    'actor chip onto edge',
  );
  let after = await ir(page);
  expect(
    after.processes.length === before.processes.length + 1,
    'actor chip onto edge: no new process',
  );
  expect(
    after.inputs.length === before.inputs.length,
    'actor chip onto edge: system inputs changed',
  );

  before = after;
  await edit(
    page,
    async () => page.dragAndDrop(await chip(page, 'actor'), await emptyPoint(page)),
    'actor chip onto canvas',
  );
  after = await ir(page);
  expect(
    after.processes.length === before.processes.length + 1,
    'actor chip onto canvas: no new process',
  );
  expect(
    after.inputs.length === before.inputs.length + 1,
    'actor chip onto canvas: no new source input',
  );

  await noEdit(
    page,
    async () => page.dragAndDrop(await chip(page, 'delay'), await emptyPoint(page)),
    'delay chip onto canvas',
  );
  await waitFor(page, '.notice-toast', 'toast after dropping a delay on the canvas');
}

/** Pointer drag from a port or io node to an actor's add-input handle. */
async function connect(page, fromSel, proc) {
  const from = await page.box(fromSel);
  expect(from, `no drag source ${fromSel}`);
  const to = await page.box(`[data-new-input="${proc}"]`);
  expect(to, `no add-input handle on ${proc}`);
  await page.drag(from, to, 16);
}

async function dragConnect(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const out = await edit(
    page,
    () => connect(page, '[data-port-id="a_b.out.s_out"]', 'a_a'),
    'connect out port',
  );
  expect(
    out.after.includes('a_a = actor21SDF (1, 1) 2 f'),
    'connect out port: a_a constructor not bumped to actor21SDF',
  );
  expect(out.after.includes('s_1 = a_a s_in s_out'), 'connect out port: binding not extended');
  expect(await exists(page, '[data-port-id*=".out."]'), 'no out ports drawn');

  await load(page, MODEL_FREE_INPUT);
  const io = await edit(
    page,
    () => connect(page, '[data-io-handle="s_x"]', 'a_b'),
    'connect io source',
  );
  expect(
    io.after.includes('a_b = actor21SDF (1, 1) 1 f'),
    'connect io source: a_b constructor not bumped',
  );
  expect(io.after.includes('s_out = a_b s_1 s_x'), 'connect io source: binding not extended');

  await page.eval(() => window.__e2e.selectExample('SDF_example_003'));
  await until(() => doc(page).then((d) => d.includes('module SDF_example_003')), 'SDF_example_003');
  await settle(page);
  await noEdit(page, () => connect(page, '[data-port-id="d_1.out.s_2"]', 'a_a'), 'refused connect');
  await waitFor(page, '.notice-toast', 'toast explaining the refused connection');
  const toast = await page.eval(() => document.querySelector('.notice-toast').textContent);
  expect(/explicit signal parameters/.test(toast), `refusal toast says '${toast}'`);
}

async function keyboard(page, { url }) {
  await open(page, url);
  await load(page, MODEL);

  await clickNode(page, 'a_a');
  expect(await exists(page, '[data-node-id="a_a"].selected'), 'clicked node is not .selected');
  await page.key('Escape');
  await waitGone(page, '.popover', 'Escape to close the popover');

  await page.eval(() => document.querySelector('[data-node-id="a_b"]').focus());
  expect(
    await page.eval(() => document.activeElement?.getAttribute('data-node-id') === 'a_b'),
    'node a_b does not take focus (tabIndex 0)',
  );
  await page.key('Enter');
  await waitFor(page, '.popover', 'Enter on a focused node to open its popover');
  expect(
    await page.eval(() => /a_b/.test(document.querySelector('.popover').textContent)),
    'Enter opened a popover for another node',
  );
}

async function panZoom(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const t = () => page.eval(() => window.__e2e.transform());

  const t0 = await t();
  expect(t0, 'no .scene-viewport');
  const from = await emptyPoint(page);
  await page.drag(from, { x: from.x + 80, y: from.y + 50 });
  await settle(page);
  const t1 = await t();
  expect(
    near(t1.tx - t0.tx, 80) && near(t1.ty - t0.ty, 50) && near(t1.k, t0.k, 1e-6),
    `pan by (80, 50) moved the viewport by (${t1.tx - t0.tx}, ${t1.ty - t0.ty}), scale ${t0.k} -> ${t1.k}`,
  );

  // zoom around the cursor: a node's offset from the cursor scales by k1 / k0
  const cursor = await emptyPoint(page);
  const c0 = await nodeCenter(page, 'a_a');
  await page.wheel(cursor.x, cursor.y, -300);
  await settle(page);
  const t2 = await t();
  expect(!near(t2.k, t1.k, 1e-3), `wheel did not change the scale (${t1.k})`);
  const c1 = await nodeCenter(page, 'a_a');
  const ratio = t2.k / t1.k;
  const want = { x: cursor.x + (c0.x - cursor.x) * ratio, y: cursor.y + (c0.y - cursor.y) * ratio };
  expect(
    near(c1.x, want.x, 3) && near(c1.y, want.y, 3),
    `zoom is not anchored at the cursor: a_a at (${c1.x}, ${c1.y}), want (${want.x}, ${want.y})`,
  );

  // zoom far in so the scene overflows, then fit
  for (let i = 0; i < 5; i++) await page.wheel(cursor.x, cursor.y, -300);
  await settle(page);
  const fit = await page.box('[data-zoom="fit"]');
  expect(fit, 'no [data-zoom=fit] button');
  expect(
    (await page.box('[data-zoom="in"]')) && (await page.box('[data-zoom="out"]')),
    'missing zoom in/out buttons',
  );
  await page.click(fit.x, fit.y);
  await settle(page);
  const outside = await page.eval(() => {
    const { qa, rect, shapeEl } = window.__e2e;
    const w = rect(document.querySelector('.diagram-wrap'));
    const els = [...qa('[data-node-id]').map(shapeEl), ...qa('.scene-labels [data-label-id]')];
    return els
      .filter((el) => {
        const r = rect(el);
        return (
          r.w > 0 &&
          (r.x < w.x - 1 || r.y < w.y - 1 || r.x + r.w > w.x + w.w + 1 || r.y + r.h > w.y + w.h + 1)
        );
      })
      .map((el) => el.getAttribute('data-node-id') ?? el.getAttribute('data-label-id'));
  });
  expect(!outside.length, `after fit, outside the pane: ${outside.join(', ')}`);
}

async function showFlags(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  await setFlags(page, DEFAULT_SHOW);
  const signals = () =>
    page.eval(() => document.querySelectorAll('[data-label-kind="signal"]').length);

  const n0 = await signals();
  const w0 = (await scene(page)).bounds.w;
  expect(n0 > 0, 'no signal labels with default flags');
  await setFlags(page, { 'signal names': false });
  expect((await signals()) === 0, 'signal labels still drawn with signal names off');
  const s1 = await scene(page);
  expect(!s1.labels.some((l) => l.kind === 'signal'), 'scene still has signal labels');
  expect(
    s1.bounds.w <= w0 + 0.5,
    `scene grew from ${w0} to ${s1.bounds.w} wide without signal names`,
  );
  await setFlags(page, { 'signal names': true });
  expect((await signals()) === n0, `signal labels ${await signals()} after restoring, want ${n0}`);
}

async function stale(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const ids = await nodeIds(page);

  // type at the end of the document (MODEL ends with a newline: an empty last line)
  const last = await page.eval(() => {
    const lines = window.__e2e.qa('.editor-pane .cm-line');
    return window.__e2e.center(window.__e2e.rect(lines[lines.length - 1]));
  });
  await page.click(last.x, last.y);
  // function bodies are opaque to the parser, so break the netlist: an unfinished second system
  const junk = 'system =';
  await page.type(junk);
  await until(() => doc(page).then((d) => d !== MODEL), 'typed text to reach the editor');
  await waitFor(page, '.diagram-wrap.stale', '.stale after a syntax error', 5000);
  await waitFor(page, '.status-chip', '.status-chip after a syntax error', 5000);
  expect(sameSet(await nodeIds(page), ids), 'the last diagram was not kept while stale');

  for (let i = 0; i < junk.length; i++) await page.key('Backspace');
  await until(
    () => doc(page).then((d) => d === MODEL),
    'source restored after deleting the typed text',
  );
  await waitGone(page, '.diagram-wrap.stale', '.stale to clear');
  await waitGone(page, '.status-chip', '.status-chip to clear');
}

async function exportPng(page, { url }) {
  await open(page, url);
  const got = await page.download(() => pickExport(page, 'png'));
  expect(got, 'Export PNG did not start a download');
  expect(/\.png$/.test(got.name), `download is named ${got.name}`);
  await sleep(300);
  const toast = await page.eval(() => document.querySelector('.notice-toast')?.textContent ?? '');
  expect(!/failed/.test(toast), `toast: ${toast}`);
}

/** Open the toolbar's Export menu and pick one format. */
async function pickExport(page, kind) {
  const summary = await page.box('.export-menu summary');
  expect(summary, 'no Export menu in the toolbar');
  await page.click(summary.x, summary.y);
  // the items render once the details element reports it opened
  await waitFor(page, `.export-menu [data-export="${kind}"]`, 'the Export menu items');
  const item = await page.box(`.export-menu [data-export="${kind}"]`);
  expect(item, `no '${kind}' item in the Export menu`);
  await page.click(item.x, item.y);
}

/** Every export format produces the right kind of file (or clipboard text). */
async function exportFormats(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const fetchDownload = async (kind) => {
    const got = await page.download(() => pickExport(page, kind));
    expect(got, `${kind}: no download`);
    return got;
  };
  const png = await fetchDownload('png');
  expect(png.name === 'M.png', `png named ${png.name}`);
  expect(
    png.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'the png lacks the PNG signature',
  );
  const svg = await fetchDownload('svg');
  const text = svg.bytes.toString('utf8');
  expect(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(text), 'svg root missing');
  // every node and edge, and the labels as text, with no interaction chrome
  const s = await scene(page);
  expect((text.match(/data-node-id=/g) ?? []).length === s.nodes.length, 'svg node count');
  expect((text.match(/data-edge-id=/g) ?? []).length === s.edges.length, 'svg edge count');
  for (const id of ['a_a', 'a_b', 'd_d'])
    expect(text.includes(`>${id.split('_')[0]}<`), `svg lacks the label of ${id}`);
  // classes are stripped on export, so look for what the chrome leaves behind:
  // add-input handles keep their data attribute, and hit paths double the paths
  expect(!/data-new-input/.test(text), 'svg carries the add-input handles');
  const paths = (text.match(/<path /g) ?? []).length;
  // one line per edge plus the arrowhead in the marker definition
  expect(paths === s.edges.length + 1, `svg has ${paths} paths for ${s.edges.length} edges`);
  const tex = await fetchDownload('tikz');
  const doc = tex.bytes.toString('utf8');
  expect(tex.name === 'M.tex', `tex named ${tex.name}`);
  expect(/^\\documentclass\[tikz/.test(doc) && /\\end\{document\}/.test(doc), 'not a tex document');
  // Copy TikZ writes only the picture to the clipboard
  await page.eval(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => {
      window.__copied = t;
    };
  });
  await pickExport(page, 'copy-tikz');
  await until(() => page.eval(() => window.__copied !== null), 'the clipboard write', 3000);
  const copied = await page.eval(() => window.__copied);
  expect(/^\\begin\{tikzpicture\}/.test(copied) && !/documentclass/.test(copied), 'copied text');
}

async function nodeDrag(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const s = await scene(page);
  const touching = s.edges.filter(
    (e) => e.source.startsWith('a_a.') || e.target.startsWith('a_a.'),
  );
  expect(touching.length === 2, `a_a has ${touching.length} edges`);
  const ends = () =>
    Promise.all(
      touching.map(async (e) => {
        const p = await page.eval((i) => window.__e2e.edgeEnds(i), e.id);
        return e.source.startsWith('a_a.') ? p.start : p.end;
      }),
    );

  const src = await doc(page);
  const r0 = await page.eval(() => window.__e2e.nodeRect('a_a'));
  const e0 = await ends();
  const c = { x: r0.x + r0.w / 2, y: r0.y + r0.h / 2 };
  await page.drag(c, { x: c.x + 60, y: c.y + 40 });
  await settle(page);
  const r1 = await page.eval(() => window.__e2e.nodeRect('a_a'));
  expect(
    near(r1.x - r0.x, 60, 3) && near(r1.y - r0.y, 40, 3),
    `node moved by (${r1.x - r0.x}, ${r1.y - r0.y}), want (60, 40)`,
  );
  const e1 = await ends();
  e0.forEach((p, i) =>
    expect(
      near(e1[i].x - p.x, 60, 3) && near(e1[i].y - p.y, 40, 3),
      `edge ${touching[i].id} end moved by (${e1[i].x - p.x}, ${e1[i].y - p.y}), want (60, 40)`,
    ),
  );
  expect((await doc(page)) === src, 'dragging a node changed the source text');
}

/** A drag pins the layout: the node stays put across an edit, Tidy undoes it, Undo redoes it. */
async function pinAndTidy(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const auto = nodeBox(await scene(page), 'a_a');
  const r0 = await page.eval(() => window.__e2e.nodeRect('a_a'));
  const c = { x: r0.x + r0.w / 2, y: r0.y + r0.h / 2 };
  await page.drag(c, { x: c.x + 70, y: c.y + 90 });
  await settle(page);
  const pinned = nodeBox(await scene(page), 'a_a');
  expect(
    !near(pinned.x, auto.x, 20) || !near(pinned.y, auto.y, 20),
    `a_a did not move: ${fmt(pinned)}`,
  );
  // an edit in the text re-lays out, but pinned nodes keep their spots
  await sceneChange(
    page,
    () =>
      page.eval(
        (s) => window.__fsd.setSource(s),
        MODEL.replace('actor11SDF 2 1 g', 'actor11SDF 2 3 g'),
      ),
    'scene after the edit',
  );
  await settle(page);
  expect(sameBox(nodeBox(await scene(page), 'a_a'), pinned), 'the pin did not survive an edit');
  // Tidy: back to the automatic layout, with an Undo in the toast
  await clickButton(page, '.toolbar', 'Tidy');
  await settle(page);
  expect(!sameBox(nodeBox(await scene(page), 'a_a'), pinned), 'Tidy left a_a where it was dragged');
  const undo = await page.box('.notice-toast button');
  expect(undo, 'no Undo in the Tidy toast');
  await page.click(undo.x, undo.y);
  await settle(page);
  expect(sameBox(nodeBox(await scene(page), 'a_a'), pinned), 'Undo did not restore the pin');
  // every edge still leaves and enters at its ports, orthogonally
  for (const e of (await scene(page)).edges)
    for (let i = 1; i < e.points.length; i++) {
      const [a, b] = [e.points[i - 1], e.points[i]];
      expect(near(a.x, b.x, 0.01) || near(a.y, b.y, 0.01), `${e.id} has a diagonal segment`);
    }
}

/** Arrow keys nudge the focused node and pin it; Shift nudges further. */
async function arrowKeys(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const b0 = nodeBox(await scene(page), 'a_b');
  await page.eval(() => document.querySelector('[data-node-id="a_b"]').focus());
  await page.key('ArrowRight');
  await settle(page);
  await page.key('Shift+ArrowDown');
  await settle(page);
  const b1 = nodeBox(await scene(page), 'a_b');
  expect(
    near(b1.x - b0.x, 8, 1) && near(b1.y - b0.y, 32, 1),
    `a_b nudged by (${b1.x - b0.x}, ${b1.y - b0.y}), want (8, 32)`,
  );
}

/** Present: P hides the editor and zooms in, Space plays, arrows step (never nudge), Esc leaves. */
async function presentMode(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const k = () =>
    page.eval(() => {
      const m = /scale\(([\d.]+)\)/.exec(document.querySelector('.scene-viewport').style.transform);
      return m ? Number(m[1]) : 0;
    });
  const k0 = await k();
  const b0 = nodeBox(await scene(page), 'a_b');
  // a focused node must not take the arrows as a nudge while presenting
  await page.eval(() => document.querySelector('[data-node-id="a_b"]').focus());
  await page.key('p');
  await settle(page);
  expect(await exists(page, '.app.presenting'), 'P did not start presenting');
  expect(
    await page.eval(
      () => getComputedStyle(document.querySelector('.editor-pane')).display === 'none',
    ),
    'the editor is still shown',
  );
  await until(async () => (await k()) > k0 * 1.3, `a bigger fit than ${k0}`);
  await page.key('ArrowRight');
  await page.key('ArrowRight');
  const at = await page.eval(() => document.querySelector('.tl-pos').textContent);
  expect(/^step 2\//.test(at), `arrows stepped to '${at}'`);
  const b1 = nodeBox(await scene(page), 'a_b');
  expect(b1.x === b0.x && b1.y === b0.y, 'an arrow nudged the focused node');
  await page.key(' ');
  await waitFor(page, '.timeline [aria-label="pause"]', 'Space to start playing');
  await page.key('Escape');
  expect(!(await exists(page, '.app.presenting')), 'Esc did not leave present mode');
  expect(!!(await doc(page)).length, 'the editor lost its text');
  // a teacher clicks the button: Space must then play, not click the button again
  await clickButton(page, '.toolbar', 'Present');
  await page.key(' ');
  await settle(page);
  expect(await exists(page, '.app.presenting'), 'Space after the Present button left present mode');
}

/** The toolbar is one row down to 1024 px; its menus close on Esc and give focus back. */
async function toolbarRow(page, { url }) {
  for (const [w, h] of [
    [1280, 720],
    [1024, 768],
  ]) {
    await page.viewport(w, h);
    await open(page, url);
    const bar = await page.box('.toolbar');
    expect(bar.h <= 44, `the toolbar wraps at ${w} px: ${bar.h} px high`);
  }
  await clickSelectorCenter(page, '.export-menu summary');
  await waitFor(page, '.export-menu [role=menuitem]', 'the Export menu');
  const first = await page.eval(() => document.activeElement?.textContent);
  expect(first === 'Haskell (.hs)', `focus on '${first}' when Export opened`);
  await page.key('Escape');
  expect(!(await exists(page, '.export-menu[open]')), 'Esc left the Export menu open');
  const back = await page.eval(() => document.activeElement?.textContent);
  expect(back === 'Export', `focus went to '${back}' after Esc`);
}

/** A phone: one pane at a time behind tabs, labels no smaller than 9 px, SHOW folded. */
async function phoneLayout(page, { url }) {
  await page.viewport(390, 844);
  await open(page, url);
  await load(page, MODEL);
  const shown = (sel) =>
    page.eval((s) => {
      const el = document.querySelector(s);
      return (
        !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
      );
    }, sel);
  expect(await shown('.tabs'), 'no pane tabs on a phone');
  expect(!(await shown('.editor-pane')), 'the editor shows beside the diagram');
  expect(await shown('.diagram-pane'), 'the diagram is not the first tab');
  expect(!(await shown('.float-controls .switch-group')), 'the SHOW panel is unfolded');
  await until(
    () =>
      page.eval(() => {
        const m = /scale\(([\d.]+)\)/.exec(
          document.querySelector('.scene-viewport').style.transform,
        );
        return !!m && Number(m[1]) >= 0.9;
      }),
    'a fit of at least 0.9 on a phone',
  );
  await clickButton(page, '.tabs', 'Code');
  expect(await shown('.editor-pane'), 'the Code tab did not show the editor');
  expect(!(await shown('.diagram-pane')), 'the diagram stayed beside the editor');
  // the stored split ratio is not a phone's business: the editor takes the width
  const w = await page.eval(
    () => document.querySelector('.editor-pane').getBoundingClientRect().width,
  );
  expect(w > 380, `the editor is ${w} px wide on a 390 px phone`);
  await clickButton(page, '.tabs', 'Diagram');
  expect(await shown('.diagram-pane'), 'the Diagram tab did not come back');
  // presenting from the Code tab shows the diagram, not a blank screen
  await clickButton(page, '.tabs', 'Code');
  await page.key('p');
  expect(await shown('.diagram-pane'), 'presenting from the Code tab shows nothing');
}

/** A reload restores the text and the pinned layout from localStorage. */
async function reloadRestores(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  await page.eval(() => document.querySelector('[data-node-id="a_a"]').focus());
  await page.key('Shift+ArrowDown');
  await settle(page);
  const pinned = nodeBox(await scene(page), 'a_a');
  await sleep(900); // past the autosave debounce
  await open(page, url);
  expect((await doc(page)) === MODEL, 'the text did not survive a reload');
  expect(sameBox(nodeBox(await scene(page), 'a_a'), pinned), 'the pin did not survive a reload');
}

/** Export .hs writes the layout block; Open .hs reads one back into positions. */
async function hsRoundTrip(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  await page.eval(() => document.querySelector('[data-node-id="a_b"]').focus());
  await page.key('Shift+ArrowUp');
  await settle(page);
  const got = await page.download(() => pickExport(page, 'hs'));
  expect(got && got.name === 'M.hs', `exported ${got?.name}`);
  const text = got.bytes.toString('utf8');
  expect(text.startsWith(MODEL), 'the export does not start with the source');
  const line = /^-- @layout a_b (-?\d+) (-?\d+)$/m.exec(text);
  expect(line, 'no layout line for a_b');
  // open it back with a_b moved 200 px right: the file's positions win
  const moved = text.replace(
    /^-- @layout a_b (-?\d+) (-?\d+)$/m,
    (_, x, y) => `-- @layout a_b ${Number(x) + 200} ${y}`,
  );
  await page.upload('.toolbar input[type=file]', 'M.hs', moved);
  await until(() => page.eval(() => !!window.__fsd.scene()), 'the opened model');
  await settle(page);
  expect((await doc(page)) === MODEL, 'Open kept the layout lines in the editor');
  const b = nodeBox(await scene(page), 'a_b');
  expect(near(b.x, Number(line[1]) + 200, 1), `a_b at x ${b.x}, want ${Number(line[1]) + 200}`);
}

/** New starts the blank model, untitled. */
async function newModel(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  await clickSelectorCenter(page, '.file-menu summary');
  await waitFor(page, '.file-menu [role=menuitem]', 'the File menu');
  await sceneChange(page, () => clickButton(page, '.file-menu', 'New'), 'the blank model');
  const text = await doc(page);
  expect(/^module Model where/.test(text) && /a_1 = |a_1 s = /.test(text), 'not the blank model');
  const picked = await page.eval(() => document.querySelector('.toolbar select').value);
  expect(picked === '', `the example picker says '${picked}'`);
}

async function a11y(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const unnamed = await page.eval(() =>
    window.__e2e
      .qa('[data-zoom],[data-node-id]')
      .filter((el) => !el.getAttribute('aria-label'))
      .map((el) => el.getAttribute('data-zoom') ?? el.getAttribute('data-node-id')),
  );
  expect(!unnamed.length, `no aria-label on: ${unnamed.join(', ')}`);

  // the menu follows the WAI-ARIA menu pattern: arrows move between items
  const c = await nodeCenter(page, 'a_a');
  await page.click(c.x, c.y, 'right');
  await waitFor(page, '[role=menu]', 'context menu on a_a');
  const focused = () => page.eval(() => document.activeElement?.textContent.trim());
  await page.key('ArrowDown');
  expect((await focused()) === 'set rates', `ArrowDown focused '${await focused()}'`);
  await page.key('ArrowUp');
  await page.key('ArrowUp');
  expect(
    (await focused()) === 'delete',
    `ArrowUp from the first item focused '${await focused()}'`,
  );
  await page.key('Escape');
  await waitGone(page, '[role=menu]');

  // Enter on a zoom button zooms, even while a node is selected
  await clickNode(page, 'a_a');
  await page.key('Escape');
  await waitGone(page, '.popover');
  const k0 = (await page.eval(() => window.__e2e.transform())).k;
  await page.eval(() => document.querySelector('[data-zoom="in"]').focus());
  await page.key('Enter');
  await settle(page);
  expect(!(await exists(page, '.popover')), 'Enter on the zoom button opened a popover');
  const k1 = (await page.eval(() => window.__e2e.transform())).k;
  expect(k1 > k0 + 1e-3, `Enter on the zoom button did not zoom in (${k0} -> ${k1})`);
}

async function pointerConflicts(page, { url }) {
  await open(page, url);
  await load(page, MODEL);

  // a pan ends in a click on the canvas; it must not act as one
  await clickNode(page, 'a_a');
  const from = await emptyPoint(page);
  await page.drag(from, { x: from.x + 60, y: from.y + 30 });
  await settle(page);
  expect(await exists(page, '.popover'), 'panning closed the popover');
  expect(await exists(page, '[data-node-id="a_a"].selected'), 'panning cleared the selection');
  // a click without travel still closes it
  const empty = await emptyPoint(page);
  await page.click(empty.x, empty.y);
  await waitGone(page, '.popover', 'a pane click to close the popover');

  // a press on a node released outside the pane must not leave a drag armed
  const r0 = await page.eval(() => window.__e2e.nodeRect('a_a'));
  const c = { x: r0.x + r0.w / 2, y: r0.y + r0.h / 2 };
  const outside = await page.box('.editor-pane');
  await page.mouseMove(c.x, c.y);
  await page.mouseDown();
  await page.mouseMove(outside.x, outside.y);
  await page.mouseUp();
  for (const [dx, dy] of [
    [0, 0],
    [20, 10],
    [40, 20],
  ])
    await page.mouseMove(c.x + dx, c.y + dy);
  await settle(page);
  const r1 = await page.eval(() => window.__e2e.nodeRect('a_a'));
  expect(
    near(r1.x, r0.x, 1) && near(r1.y, r0.y, 1),
    `node followed a released pointer by (${r1.x - r0.x}, ${r1.y - r0.y})`,
  );
}

// A consistent cycle whose delay holds 1 token where a_a needs 2: the scheduler reports a deadlock.
const MODEL_DEADLOCK = `module D where
import ForSyDe.Shallow
system s_x = s_y
  where
    s_ab = a_a s_x s_da
    (s_bd, s_y) = a_b s_ab
    s_da = d_d s_bd
a_a = actor21SDF (1, 2) 2 f
a_b = actor12SDF 1 (1, 1) g
d_d = delaySDF [0]
f :: [Int] -> [Int] -> [Int]
f [x] [y, z] = [x, y + z]
g :: [Int] -> ([Int], [Int])
g [x] = ([x], [x])
`;

// a_a -> a_b is 2:1 but the loop back is 1:1, so s_da gains a token every round.
const MODEL_INCONSISTENT = `module U where
import ForSyDe.Shallow
system s_x = s_y
  where
    (s_ab, s_y) = a_a s_x s_da
    s_bd = a_b s_ab
    s_da = d_d s_bd
a_a = actor22SDF (1, 1) (2, 1) f
a_b = actor11SDF 1 1 g
d_d = delaySDF [0]
f :: [Int] -> [Int] -> ([Int], [Int])
f [x] [y] = ([x, y], [x])
g :: [Int] -> [Int]
g [x] = [x]
`;

/** Per buffer strip: its edge, capacity (from 'buf N'), slots drawn, slots filled, bar count text. */
const strips = (page) =>
  page.eval(() => {
    const labels = new Map(window.__fsd.scene().labels.map((l) => [l.id, l]));
    return window.__e2e.qa('.buffer-strip').map((g) => {
      const l = labels.get(g.getAttribute('data-strip'));
      return {
        edge: g.getAttribute('data-owner-edge'),
        capacity: Number(/^buf (\d+)$/.exec(l?.text ?? '')?.[1] ?? NaN),
        slots: g.querySelectorAll('.fifo-slot').length,
        filled: g.querySelectorAll('.fifo-slot.filled').length,
        bar: g.querySelector('.fifo-count')?.textContent ?? null,
      };
    });
  });

/**
 * Tokens each buffer strip should show, from the trace at playback position
 * `pos`. A delay folds the signals on both sides into one buffer, whose
 * tokens the trace keeps on the signal past the last delay.
 */
const expectedFill = (page, pos) =>
  page.eval((p) => {
    const t = window.__fsd.trace();
    const counts = p === 0 ? t.initial : t.steps[p - 1].after;
    const ir = window.__fsd.ir();
    const delays = new Set(ir.processes.filter((q) => q.type === 'Delay').map((q) => q.name));
    const land = (s) => {
      for (let i = 0; i < ir.signals.length && delays.has(s.target.name); i++)
        s = ir.signals.find((o) => o.source.name === s.target.name) ?? s;
      return s;
    };
    return Object.fromEntries(
      ir.signals.map((s) => [
        `e_${s.name}_${s.source.name}_${s.target.name}`,
        counts[land(s).name],
      ]),
    );
  }, pos);

// one actor, so a one-firing period
const MODEL_ONE = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_out = a_a s_in
a_a = actor11SDF 1 1 f
f :: [Int] -> [Int]
f [x] = [x]
`;

const firing = (page) =>
  page.eval(() => window.__e2e.qa('.scene-node.firing').map((el) => el.dataset.nodeId));

const currentCell = (page) =>
  page.eval(() => window.__e2e.qa('.tl-cell').findIndex((c) => c.classList.contains('current')));

async function clickAria(page, label) {
  const at = await page.box(`.timeline [aria-label="${label}"]`);
  expect(at, `no timeline button '${label}'`);
  await page.click(at.x, at.y);
}

async function checkFill(page, pos) {
  const want = await expectedFill(page, pos);
  const got = await strips(page);
  expect(got.length > 0, 'no buffer strips drawn');
  for (const s of got)
    expect(
      s.filled === Math.min(want[s.edge], s.capacity),
      `position ${pos}: strip on ${s.edge} fills ${s.filled}, trace says ${want[s.edge]}`,
    );
}

async function simulate(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  await waitFor(page, '.timeline', 'the schedule timeline');
  const n = await page.eval(() => window.__fsd.trace().steps.length);
  expect(n === (await page.eval(() => window.__e2e.qa('.tl-cell').length)), 'one cell per firing');
  expect((await currentCell(page)) === -1, 'a step is highlighted before playing');
  await checkFill(page, 0);

  // play, then pause: the highlighted step moved and then stays put
  await clickAria(page, 'play');
  await until(async () => (await currentCell(page)) >= 0, 'playback to highlight a step', 4000);
  await clickAria(page, 'pause');
  const paused = await currentCell(page);
  await sleep(1200);
  expect((await currentCell(page)) === paused, 'the highlighted step moved after pause');

  // step by step from the start: strips follow the trace, the firing actor is marked
  await clickAria(page, 'reset');
  for (let pos = 1; pos <= n; pos++) {
    await clickAria(page, 'step forward');
    await until(async () => (await currentCell(page)) === pos - 1, `step ${pos} highlighted`, 2000);
    // strips follow the travelling tokens; at rest they show the trace
    await settle(page, `step ${pos} tokens to arrive`);
    await checkFill(page, pos);
    const actor = await page.eval((p) => window.__fsd.trace().steps[p - 1].actor, pos);
    expect(await exists(page, `[data-node-id="${actor}"].firing`), `${actor} is not .firing`);
  }
  // a full period returns every count to the start
  const start = await expectedFill(page, 0);
  for (const s of await strips(page))
    expect(s.filled === start[s.edge], `after one period ${s.edge} holds ${s.filled}`);

  // scrubbing: a click on the first cell jumps there
  const first = await page.box('.tl-cell');
  await page.click(first.x, first.y);
  await until(async () => (await currentCell(page)) === 0, 'click on a cell to select it', 2000);
  await checkFill(page, 1);

  // a re-layout of the same text (a SHOW toggle) keeps the position
  await clickAria(page, 'step forward');
  await until(async () => (await currentCell(page)) === 1, 'step 2 highlighted', 2000);
  await setFlags(page, { functions: false });
  expect((await currentCell(page)) === 1, 'a SHOW toggle moved the playback position');
  await setFlags(page, { functions: true });

  // collapsed, the timer stops with its controls
  await clickAria(page, 'play');
  await clickAria(page, 'collapse');
  await waitGone(page, '.timeline');
  const held = await firing(page);
  await sleep(1200);
  expect(
    JSON.stringify(await firing(page)) === JSON.stringify(held),
    'playback went on behind a collapsed timeline',
  );
  const chip = await page.box('.schedule-chip');
  await page.click(chip.x, chip.y);
  await waitFor(page, '.timeline', 'the timeline again');

  // an edit during playback swaps in the new period without an index past its end
  await clickAria(page, 'pause');
  const last = await page.box('.tl-cell:last-child');
  await page.click(last.x, last.y);
  await until(async () => (await currentCell(page)) === n - 1, 'the last firing', 2000);
  await clickAria(page, 'play');
  await load(page, MODEL_ONE, 'layout');
  await sleep(1200);
  const one = await page.eval(() => ({
    steps: window.__fsd.trace().steps.length,
    cells: window.__e2e.qa('.tl-cell').length,
    pos: document.querySelector('.tl-pos').textContent,
  }));
  // s_in produces, a_a fires, s_out takes: three steps
  expect(
    one.steps === 3 && one.cells === 3,
    `after the edit: ${one.cells} cells, trace ${one.steps}`,
  );
  expect(
    /^(initial state|step [1-3]\/3: .+)$/.test(one.pos),
    `after the edit the timeline says '${one.pos}'`,
  );
  await clickAria(page, 'pause');
}

async function bufferStrip(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  const problems = [];
  for (const name of await exampleNames(page)) {
    await selectExample(page, name);
    for (const s of await strips(page)) {
      if (s.capacity > 8 ? s.bar !== String(s.capacity) : s.slots !== Math.max(1, s.capacity))
        problems.push(
          `${name} ${s.edge}: buf ${s.capacity} drawn as ${s.slots} slots, bar ${s.bar}`,
        );
    }
  }
  expect(!problems.length, problems.join('\n    '));

  await load(page, MODEL);
  const d = await page.eval(() => ({
    shape: window.__fsd.scene().nodes.find((n) => n.id === 'd_d').shape,
    filled: document.querySelectorAll('[data-node-id="d_d"].kind-delay .fifo-slot.filled').length,
  }));
  expect(d.shape === 'strip', `modern delay shape is ${d.shape}`);
  expect(d.filled === 1, `delay strip fills ${d.filled} slots, want its 1 token`);
  await clickNode(page, 'd_d');
  expect(
    await page.eval(() =>
      window.__e2e.qa('.popover label.row span').some((s) => s.textContent.trim() === 'tokens'),
    ),
    'the delay strip popover has no tokens row',
  );
  await page.key('Escape');
  await waitGone(page, '.popover');

  await setStyle(page, 'lecture');
  const lecture = await page.eval(() => ({
    strips: document.querySelectorAll('.buffer-strip,.fifo-slot').length,
    texts: window.__e2e.qa('[data-label-kind="buffer"]').map((el) => el.textContent),
    delay: document.querySelector('[data-node-id="d_d"] circle.node-shape') !== null,
  }));
  expect(!lecture.strips, 'lecture style draws FIFO strips');
  expect(
    lecture.texts.length && lecture.texts.every((t) => /^·\d+$/.test(t)),
    `lecture buffer labels [${lecture.texts}]`,
  );
  expect(lecture.delay, 'lecture delay is not a circle');
}

/** The hover card's lines while the pointer is over node `id`. */
async function hoverNotes(page, id) {
  const c = await nodeCenter(page, id);
  await page.mouseMove(c.x, c.y);
  await waitFor(page, '.hover-card', `hover card on ${id}`);
  return page.eval(() => document.querySelector('.hover-card').textContent);
}

const linkedIds = (page) =>
  page.eval(() => ({
    nodes: window.__e2e
      .qa('.scene-node.linked')
      .map((el) => el.dataset.nodeId)
      .sort(),
    edges: window.__e2e
      .qa('.scene-edge.linked')
      .map((el) => el.dataset.edgeId)
      .sort(),
  }));

const editorMarks = (page) =>
  page.eval(() => window.__e2e.qa('.cm-linked').map((el) => el.textContent));

/** The editor cursor on a piece of text marks the diagram elements it is about. */
async function linkEditorToDiagram(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const cursorOn = async (needle, skip = 0) => {
    const at = MODEL.indexOf(needle) + skip;
    expect(at >= skip, `'${needle}' not in the model`);
    await page.eval((o) => window.__fsd.setCursor(o), at);
    await sleep(150);
    return linkedIds(page);
  };
  let got = await cursorOn('d_d s_1');
  expect(sameSet(got.nodes, ['d_d']) && !got.edges.length, `binding: ${JSON.stringify(got)}`);
  got = await cursorOn('s_2 = d_d');
  expect(!got.nodes.length && got.edges.length === 1, `signal: ${JSON.stringify(got)}`);
  // a function definition marks every actor applying it (f is a_a's)
  got = await cursorOn('f [x]', 2);
  expect(sameSet(got.nodes, ['a_a']), `function: ${JSON.stringify(got)}`);
  got = await cursorOn('import');
  expect(!got.nodes.length && !got.edges.length, `import: ${JSON.stringify(got)}`);
}

/** Pointing at a diagram element marks its source; Ctrl-click jumps there. */
async function linkDiagramToEditor(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  // a_a's output rate label: exactly that literal ('2' in 'actor11SDF 1 2 f')
  const rate = await page.box('[data-label-kind="rate"][data-label-id^="a_a.out."]');
  expect(rate, 'no rate label at a_a out port');
  await page.mouseMove(rate.x, rate.y);
  await until(async () => (await editorMarks(page)).length > 0, 'the rate literal marked', 2000);
  const marks = await editorMarks(page);
  expect(marks.length === 1 && marks[0] === '2', `marked [${marks}]`);
  // hovering a node marks its spec and its binding
  const c = await nodeCenter(page, 'd_d');
  await page.mouseMove(c.x, c.y);
  await until(
    async () => (await editorMarks(page)).some((t) => t.includes('delaySDF')),
    'the delay spec marked',
    2000,
  );
  const node = await editorMarks(page);
  expect(
    node.some((t) => t === 'd_d = delaySDF [0]') && node.some((t) => t === 's_2 = d_d s_1'),
    `node marks [${node}]`,
  );
  // off the diagram: nothing marked
  await page.mouseMove(5, 5);
  await until(async () => !(await editorMarks(page)).length, 'marks cleared', 2000);
  // Ctrl-click the rate label: the cursor lands on its literal, no popover
  await page.click(rate.x, rate.y, 'left', 2);
  await sleep(200);
  // the number is its own highlighted token, so the cursor's text node is the literal
  const cur = await page.eval(() => {
    const node = document.getSelection()?.anchorNode;
    const line = node?.parentElement?.closest('.cm-line')?.textContent ?? '';
    return { token: node?.textContent ?? '', line };
  });
  expect(!(await exists(page, '.popover')), 'Ctrl-click opened a popover');
  expect(
    cur.token === '2' && cur.line === 'a_a = actor11SDF 1 2 f',
    `cursor ended in '${cur.token}' on '${cur.line}'`,
  );
}

/** Typing a constructor prefix offers it; Enter writes it as a snippet with default rates. */
async function editorCompletion(page, { url }) {
  await open(page, url);
  const src = 'module M where\n\na_1 s = ';
  await page.eval((s) => window.__fsd.setSource(s), src);
  await sleep(200);
  await page.eval((o) => window.__fsd.setCursor(o), src.length);
  await page.eval(() => document.querySelector('.cm-content').focus());
  await page.type('actor21');
  await waitFor(page, '.cm-tooltip-autocomplete', 'the completion list');
  // CodeMirror ignores Enter for 75 ms after the list opens (interactionDelay)
  await sleep(150);
  await page.key('Enter');
  await sleep(150);
  const text = await doc(page);
  expect(text === src + 'actor21SDF (1, 1) 1 f', `doc after completion: ${JSON.stringify(text)}`);
}

/** Double-click `selector`, replace the in-place input's text with `text`, then press `key`. */
async function editInPlace(page, selector, text, key = 'Enter') {
  const at = await page.box(selector);
  expect(at, `nothing to double-click at ${selector}`);
  await page.dblclick(at.x, at.y);
  await waitFor(page, '.inline-edit input', `an input over ${selector}`);
  await page.eval(() => document.querySelector('.inline-edit input').select());
  await page.type(text);
  await page.key(key);
  await sleep(150);
}

/** Double-click a label, type, Enter: exactly that field changes in the source. */
async function inlineEdit(page, { url }) {
  await open(page, url);
  await setStyle(page, 'lecture');
  await load(page, MODEL);
  const rate = '[data-label-kind="rate"][data-label-id^="a_a.out."]';
  // Escape leaves the source alone
  await editInPlace(page, rate, '9', 'Escape');
  expect((await doc(page)) === MODEL, 'Escape changed the source');
  expect(!(await exists(page, '.inline-edit')), 'the input stayed after Escape');
  // an invalid rate explains itself and changes nothing
  await editInPlace(page, rate, '0');
  expect(await exists(page, '.inline-edit-error'), 'no reason shown for rate 0');
  expect((await doc(page)) === MODEL, 'an invalid rate changed the source');
  await page.key('Escape');
  // a valid one changes that literal and nothing else
  await sceneChange(page, () => editInPlace(page, rate, '3'), 'scene after the rate edit');
  expect(
    (await doc(page)) === MODEL.replace('actor11SDF 1 2 f', 'actor11SDF 1 3 f'),
    'the rate edit changed more than the literal',
  );
  // the delay's token list (its stack line in the lecture style)
  const before = await doc(page);
  await sceneChange(
    page,
    () => editInPlace(page, '[data-owner-node="d_d"] .stack-tokens', '1, 1'),
    'scene after the tokens edit',
  );
  expect((await doc(page)) === before.replace('[0]', '[1,1]'), 'the tokens edit');
  // a signal rename, from its label
  const renamed = await doc(page);
  await sceneChange(
    page,
    () => editInPlace(page, '[data-label-kind="signal"][data-owner-edge^="e_s_1_"]', 'mid'),
    'scene after the rename',
  );
  expect((await doc(page)) === renamed.replaceAll('s_1', 'mid'), 'the signal rename');
  // the modern style: the delay strip itself edits the tokens; F2 renames a node
  await setStyle(page, 'modern');
  const strip = await doc(page);
  await sceneChange(
    page,
    () => editInPlace(page, '[data-node-id="d_d"] .node-shape', '0'),
    'scene after the strip edit',
  );
  expect((await doc(page)) === strip.replace('[1,1]', '[0]'), 'the strip edit');
  await page.eval(() => document.querySelector('[data-node-id="a_b"]').focus());
  await page.key('F2');
  await waitFor(page, '.inline-edit input', 'F2 to open a rename');
  expect(
    (await page.eval(() => document.querySelector('.inline-edit input').value)) === 'a_b',
    'F2 did not start from the name',
  );
  await page.key('Escape');
}

/** Zoomed out, fine print hides (nothing moves) and the hover card lists it; zoomed back, it returns. */
async function semanticZoom(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  const state = () =>
    page.eval(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).visibility !== 'hidden' : null;
      };
      const vp = document.querySelector('.scene-viewport');
      return {
        k: Number(/scale\(([\d.]+)\)/.exec(vp.style.transform)?.[1] ?? 1),
        lod: vp.className,
        rate: vis('.label-rate'),
        name: vis('.label-name'),
        signal: vis('.label-signal'),
        strip: vis('.buffer-strip'),
      };
    });
  const zoomTo = async (below) => {
    const at = await page.box('.diagram-wrap');
    for (let i = 0; i < 40 && (await state()).k >= below; i++) await page.wheel(at.x, at.y, 240);
    await sleep(150);
  };
  const near = await state();
  expect(near.rate && near.name && near.signal && near.strip, `near: ${JSON.stringify(near)}`);
  const boxes = await scene(page);

  await zoomTo(0.55);
  const mid = await state();
  expect(/lod-mid/.test(mid.lod), `mid class: ${JSON.stringify(mid)}`);
  expect(!mid.rate && !mid.strip && mid.name && mid.signal, `mid: ${JSON.stringify(mid)}`);
  // the hover card tells what zooming out hid
  const c = await nodeCenter(page, 'a_a');
  await page.mouseMove(c.x, c.y);
  await waitFor(page, '.hover-card', 'a hover card at mid zoom');
  const card = await page.eval(() => document.querySelector('.hover-card').textContent);
  expect(/rates 1 → 2/.test(card), `mid hover card: '${card}'`);
  await page.mouseMove(5, 5);

  await zoomTo(0.3);
  const far = await state();
  expect(/lod-far/.test(far.lod) && !far.signal && far.name, `far: ${JSON.stringify(far)}`);
  // hiding moved nothing
  expect(
    JSON.stringify(await scene(page)) === JSON.stringify(boxes),
    'zooming out changed the scene',
  );

  const fit = await page.box('[data-zoom="fit"]');
  await page.click(fit.x, fit.y);
  await sleep(400);
  const back = await state();
  expect(back.rate && back.signal && back.strip, `after fit: ${JSON.stringify(back)}`);
}

// schedules nothing and leaves no stuck run to replay: a rate-2 self-loop through a delay
const MODEL_NO_SCHEDULE = `module N where
import ForSyDe.Shallow
system s_in = s_out
  where
    (s_out, s_1) = a_a s_in s_2
    s_2 = d_d s_1
a_a = actor22SDF (1, 1) (1, 2) g
d_d = delaySDF [0]
g :: [Int] -> [Int] -> ([Int], [Int])
g [x] [y] = ([x], [y, y])
`;

/** No schedule: a warning with the problems, and Animate and Schedule say why they show nothing. */
async function noScheduleWarning(page, { url }) {
  await open(page, url);
  await load(page, MODEL_NO_SCHEDULE);
  // listed with the editor's problems, as a warning that jumps to the actor at fault
  const warn = await page.eval(() => window.__e2e.qa('.error-bar .warn').map((b) => b.textContent));
  expect(
    warn.length === 1 && /^Not schedulable: .*a_a/.test(warn[0]),
    `error bar warnings [${warn}]`,
  );
  await clickSelectorCenter(page, '.error-bar .warn');
  const line = await page.eval(
    () => document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent,
  );
  expect(/^a_a = actor22SDF/.test(line ?? ''), `the warning jumped to '${line}'`);
  // Animate is not dead: it says why nothing plays
  expect(
    !(await page.eval(() => document.querySelector('.animate-button').disabled)),
    'Animate is disabled with no reason',
  );
  await clickSelectorCenter(page, '.animate-button');
  await waitFor(page, '.notice-toast', 'a toast from Animate');
  const toast = await page.eval(() => document.querySelector('.notice-toast').textContent);
  expect(/Not schedulable/.test(toast), `Animate said '${toast}'`);
  expect(!(await exists(page, '.timeline [aria-label="pause"]')), 'something started playing');
  // Schedule off, then on again: it explains itself too (once Animate's toast has gone)
  await until(
    async () => !(await exists(page, '.notice-toast')),
    "Animate's toast to expire",
    8000,
  );
  await clickButton(page, '.toolbar', 'Schedule');
  expect(!(await exists(page, '.notice-toast')), 'switching the results off made a toast');
  await clickButton(page, '.toolbar', 'Schedule');
  await waitFor(page, '.notice-toast', 'a toast from Schedule');
}

async function clickSelectorCenter(page, selector) {
  const at = await page.box(selector);
  expect(at, `nothing at ${selector}`);
  await page.click(at.x, at.y);
}

async function deadlockView(page, { url }) {
  await open(page, url);
  await load(page, MODEL_DEADLOCK);
  await waitFor(page, '.sched-banner .sched-detail', 'deadlock explanation under the banner');
  const got = await page.eval(() => ({
    waiting: window.__e2e.qa('.scene-node.waiting').map((el) => el.getAttribute('data-node-id')),
    short: window.__e2e.qa('.scene-edge.short').map((el) => el.getAttribute('data-edge-id')),
  }));
  expect(sameSet(got.waiting, ['a_a', 'a_b']), `waiting actors [${got.waiting}]`);
  expect(sameSet(got.short, ['e_s_da_d_d_a_a', 'e_s_ab_a_a_a_b']), `short buffers [${got.short}]`);
  const card = await hoverNotes(page, 'a_a');
  expect(/s_da: needs 2, has 1/.test(card), `hover on a_a says '${card}'`);
  // no schedule, but the run that gets stuck plays, and stops where it sticks
  await waitFor(page, '.timeline', 'the stuck-run timeline');
  const n = await page.eval(() => window.__fsd.trace().steps.length);
  expect(!(await page.eval(() => window.__fsd.trace().periodic)), 'a stuck run marked periodic');
  await clickAria(page, 'play');
  await until(
    async () =>
      /stuck (from here|from the start)/.test(
        await page.eval(() => document.querySelector('.tl-pos').textContent),
      ),
    'playback to reach the stuck step',
    (n + 2) * 1000,
  );
  await sleep(1200);
  expect(
    await exists(page, '.timeline [aria-label="play"]'),
    'playback kept going past the end of a stuck run',
  );
}

/** The deadlock's one-click fix edits the text, and the model then has a schedule. */
async function deadlockFix(page, { url }) {
  await open(page, url);
  await load(page, MODEL_DEADLOCK);
  await waitFor(page, '.sched-fix', 'a fix button in the deadlock banner');
  const label = await page.eval(() => document.querySelector('.sched-fix').textContent);
  expect(label === 'Give d_d 2 initial tokens', `fix says '${label}'`);
  await clickSelectorCenter(page, '.sched-fix');
  await until(() => page.eval(() => !!window.__fsd.trace()?.periodic), 'a schedule after the fix');
  expect(!(await exists(page, '.sched-banner')), 'the banner stayed after the fix');
  expect(/delaySDF \[0,0\]/.test(await doc(page)), 'the delay did not get a second token');
}

async function inconsistentView(page, { url }) {
  await open(page, url);
  await load(page, MODEL_INCONSISTENT);
  await waitFor(page, '.sched-banner .sched-detail', 'inconsistency explanation under the banner');
  const got = await page.eval(() => ({
    unbounded: window.__e2e
      .qa('.scene-edge.unbounded')
      .map((el) => el.getAttribute('data-edge-id')),
    marker: !!document.querySelector('.scene-edge.unbounded .overflow-mark'),
    line: document.querySelector('.sched-banner').textContent,
    waiting: document.querySelectorAll('.scene-node.waiting').length,
  }));
  expect(sameSet(got.unbounded, ['e_s_da_d_d_a_a']), `unbounded signals [${got.unbounded}]`);
  expect(got.marker, 'no overflow marker on the unbounded signal');
  // one verdict, in the model's names: the loop and the ratio it demands, no deadlock
  expect(
    /inconsistent rates: around the loop .*q\(a_a\) = 2·q\(a_a\)/.test(got.line) &&
      !/deadlock/i.test(got.line),
    `explanation says '${got.line}'`,
  );
  expect(got.waiting === 0, 'an inconsistent model marks waiting actors');
}

// MODEL with a_c inserted on s_1: a_c enters, d_d and a_b move right.
const MODEL_INSERTED = MODEL.replace(
  '    s_2 = d_d s_1\n',
  '    s_3 = a_c s_1\n    s_2 = d_d s_3\n',
).replace('d_d = delaySDF [0]\n', 'd_d = delaySDF [0]\na_c = actor11SDF 1 1 f\n');

// MODEL with d_d replaced by a_c: d_d exits, a_c enters.
const MODEL_SWAPPED = MODEL.replace('    s_2 = d_d s_1\n', '    s_2 = a_c s_1\n').replace(
  'd_d = delaySDF [0]\n',
  'a_c = actor11SDF 1 1 f\n',
);

const nodeBox = (s, id) => s.nodes.find((n) => n.id === id)?.box;
const sameBox = (a, b, tol = 0.5) =>
  !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol);
const strictlyBetween = (v, a, b) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5;
const fmt = (b) =>
  b ? `(${b.x.toFixed(1)}, ${b.y.toFixed(1)} ${b.w.toFixed(1)}x${b.h.toFixed(1)})` : 'none';

/**
 * Load `src` and record node `id`'s box, and whether a layout transition runs,
 * every frame: its scene box, or with `client` its box on screen.
 */
const trackEdit = (page, src, id, ms = 1200, client = false) =>
  page.eval(
    (s, i, t, c) =>
      window.__e2e.record(
        t,
        () => ({
          box: c ? window.__e2e.nodeRect(i) : window.__e2e.sceneBox(i),
          layout: window.__fsd.animating('layout'),
        }),
        () => window.__fsd.setSource(s),
      ),
    src,
    id,
    ms,
    client,
  );

// On screen, not in scene coordinates: a re-fit jumps the view and the
// transition absorbs the jump, so only the drawn path is continuous.
async function layoutTween(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const onScreen = () => page.eval(() => window.__e2e.nodeRect('a_b'));
  const old = await onScreen();
  const samples = await trackEdit(page, MODEL_INSERTED, 'a_b', 1200, true);
  await settle(page);
  const now = await onScreen();
  expect(now.x > old.x + 10, `a_b did not move right: ${fmt(old)} -> ${fmt(now)}`);
  expect(
    samples.some((f) => f.layout),
    'no layout transition ran after the edit',
  );
  const mid = samples.filter((f) => f.box && strictlyBetween(f.box.x, old.x, now.x));
  expect(mid.length >= 2, `a_b never drawn between ${fmt(old)} and ${fmt(now)}`);
  for (const f of samples)
    expect(
      f.box && f.box.x >= old.x - 0.5 && f.box.x <= now.x + 0.5,
      `a_b drawn at ${fmt(f.box)}, outside ${fmt(old)} .. ${fmt(now)}`,
    );
  const rest = await page.eval(() => window.__e2e.sceneBox('a_b'));
  const want = nodeBox(await scene(page), 'a_b');
  expect(sameBox(rest, want), `at rest a_b is drawn at ${fmt(rest)}, the scene says ${fmt(want)}`);

  // an edit mid-transition starts from the frame on screen: no jump back
  const back = await page.eval(
    (a, b) =>
      window.__e2e.record(
        900,
        () => ({ box: window.__e2e.nodeRect('a_b') }),
        () => {
          window.__fsd.setSource(a);
          setTimeout(() => window.__fsd.setSource(b), 140);
        },
      ),
    MODEL,
    MODEL_INSERTED,
  );
  await settle(page);
  const span = now.x - old.x;
  for (let i = 1; i < back.length; i++) {
    const [a, b] = [back[i - 1].box, back[i].box];
    expect(
      !a || !b || Math.abs(b.x - a.x) < span * 0.4,
      `a_b jumped from x ${a?.x.toFixed(1)} to ${b?.x.toFixed(1)} in one frame on an interrupted transition`,
    );
  }
}

async function enterExit(page, { url }) {
  await open(page, url);
  await load(page, MODEL);
  const samples = await page.eval(
    (s) =>
      window.__e2e.record(
        800,
        () => {
          const g = document.querySelector('[data-node-id="d_d"]');
          return { ghost: g ? Number(getComputedStyle(g).opacity) : null };
        },
        () => window.__fsd.setSource(s),
      ),
    MODEL_SWAPPED,
  );
  await settle(page);
  expect(
    samples.some((f) => f.ghost !== null && f.ghost > 0 && f.ghost < 1),
    'the deleted d_d never faded out',
  );
  expect(!(await exists(page, '[data-node-id="d_d"]')), 'd_d is still drawn after the transition');
  expect(
    !(await exists(page, '[data-owner-node="d_d"]')),
    'labels of d_d are still drawn after the transition',
  );
  const entered = await page.eval(() => {
    const g = document.querySelector('[data-node-id="a_c"]');
    const labels = window.__e2e.qa('[data-owner-node="a_c"]');
    return {
      node: g ? getComputedStyle(g).opacity : null,
      body: g?.querySelector('.node-body')?.getAttribute('transform') ?? null,
      labels: labels.map((l) => `${getComputedStyle(l).opacity} ${getComputedStyle(l).transform}`),
    };
  });
  expect(entered.node === '1', `a_c opacity at rest is ${entered.node}`);
  expect(entered.body === null, `a_c keeps a transform at rest: ${entered.body}`);
  expect(
    entered.labels.length && entered.labels.every((l) => l === '1 none'),
    `a_c labels at rest: [${entered.labels}]`,
  );
  const box = await page.eval(() => window.__e2e.sceneBox('a_c'));
  const want = nodeBox(await scene(page), 'a_c');
  expect(sameBox(box, want), `a_c drawn at ${fmt(box)}, its scene box is ${fmt(want)}`);
}

/** Distance from `p` to the polyline `pts`. */
function distTo(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const u = len2
      ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2))
      : 0;
    best = Math.min(best, Math.hypot(a.x + u * (b.x - a.x) - p.x, a.y + u * (b.y - a.y) - p.y));
  }
  return best;
}

async function tokenTravel(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  await waitFor(page, '.timeline', 'the schedule timeline');
  const edges = (await scene(page)).edges;

  await clickAria(page, 'play');
  const frames = await page.eval(() =>
    window.__e2e.record(2600, () => ({ tokens: window.__e2e.tokens() })),
  );
  await clickAria(page, 'pause');
  await settle(page, 'tokens to arrive');

  const seen = frames.filter((f) => f.tokens.length);
  expect(seen.length >= 5, `tokens visible in ${seen.length} of ${frames.length} frames`);
  // a token rides an edge, or crosses the gap between an edge and its buffer
  // strip, landing in a slot or leaving one
  const strips = (await scene(page)).labels
    .filter((l) => l.kind === 'buffer')
    .map((l) => {
      const e = edges.find((x) => x.id === l.owner);
      const ys = e ? e.points.map((p) => p.y) : [];
      const top = Math.min(l.box.y, ...ys);
      const bottom = Math.max(l.box.y + l.box.h, ...ys);
      return { box: l.box, corridor: { x: l.box.x, y: top, w: l.box.w, h: bottom - top } };
    });
  const inside = (t, r, pad = 2) =>
    t.x >= r.x - pad && t.x <= r.x + r.w + pad && t.y >= r.y - pad && t.y <= r.y + r.h + pad;
  let slotted = false;
  for (const f of seen)
    for (const t of f.tokens) {
      const d = Math.min(...edges.map((e) => distTo(t, e.points)));
      if (strips.some((s) => inside(t, s.box, 0))) slotted = true;
      expect(
        d <= 2 || strips.some((s) => inside(t, s.corridor)),
        `token at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}) is ${d.toFixed(1)} px off every edge and outside every strip`,
      );
    }
  expect(slotted, 'no token ever reached the inside of a buffer strip');
  // the same token, a few frames apart, has moved
  let moved = false;
  for (let i = 0; i + 3 < frames.length && !moved; i++)
    for (const t of frames[i].tokens) {
      const later = frames[i + 3].tokens.find((u) => u.id === t.id);
      if (later && Math.hypot(later.x - t.x, later.y - t.y) > 1) moved = true;
    }
  expect(moved, 'no token moved along its edge between frames');

  expect(!(await exists(page, '.token')), 'tokens left on the diagram at rest');
  await checkFill(page, (await currentCell(page)) + 1);
}

const playing = (page) => exists(page, '.timeline [aria-label="pause"]');

async function animate(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  // from a collapsed timeline: one click brings it back and plays
  const collapse = await page.box('.timeline [aria-label="collapse"]');
  if (collapse) await page.click(collapse.x, collapse.y);
  await waitFor(page, '.schedule-chip', 'the collapsed timeline');
  const btn = await page.box('.animate-button');
  expect(btn, 'no Animate button in the toolbar');
  await page.click(btn.x, btn.y);
  await waitFor(page, '.timeline', 'the timeline after Animate');
  await until(() => playing(page), 'Animate to start playback', 2000);
  expect(
    /Pause/.test(await page.eval(() => document.querySelector('.animate-button').textContent)),
    'the button does not offer Pause while playing',
  );
  // the period opens with the input producing: tokens leave the input pill
  const kinds = await page.eval(() => window.__fsd.trace().steps.map((s) => s.kind));
  expect(kinds[0] === 'input' && kinds.at(-1) === 'output', `period steps [${kinds}]`);
  await until(
    async () => (await page.eval(() => window.__e2e.tokens().length)) > 0,
    'tokens',
    3000,
  );
  const stop = await page.box('.animate-button');
  await page.click(stop.x, stop.y);
  await until(async () => !(await playing(page)), 'Pause to pause playback', 2000);

  // the tour's Animate step starts it too
  await clickAria(page, 'reset');
  await clickSelectorCenter(page, '.more-menu summary');
  await waitFor(page, '.tour-replay', 'the help menu');
  const tour = await page.box('.tour-replay');
  await page.click(tour.x, tour.y);
  // driver.js loads on demand
  await waitFor(page, '.driver-popover-title', 'the tour popover');
  for (let i = 0; i < 8 && !(await playing(page)); i++) {
    const title = await page.eval(
      () => document.querySelector('.driver-popover-title')?.textContent ?? '',
    );
    if (title === 'Animate') break;
    const next = await page.box('.driver-popover-next-btn');
    expect(next, `the tour stopped at '${title}' before the Animate step`);
    await page.click(next.x, next.y);
    await sleep(400);
  }
  await until(() => playing(page), 'the tour Animate step to start playback', 3000);
  await page.key('Escape');
}

/** Learn SDF walks the lessons, and every step points at something on screen. */
async function learnSdf(page, { url }) {
  await open(page, url);
  await clickButton(page, '.toolbar', 'Learn SDF');
  const titles = [
    'Rates',
    'Repetitions',
    'Buffers',
    'The same in matrix form',
    'Deadlock',
    'Inconsistent rates',
  ];
  for (const [i, want] of titles.entries()) {
    await until(
      () =>
        page
          .eval(() => document.querySelector('.driver-popover-title')?.textContent ?? '')
          .then((t) => t === want),
      `learn step ${i + 1} '${want}'`,
      5000,
    );
    const pointed = await page.eval(() => {
      const el = document.querySelector('.driver-active-element');
      const r = el?.getBoundingClientRect();
      return !!r && r.width + r.height > 0; // a straight edge has no height
    });
    expect(pointed, `learn step '${want}' points at nothing`);
    const next = await page.box('.driver-popover-next-btn');
    await page.click(next.x, next.y);
  }
  await until(async () => !(await exists(page, '.driver-popover')), 'the walk to end');
  expect(/module Lesson06/.test(await doc(page)), 'the walk did not end on lesson 6');
}

async function reducedMotion(page, { url }) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  const old = nodeBox(await scene(page), 'a_b');
  const samples = await trackEdit(page, MODEL_INSERTED, 'a_b', 600);
  await settle(page);
  const now = nodeBox(await scene(page), 'a_b');
  expect(!samples.some((f) => f.layout), 'a layout transition ran with reduced motion');
  for (const f of samples)
    expect(
      sameBox(f.box, old) || sameBox(f.box, now),
      `a_b drawn at ${fmt(f.box)}, neither ${fmt(old)} nor ${fmt(now)}`,
    );
  expect(sameBox(samples.at(-1).box, now), 'the final scene is not on screen');

  await waitFor(page, '.timeline', 'the schedule timeline');
  await clickAria(page, 'play');
  const frames = await page.eval(() =>
    window.__e2e.record(2000, () => ({
      tokens: document.querySelectorAll('.token').length,
      cell: window.__e2e.qa('.tl-cell').findIndex((c) => c.classList.contains('current')),
    })),
  );
  await clickAria(page, 'pause');
  expect(
    frames.some((f) => f.cell >= 0),
    'playback did not advance',
  );
  expect(!frames.some((f) => f.tokens), 'tokens travelled with reduced motion');
  await settle(page);
  await checkFill(page, (await currentCell(page)) + 1);
}

/**
 * Frame pacing while an animation of `kind` runs, started by loading `src`
 * or clicking `click`: the mean rAF delta, and the time the app's own rAF
 * callbacks take per frame (in case headless throttles rAF).
 */
const pacing = (page, kind, ms, { src, click }) =>
  page.eval(
    (k, t, s, c) => {
      const cost = new Map();
      const raw = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) =>
        raw.call(window, (now) => {
          const t0 = performance.now();
          cb(now);
          cost.set(now, (cost.get(now) ?? 0) + performance.now() - t0);
        });
      const start = () => (s ? window.__fsd.setSource(s) : document.querySelector(c).click());
      return window.__e2e
        .record(t, () => ({ on: window.__fsd.animating(k) }), start)
        .then((frames) => {
          window.requestAnimationFrame = raw;
          const on = frames.filter((f) => f.on).map((f) => f.t);
          const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
          const costs = on.map((f) => cost.get(f) ?? 0);
          // deltas within a run of animated frames, not across the idle gap between steps
          const deltas = frames
            .slice(1)
            .filter((f, i) => f.on && frames[i].on)
            .map((f) => f.t - frames[frames.indexOf(f) - 1].t);
          return {
            frames: on.length,
            delta: avg(deltas),
            cost: avg(costs),
            worst: Math.max(0, ...costs),
          };
        });
    },
    kind,
    ms,
    src ?? null,
    click ?? null,
  );

async function frameRate(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  const tween = await pacing(page, 'layout', 600, { src: MODEL_INSERTED });
  await settle(page);
  await waitFor(page, '.timeline', 'the schedule timeline');
  const play = await pacing(page, 'tokens', 2600, { click: '.timeline [aria-label="play"]' });
  await clickAria(page, 'pause');
  await settle(page);
  const f = (v) => v.toFixed(2);
  for (const [what, m] of [
    ['layout transition', tween],
    ['token travel', play],
  ]) {
    expect(m.frames >= 5, `${what}: only ${m.frames} animated frames`);
    expect(
      m.delta < 20 || m.cost < 4,
      `${what}: ${f(m.delta)} ms between frames, ${f(m.cost)} ms (worst ${f(m.worst)}) in animation callbacks per frame`,
    );
  }
  console.log(
    `    frame pacing: layout ${f(tween.delta)} ms/frame, ${f(tween.cost)} ms work; tokens ${f(play.delta)} ms/frame, ${f(play.cost)} ms work`,
  );
}

/**
 * Actions taken while something moves see the settled scene: a popover opened
 * mid-transition hangs from where its node lands, Export PNG waits until the
 * diagram is still, and a speed change lets the tokens in flight finish.
 */
async function midAnimation(page, { url }) {
  await open(page, url);
  await setStyle(page, 'modern');
  await load(page, MODEL);
  // loads `src` (else plays), resolves `frames` animation frames into the next `kind` motion
  const into = (kind, frames, src) =>
    page.eval(
      (k, n, src) =>
        new Promise((done) => {
          if (src) window.__fsd.setSource(src);
          else document.querySelector('.timeline [aria-label="play"]')?.click();
          let idle = false;
          const poll = () => {
            const on = window.__fsd.animating(k);
            idle ||= !on;
            if (idle && on && --n <= 0) done();
            else requestAnimationFrame(poll);
          };
          poll();
        }),
      kind,
      frames,
      src ?? null,
    );

  // popover: click a_b on its way right
  await into('layout', 3, MODEL_INSERTED);
  const c = await nodeCenter(page, 'a_b');
  await page.eval(() =>
    document.addEventListener(
      'click',
      () => (window.__midClick = window.__fsd.animating('layout')),
      { capture: true, once: true },
    ),
  );
  await page.click(c.x, c.y);
  await waitFor(page, '.popover', 'popover for a_b');
  await settle(page);
  const pop = await page.eval(() => {
    const el = document.querySelector('.popover');
    const p = el.getBoundingClientRect();
    const n = document.querySelector('[data-node-id="a_b"]').getBoundingClientRect();
    const pane = el.offsetParent;
    // the popover is kept 8 px (POPOVER_MARGIN) inside the pane
    const maxX = pane.getBoundingClientRect().x + pane.clientWidth - el.offsetWidth - 8;
    const ax = Math.min(n.x + n.width / 2, maxX);
    return { mid: window.__midClick, x: p.x, y: p.y, ax, ay: n.bottom };
  });
  expect(pop.mid, 'the click on a_b came after the layout transition');
  expect(
    Math.abs(pop.x - pop.ax) <= 1 && Math.abs(pop.y - pop.ay) <= 1,
    `popover at (${pop.x.toFixed(1)}, ${pop.y.toFixed(1)}), a_b hangs it at (${pop.ax.toFixed(1)}, ${pop.ay.toFixed(1)})`,
  );
  await page.key('Escape');
  await waitGone(page, '.popover');

  // Export PNG: the exporter clones the live svg; record what that clone holds
  await page.eval(() => {
    window.__clones = [];
    const raw = SVGSVGElement.prototype.cloneNode;
    SVGSVGElement.prototype.cloneNode = function (deep) {
      if (this.classList.contains('scene-svg'))
        window.__clones.push({
          moving: window.__fsd.animating(),
          moved: this.querySelectorAll('.node-body[transform]').length,
          tokens: this.querySelectorAll('.token').length,
          nodes: this.querySelectorAll('[data-node-id]').length,
          want: window.__fsd.scene().nodes.length,
        });
      return raw.call(this, deep);
    };
  });
  const exportNow = async (n) => {
    await pickExport(page, 'png');
    await until(() => page.eval((k) => window.__clones.length >= k, n), `export ${n}`, 5000);
  };
  // a_c exits and a_b moves back
  await into('layout', 3, MODEL);
  await exportNow(1);
  await settle(page);
  await waitFor(page, '.timeline', 'the schedule timeline');
  await into('tokens', 2);
  await exportNow(2);
  for (const [what, k] of [
    ['a layout transition', 0],
    ['token travel', 1],
  ]) {
    const got = await page.eval((i) => window.__clones[i], k);
    expect(
      !got.moving && !got.moved && !got.tokens && got.nodes === got.want,
      `export during ${what} captured ${JSON.stringify(got)}`,
    );
  }

  // speed: the dots in flight keep going
  await into('tokens', 2);
  const kept = await page.eval(
    () =>
      new Promise((done) => {
        const dots = [...document.querySelectorAll('.token')];
        document.querySelector('.tl-speed button[aria-pressed="false"]').click();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => done(dots.length && dots.every((d) => d.isConnected))),
        );
      }),
  );
  await clickAria(page, 'pause');
  expect(kept, 'a speed change restarted the token travel');
  await settle(page);
}

/** Run order; names are the CLI filter. */
export const scenarios = {
  render,
  overlap,
  insertOnEdge,
  nodePopover,
  contextMenus,
  paletteDrag,
  dragConnect,
  keyboard,
  panZoom,
  showFlags,
  stale,
  exportPng,
  exportFormats,
  nodeDrag,
  pinAndTidy,
  arrowKeys,
  presentMode,
  phoneLayout,
  toolbarRow,
  learnSdf,
  reloadRestores,
  hsRoundTrip,
  newModel,
  a11y,
  pointerConflicts,
  simulate,
  bufferStrip,
  deadlockView,
  noScheduleWarning,
  linkEditorToDiagram,
  linkDiagramToEditor,
  editorCompletion,
  inlineEdit,
  semanticZoom,
  inconsistentView,
  deadlockFix,
  layoutTween,
  enterExit,
  tokenTravel,
  animate,
  reducedMotion,
  frameRate,
  midAnimation,
};
