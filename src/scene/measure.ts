import type { DiagramStyle, LabelKind, Measure } from './types';

/**
 * Font per label kind for the estimate: the larger size of the two styles in
 * LABEL_FONTS, bold for badge, rate and buffer. A modern name (13 px at 600)
 * is 2% wider than the 14 px regular estimate in DejaVu; the system UI fonts
 * are narrower than DejaVu, which absorbs it.
 */
const FONT: Record<LabelKind, { size: number; bold: boolean; lineHeight: number }> = {
  name: { size: 14, bold: false, lineHeight: 17.5 },
  badge: { size: 10, bold: true, lineHeight: 12.5 },
  stack: { size: 12, bold: false, lineHeight: 14 },
  signal: { size: 13, bold: false, lineHeight: 16.25 },
  rate: { size: 10.5, bold: true, lineHeight: 13.125 },
  buffer: { size: 10, bold: true, lineHeight: 12.5 },
  index: { size: 10, bold: false, lineHeight: 12.5 },
};

// Advance widths in em, DejaVu Sans rounded up to 0.05. DejaVu is the widest of
// the sans fonts a Linux browser falls back to (Noto Sans, Liberation Sans are
// narrower), so the estimate errs toward reserving too much space. A flat
// 0.6 em per char underestimates identifiers like 'map' by 17%.
const WIDTH_GROUPS: [number, string][] = [
  [0.3, "'IJijl"],
  [0.35, ' ,./:;\\|·'],
  [0.4, '()-[]ft'],
  [0.45, '!r'],
  [0.5, '"*_`'],
  [0.55, '?csz'],
  [0.6, 'FLkvxy'],
  [0.65, '$0123456789EPSTYabdeghnopqu{}'],
  [0.7, 'ABCKRVXZ'],
  [0.75, 'NU'],
  [0.8, '&DGHOQ'],
  [0.85, '#+<=>^w~×'],
  [0.9, 'M⊥'],
  [1, '%@Wm'],
];
const CHAR_EM = new Map(WIDTH_GROUPS.flatMap(([w, chars]) => [...chars].map((c) => [c, w])));
/** Unknown glyphs (non-Latin, symbols): a full em, again erring wide. */
const UNKNOWN_EM = 1;
/** DejaVu Sans Bold is 5 to 10% wider than regular. */
const BOLD_FACTOR = 1.1;

function lineEm(line: string): number {
  let em = 0;
  for (const c of line) em += CHAR_EM.get(c) ?? UNKNOWN_EM;
  return em;
}

/** Deterministic text size estimate; multi-line text is split on '\n'. */
export const estimateMeasure: Measure = (text, kind) => {
  const f = FONT[kind];
  const lines = text.split('\n');
  const em = Math.max(...lines.map(lineEm));
  return { w: em * f.size * (f.bold ? BOLD_FACTOR : 1), h: lines.length * f.lineHeight };
};

