import { animating } from '../render/animate';
import { frameOf } from '../render/SceneShapes';
import type { Rect } from '../scene/types';

/**
 * The live diagram as a standalone SVG document. It is a copy of what is on
 * screen rather than a second renderer: the SVG layer is cloned with its
 * computed paint inlined (so both themes and both styles come out as drawn,
 * and the file needs no stylesheet), and each HTML label becomes SVG text at
 * the place the browser laid it out. Viewers without the app's fonts fall
 * back to their own, so text widths can differ slightly.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = 8;
/** A subscript's drop and size; dy rather than baseline-shift, which some viewers ignore. */
const SUB_DY = '0.3em';
const SUB_SIZE = '75%';

/** Paint and text properties worth keeping; everything else follows from attributes. */
const PAINT = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linejoin',
  'stroke-linecap',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
] as const;

/** Interaction chrome that is not part of the figure. */
const DROP = '.edge-hit, .new-input-handle, .io-handle, .token-layer, .overflow-mark title, title';

/** Transient states that must not end up in a figure; a zoomed-out level of detail neither. */
const TRANSIENT = [
  'selected',
  'hover',
  'linked',
  'drop-target',
  'just-added',
  'lod-mid',
  'lod-far',
];

const hidden = (cs: CSSStyleDeclaration) =>
  cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;

/** Copy `src`'s computed paint onto its clone `dst`, dropping chrome and hidden elements. */
function inlinePaint(src: Element, dst: Element) {
  // decided on the live element: the clone loses its classes on the way
  if (src.matches(DROP) || hidden(getComputedStyle(src))) {
    dst.remove();
    return;
  }
  const cs = getComputedStyle(src);
  const style = PAINT.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
  dst.setAttribute('style', style);
  dst.removeAttribute('class');
  const kids = [...src.children];
  const copies = [...dst.children];
  kids.forEach((k, i) => copies[i] && inlinePaint(k, copies[i]!));
}

/** Scene coordinates of a client rect, through the SVG layer's own mapping. */
function toScene(svg: SVGSVGElement, frame: Rect) {
  const r = svg.getBoundingClientRect();
  const kx = frame.w / r.width;
  const ky = frame.h / r.height;
  return (c: DOMRect) => ({
    x: frame.x + (c.left - r.left) * kx,
    y: frame.y + (c.top - r.top) * ky,
    w: c.width * kx,
    h: c.height * ky,
    k: kx,
  });
}

/** One label line as SVG text: its text runs, subscripts as shifted tspans. */
function lineText(el: Element, map: ReturnType<typeof toScene>): SVGTextElement | null {
  const range = document.createRange();
  range.selectNodeContents(el);
  const box = range.getBoundingClientRect();
  if (!box.width || !el.textContent?.trim()) return null;
  const at = map(box);
  const cs = getComputedStyle(el);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(at.x));
  t.setAttribute('y', String(at.y + at.h / 2));
  t.setAttribute('dominant-baseline', 'central');
  t.setAttribute(
    'style',
    `fill:${cs.color};font-family:${cs.fontFamily};font-size:${parseFloat(cs.fontSize) * at.k}px;font-weight:${cs.fontWeight};font-style:${cs.fontStyle}`,
  );
  // a subscript drops by dy and the run after it climbs back; dy is in the
  // run's own font size, so the climb is scaled back by the subscript's size
  let lowered = false;
  for (const node of el.childNodes) {
    const s = document.createElementNS(SVG_NS, 'tspan');
    s.textContent = node.textContent;
    const sub = node instanceof HTMLElement && node.tagName === 'SUB';
    if (sub) {
      s.setAttribute('dy', SUB_DY);
      s.setAttribute('font-size', SUB_SIZE);
    } else if (lowered) s.setAttribute('dy', `-${parseFloat(SUB_DY) * 0.75}em`);
    lowered = sub;
    t.appendChild(s);
  }
  return t;
}

/** Wait for a running layout transition or token travel to finish (at most `ms`). */
async function settled(ms = 1500) {
  const t0 = performance.now();
  while (animating() && performance.now() - t0 < ms)
    await new Promise((r) => requestAnimationFrame(r));
}

/**
 * Export the diagram in `wrap` (the .diagram-wrap element). `bounds` is the
 * scene bounds, which the SVG layer frames with its boundary box.
 */
export async function sceneToSvg(wrap: HTMLElement, bounds: Rect): Promise<string> {
  await settled();
  const svg = wrap.querySelector<SVGSVGElement>('.scene-svg');
  if (!svg) throw new Error('no diagram to export');
  // figures carry no hover or selection highlights
  const cleared: [Element, string][] = [];
  for (const c of TRANSIENT)
    for (const el of wrap.querySelectorAll(`.${c}`)) {
      el.classList.remove(c);
      cleared.push([el, c]);
    }
  try {
    const frame = frameOf(bounds);
    // a margin, so the boundary's stroke is not cut in half at the page edge
    const page = {
      x: frame.x - MARGIN,
      y: frame.y - MARGIN,
      w: frame.w + 2 * MARGIN,
      h: frame.h + 2 * MARGIN,
    };
    const out = svg.cloneNode(true) as SVGSVGElement;
    inlinePaint(svg, out);
    out.removeAttribute('style');
    out.setAttribute('xmlns', SVG_NS);
    out.setAttribute('width', String(page.w));
    out.setAttribute('height', String(page.h));
    out.setAttribute('viewBox', `${page.x} ${page.y} ${page.w} ${page.h}`);
    // the page background, so the figure reads the same on any viewer
    const bg = document.createElementNS(SVG_NS, 'rect');
    Object.entries({ x: page.x, y: page.y, width: page.w, height: page.h }).forEach(([k, v]) =>
      bg.setAttribute(k, String(v)),
    );
    bg.setAttribute('fill', getComputedStyle(wrap).backgroundColor || '#fff');
    out.insertBefore(bg, out.firstChild);

    const map = toScene(svg, frame);
    const labels = document.createElementNS(SVG_NS, 'g');
    labels.setAttribute('class', 'labels');
    const layer = wrap.querySelector('.scene-labels');
    for (const el of layer?.children ?? []) {
      if (hidden(getComputedStyle(el))) continue;
      const lines = el.querySelectorAll('.stack-line');
      for (const line of lines.length ? [...lines] : [el]) {
        if (hidden(getComputedStyle(line))) continue;
        const t = lineText(line, map);
        if (t) labels.appendChild(t);
      }
    }
    out.appendChild(labels);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(out)}`;
  } finally {
    for (const [el, c] of cleared) el.classList.add(c);
  }
}

/** Rasterize an SVG document at `scale` times its size. */
export async function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(img.naturalWidth * scale);
    canvas.height = Math.ceil(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('png encoding failed'))),
        'image/png',
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Hand a file to the browser's download. */
export function download(data: Blob | string, filename: string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
