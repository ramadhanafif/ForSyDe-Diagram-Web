import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateMeasure } from '../../src/scene/measure';
import type { LabelKind, LayoutInput, Scene } from '../../src/scene/types';
import { OUT_DIR } from './evaluate';
import { DEFAULT_FLAGS, loadFixtures } from './fixtures';

const PAD = 20;
const LABEL_COLOR: Record<LabelKind, string> = {
  name: '#1f2328',
  badge: '#0969da',
  stack: '#656d76',
  signal: '#9a3412',
  rate: '#0f766e',
  buffer: '#7c3aed',
  index: '#656d76',
};
const FONT_SIZE: Record<LabelKind, number> = {
  name: 14,
  badge: 10,
  stack: 12,
  signal: 13,
  rate: 10.5,
  buffer: 10,
  index: 10,
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** Debug drawing of a scene: shapes, ports, routed edges, label boxes with text, bounds. */
export function sceneToSvg(scene: Scene): string {
  const b = scene.bounds;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n2(b.x - PAD)} ${n2(b.y - PAD)} ${n2(b.w + 2 * PAD)} ${n2(b.h + 2 * PAD)}" width="${n2(b.w + 2 * PAD)}" height="${n2(b.h + 2 * PAD)}" font-family="DejaVu Sans, sans-serif">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#444"/></marker></defs>',
    `<rect x="${n2(b.x - PAD)}" y="${n2(b.y - PAD)}" width="${n2(b.w + 2 * PAD)}" height="${n2(b.h + 2 * PAD)}" fill="#fff"/>`,
    `<rect x="${n2(b.x)}" y="${n2(b.y)}" width="${n2(b.w)}" height="${n2(b.h)}" fill="none" stroke="#bbb" stroke-dasharray="4 3"/>`,
  ];
  for (const n of scene.nodes) {
    const { x, y, w, h } = n.box;
    const fill = n.kind === 'actor' ? '#dbeafe' : n.kind === 'delay' ? '#fef3c7' : '#eef1f4';
    out.push(
      `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="none" stroke="#ddd" stroke-dasharray="2 2"/>`,
      n.shape === 'circle'
        ? `<circle cx="${n2(x + w / 2)}" cy="${n2(y + h / 2)}" r="${n2(Math.min(w, h) / 2)}" fill="${fill}" stroke="#555"/>`
        : `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(Math.min(w, h) / 2)}" fill="${fill}" stroke="#555"/>`,
    );
    // io nodes carry their name inside the pill; it is not a scene label
    if (n.kind === 'io')
      out.push(
        `<text x="${n2(x + w / 2)}" y="${n2(y + h / 2 + 4)}" font-size="11" text-anchor="middle" fill="#555">${esc(n.id)}</text>`,
      );
  }
  for (const e of scene.edges) {
    const pts = e.points.map((p) => `${n2(p.x)},${n2(p.y)}`).join(' ');
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${e.feedback ? '#b45309' : '#444'}" stroke-width="1.25" marker-end="url(#arrow)"/>`,
    );
  }
  for (const n of scene.nodes)
    for (const p of n.ports)
      out.push(
        `<circle cx="${n2(p.at.x)}" cy="${n2(p.at.y)}" r="2.5" fill="${p.dir === 'in' ? '#0969da' : '#cf222e'}"/>`,
      );
  for (const l of scene.labels) {
    const { x, y, w, h } = l.box;
    const c = LABEL_COLOR[l.kind];
    const fs = FONT_SIZE[l.kind];
    const lines = l.text.split('\n');
    const lh = h / lines.length;
    out.push(
      `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="none" stroke="${c}" stroke-width="0.5"/>`,
      ...lines.map(
        (t, i) =>
          `<text x="${n2(x)}" y="${n2(y + i * lh + lh * 0.8)}" font-size="${fs}" fill="${c}"${l.kind === 'badge' ? ' font-weight="bold"' : ''}>${esc(t)}</text>`,
      ),
    );
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

/** Write layout-out/<name>/<fixture>.svg for every fixture with DEFAULT_FLAGS. */
export async function dumpScenes(
  name: string,
  layout: (input: LayoutInput) => Scene | Promise<Scene>,
): Promise<void> {
  const dir = join(OUT_DIR, name);
  mkdirSync(dir, { recursive: true });
  for (const fx of loadFixtures()) {
    const scene = await layout({
      ir: fx.ir,
      schedule: fx.schedule,
      flags: DEFAULT_FLAGS,
      measure: estimateMeasure,
    });
    writeFileSync(join(dir, `${fx.name}.svg`), sceneToSvg(scene));
  }
}
