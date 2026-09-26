import { splitSubscript } from '../diagram/labels';
import { FIFO, LABEL_FONTS } from '../scene/measure';
import type { DiagramStyle, Pt, Rect, Scene, SceneLabel, SceneNode } from '../scene/types';
import { frameOf, TITLE_H } from '../render/SceneShapes';

/**
 * The scene as plain TikZ, in the black-and-white look of the lecture notes
 * (forsyde-latex figures). Coordinates stay in scene pixels: the picture
 * scales them with x = 0.75pt and y = -0.75pt (1 px = 0.75 pt, y up), so every
 * shape sits exactly where the layout put it.
 */

const PT = 0.75;
const PORT_R = 1.5;

const n = (v: number) => String(Math.round(v * 100) / 100);
const at = (p: Pt) => `(${n(p.x)},${n(p.y)})`;

/** Escape text for LaTeX text mode. */
export function texText(s: string): string {
  return s.replace(/[\\{}#$%&~_^]/g, (c) =>
    c === '\\'
      ? '\\textbackslash{}'
      : c === '~'
        ? '\\textasciitilde{}'
        : c === '^'
          ? '\\textasciicircum{}'
          : `\\${c}`,
  );
}

/** An identifier in math mode, the part after the first underscore as its subscript. */
function mathIdent(name: string): string {
  const m = (s: string) => s.replace(/_/g, '\\_');
  const parts = splitSubscript(name);
  return parts ? `$${m(parts[0])}_{${m(parts[1])}}$` : `$\\mathit{${m(name)}}$`;
}

/** A label's text as TikZ node content. */
function content(l: SceneLabel, style: DiagramStyle): string {
  switch (l.kind) {
    case 'name':
    case 'signal':
      return mathIdent(l.text);
    case 'badge':
      return `$\\times ${texText(l.text.replace(/^×/, ''))}$`;
    case 'buffer': {
      const k = /\d+/.exec(l.text)?.[0] ?? '';
      return style === 'lecture' ? `$\\cdot ${k}$` : `buf ${k}`;
    }
    case 'stack':
      return l.text
        .split('\n')
        .map((line) => `\\textit{${texText(line)}}`)
        .join('\\\\');
    case 'rate':
    case 'index':
      return texText(l.text);
  }
}

/** Font for a label kind, sized like the live diagram. */
function font(style: DiagramStyle, l: SceneLabel): string {
  const f = LABEL_FONTS[style][l.kind];
  const size = f.size * PT;
  return `\\fontsize{${n(size)}pt}{${n(f.lineHeight * PT)}pt}\\selectfont${f.weight >= 600 ? '\\bfseries' : ''}`;
}

function shape(nd: SceneNode, tokens: number): string[] {
  const b = nd.box;
  const r = Math.min(b.w, b.h) / 2;
  const box = `${at(b)} rectangle ${at({ x: b.x + b.w, y: b.y + b.h })}`;
  if (nd.shape === 'circle')
    return [
      `\\draw[fill=white] ${at({ x: b.x + b.w / 2, y: b.y + b.h / 2 })} circle[radius=${n(r)}];`,
    ];
  if (nd.shape === 'strip')
    return [
      `\\draw[rounded corners=${n(3 * PT)}pt, fill=white] ${box};`,
      ...slots(b, tokens, tokens),
    ];
  const fill = nd.kind === 'io' ? 'black!5' : 'white';
  return [`\\draw[rounded corners=${n(r * PT)}pt, fill=${fill}] ${box};`];
}

/** FIFO slots of a strip at `b` (geometry as in FIFO), the first `filled` filled. */
function slots(b: Rect, capacity: number, filled: number): string[] {
  const { SLOT_W, SLOT_H, GAP, PAD, MAX_SLOTS, BAR_W } = FIFO;
  const y = b.y + (b.h - (2 * PAD + SLOT_H)) / 2 + PAD;
  if (capacity > MAX_SLOTS)
    return [
      `\\draw ${at({ x: b.x + PAD, y })} rectangle ${at({ x: b.x + PAD + BAR_W, y: y + SLOT_H })};`,
      `\\node[anchor=west, font=\\fontsize{${n(10 * PT)}pt}{${n(12 * PT)}pt}\\selectfont] at ${at({ x: b.x + PAD + BAR_W + GAP, y: y + SLOT_H / 2 })} {${capacity}};`,
    ];
  return Array.from({ length: Math.max(1, capacity) }, (_, i) => {
    const x = b.x + PAD + i * (SLOT_W + GAP);
    const fill = i < filled ? 'black!70' : 'white';
    return `\\draw[fill=${fill}, rounded corners=${n(1.5 * PT)}pt] ${at({ x, y })} rectangle ${at({ x: x + SLOT_W, y: y + SLOT_H })};`;
  });
}

export interface TikzContext {
  style: DiagramStyle;
  /** Initial token count per delay, for a strip delay. */
  tokens: Map<string, number>;
}

/** Only the tikzpicture environment, for pasting into a document that loads TikZ and arrows.meta. */
export function tikzPicture(scene: Scene, ctx: TikzContext): string {
  const out: string[] = [
    '\\begin{tikzpicture}[x=0.75pt, y=-0.75pt, line width=0.6pt, every node/.style={inner sep=0pt, outer sep=0pt}]',
  ];
  const f = frameOf(scene.bounds);
  out.push(
    `\\draw[dashed, black!50] ${at({ x: f.x, y: f.y + TITLE_H })} rectangle ${at({ x: f.x + f.w, y: f.y + f.h })};`,
    `\\node[black!60, font=\\fontsize{${n(12 * PT)}pt}{${n(14 * PT)}pt}\\selectfont] at ${at({ x: f.x + f.w / 2, y: f.y + TITLE_H / 2 })} {System};`,
  );
  for (const e of scene.edges)
    out.push(`\\draw[-{Stealth[length=5pt, width=4pt]}] ${e.points.map(at).join(' -- ')};`);
  for (const nd of scene.nodes) {
    out.push(...shape(nd, ctx.tokens.get(nd.id) ?? 0));
    if (nd.kind === 'io')
      out.push(
        `\\node[font=${font(ctx.style, { kind: 'stack' } as SceneLabel)}] at ${at({ x: nd.box.x + nd.box.w / 2, y: nd.box.y + nd.box.h / 2 })} {${mathIdent(nd.id)}};`,
      );
    for (const p of nd.ports) out.push(`\\fill ${at(p.at)} circle[radius=${PORT_R}];`);
  }
  for (const l of scene.labels) {
    // the modern style draws a buffer as its FIFO strip, the lecture style as text
    if (l.kind === 'buffer' && ctx.style === 'modern') {
      const cap = Number(/\d+/.exec(l.text)?.[0] ?? 0);
      out.push(
        `\\draw[rounded corners=${n(3 * PT)}pt] ${at(l.box)} rectangle ${at({ x: l.box.x + l.box.w, y: l.box.y + l.box.h })};`,
      );
      out.push(...slots(l.box, cap, 0));
      continue;
    }
    const c = { x: l.box.x + l.box.w / 2, y: l.box.y + l.box.h / 2 };
    const align = l.kind === 'stack' ? ', align=center' : '';
    out.push(`\\node[font=${font(ctx.style, l)}${align}] at ${at(c)} {${content(l, ctx.style)}};`);
  }
  out.push('\\end{tikzpicture}');
  return out.join('\n');
}

/** A standalone LaTeX document that compiles to the diagram alone. */
export function sceneToTikz(scene: Scene, ctx: TikzContext): string {
  return [
    '\\documentclass[tikz, border=4pt]{standalone}',
    '\\usetikzlibrary{arrows.meta}',
    '\\begin{document}',
    tikzPicture(scene, ctx),
    '\\end{document}',
    '',
  ].join('\n');
}