export interface LabelFont {
  size: number;
  weight: number;
  italic: boolean;
  family: string;
  lineHeight: number;
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, sans-serif';
const SERIF = "'Latin Modern Roman', 'Computer Modern', Georgia, serif";

/**
 * What the renderer draws each label kind in, per diagram style: modern after
 * the .diagram-modern rules of src/diagram/theme.css, lecture after the TikZ
 * figure style. The renderer sets these fonts and the layout measures with
 * them, so a label box always fits its drawn text.
 */
export const LABEL_FONTS: Record<DiagramStyle, Record<LabelKind, LabelFont>> = {
  modern: {
    name: { size: 13, weight: 600, italic: false, family: SANS, lineHeight: 16.25 },
    badge: { size: 10, weight: 700, italic: false, family: SANS, lineHeight: 12.5 },
    stack: { size: 11, weight: 400, italic: false, family: SANS, lineHeight: 14 },
    signal: { size: 11.5, weight: 500, italic: false, family: SANS, lineHeight: 14.375 },
    rate: { size: 10, weight: 600, italic: false, family: SANS, lineHeight: 12.5 },
    buffer: { size: 10, weight: 600, italic: false, family: SANS, lineHeight: 12.5 },
    index: { size: 10, weight: 400, italic: false, family: SANS, lineHeight: 12.5 },
  },
  lecture: {
    name: { size: 14, weight: 400, italic: true, family: SERIF, lineHeight: 17.5 },
    badge: { size: 10, weight: 700, italic: false, family: SERIF, lineHeight: 12.5 },
    stack: { size: 12, weight: 400, italic: true, family: SERIF, lineHeight: 14 },
    signal: { size: 13, weight: 400, italic: true, family: SERIF, lineHeight: 16.25 },
    rate: { size: 10.5, weight: 400, italic: true, family: SERIF, lineHeight: 13.125 },
    buffer: { size: 10, weight: 400, italic: false, family: SERIF, lineHeight: 12.5 },
    index: { size: 10, weight: 400, italic: false, family: SERIF, lineHeight: 12.5 },
  },
};

/** CSS/canvas font shorthand for a label kind in a style. */
export function labelFont(style: DiagramStyle, kind: LabelKind): string {
  const f = LABEL_FONTS[style][kind];
  return `${f.italic ? 'italic ' : ''}${f.weight} ${f.size}px ${f.family}`;
}

/**
 * FIFO strip of the modern style, drawn for a buffer label (capacity) and a
 * delay node (initial tokens): slot i spans x = PAD + i * (SLOT_W + GAP),
 * y = PAD, SLOT_W x SLOT_H. Above MAX_SLOTS the strip is a BAR_W x SLOT_H bar
 * at (PAD, PAD) and the count, in the buffer label font, GAP right of it.
 */
export const FIFO = { SLOT_W: 8, SLOT_H: 10, GAP: 2, PAD: 2, MAX_SLOTS: 8, BAR_W: 16 } as const;

/**
 * Strip size for n tokens; countW is the width of String(n) in the buffer
 * font, used above MAX_SLOTS only. An empty strip keeps one slot's room.
 */
export function fifoSize(n: number, countW: number): { w: number; h: number } {
  const { SLOT_W, SLOT_H, GAP, PAD, MAX_SLOTS, BAR_W } = FIFO;
  const k = Math.max(1, n);
  const inner = n > MAX_SLOTS ? BAR_W + GAP + countW : k * SLOT_W + (k - 1) * GAP;
  return { w: 2 * PAD + inner, h: 2 * PAD + SLOT_H };
}

/** Wraps a text measure so a 'buf N' buffer label measures as its FIFO strip. */
export function fifoMeasure(text: Measure): Measure {
  return (t, kind) => {
    const n = kind === 'buffer' ? /^buf (\d+)$/.exec(t)?.[1] : undefined;
    if (n === undefined) return text(t, kind);
    const count = text(n, 'buffer');
    const s = fifoSize(Number(n), count.w);
    return { w: s.w, h: Math.max(s.h, count.h) };
  };
}

/** estimateMeasure for a style: the modern one reserves FIFO strips for buffers. */
export const estimateMeasureFor = (style: DiagramStyle): Measure =>
  style === 'modern' ? fifoMeasure(estimateMeasure) : estimateMeasure;

/**
 * Browser measure via canvas measureText, cached per kind and text. The
 * canvas is created on first use; without a DOM (node tests) or a 2d context
 * it falls back to estimateMeasure. The modern style measures a buffer label
 * as its FIFO strip.
 */
export function canvasMeasure(style: DiagramStyle): Measure {
  const text = canvasText(style);
  return style === 'modern' ? fifoMeasure(text) : text;
}

function canvasText(style: DiagramStyle): Measure {
  let ctx: CanvasRenderingContext2D | null | undefined;
  const cache = new Map<string, { w: number; h: number }>();
  return (text, kind) => {
    const key = `${kind}\u0000${text}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (ctx === undefined)
      ctx =
        typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    let size: { w: number; h: number };
    if (!ctx) {
      size = estimateMeasure(text, kind);
    } else {
      ctx.font = labelFont(style, kind);
      const lines = text.split('\n');
      size = {
        w: Math.max(...lines.map((l) => ctx!.measureText(l).width)),
        h: lines.length * LABEL_FONTS[style][kind].lineHeight,
      };
    }
    cache.set(key, size);
    return size;
  };
}
