import type { ElkNode } from 'elkjs/lib/elk-api';
import type { EdgeMeta, NodeMeta } from './toElk';

const SVG = 'http://www.w3.org/2000/svg';

function el(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Identifier in the lecture-notes math style: the part after the first
 * underscore becomes a subscript (a_a -> a with subscript a, s_in_1 -> s
 * with subscript in,1).
 */
function mathLabel(name: string, attrs: Record<string, string | number>): SVGElement {
  const t = el('text', attrs);
  const idx = name.indexOf('_');
  if (idx <= 0 || idx === name.length - 1) {
    t.textContent = name;
    return t;
  }
  const base = document.createElementNS(SVG, 'tspan');
  base.textContent = name.slice(0, idx);
  const sub = document.createElementNS(SVG, 'tspan');
  sub.textContent = name.slice(idx + 1).replace(/_/g, ',');
  sub.setAttribute('baseline-shift', 'sub');
  sub.setAttribute('font-size', '75%');
  t.append(base, sub);
  return t;
}

function text(content: string, attrs: Record<string, string | number>): SVGElement {
  const t = el('text', attrs);
  t.textContent = content;
  return t;
}

export interface RenderOptions {
  showUnitRates: boolean;
}

/** Render a laid-out ELK graph into the given <g> element. */
export function render(root: SVGGElement, graph: ElkNode, opts: RenderOptions): void {
  root.innerHTML = '';
  const meta = (graph as unknown as { $meta: Map<string, NodeMeta> }).$meta;
  const edgeMeta = (graph as unknown as { $edgeMeta: Map<string, EdgeMeta> }).$edgeMeta;

  // dashed system boundary around the process network (lecture-notes style)
  const w = graph.width ?? 0;
  const h = graph.height ?? 0;
  root.appendChild(
    el('rect', { x: -16, y: -16, width: w + 32, height: h + 32, class: 'system-boundary' }),
  );
  root.appendChild(text('System', { x: w / 2, y: -26, class: 'system-label', 'text-anchor': 'middle' }));

  for (const edge of graph.edges ?? []) {
    const m = edgeMeta.get(edge.id);
    const g = el('g', { class: 'edge' });
    g.setAttribute('data-id', m?.signal ?? edge.id);
    const section = (
      edge as {
        sections?: {
          startPoint: { x: number; y: number };
          endPoint: { x: number; y: number };
          bendPoints?: { x: number; y: number }[];
        }[];
      }
    ).sections?.[0];
    if (!section) continue;
    const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    g.appendChild(el('path', { d, class: 'edge-line', 'marker-end': 'url(#arrow)' }));

    if (m) {
      const start = pts[0]!;
      const end = pts[pts.length - 1]!;
      // production rate at the source end, consumption rate at the sink end
      if (m.sourceRate !== 1 || opts.showUnitRates) {
        g.appendChild(text(String(m.sourceRate), { x: start.x + 5, y: start.y - 4, class: 'rate-label' }));
      }
      if (m.targetRate !== 1 || opts.showUnitRates) {
        g.appendChild(
          text(String(m.targetRate), {
            x: end.x - 7,
            y: end.y - 4,
            class: 'rate-label',
            'text-anchor': 'end',
          }),
        );
      }
      // signal name (and buffer size when scheduled) near the middle
      const mid = pts.length === 2
        ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        : pts[Math.floor(pts.length / 2)]!;
      const label = mathLabel(m.signal, {
        x: mid.x,
        y: mid.y - 6,
        class: 'signal-label',
        'text-anchor': 'middle',
      });
      if (m.buffer !== undefined) {
        const buf = document.createElementNS(SVG, 'tspan');
        buf.textContent = ` ·${m.buffer}`;
        buf.setAttribute('class', 'buffer-label');
        label.appendChild(buf);
      }
      g.appendChild(label);
    }
    root.appendChild(g);
  }

  for (const child of graph.children ?? []) {
    const m = meta.get(child.id);
    if (!m) continue;
    const g = el('g', {
      class: `node ${m.kind}`,
      transform: `translate(${child.x ?? 0},${child.y ?? 0})`,
    });
    g.setAttribute('data-id', child.id);
    const w = child.width ?? 0;
    const h = child.height ?? 0;

    if (m.kind === 'io') {
      g.appendChild(mathLabel(m.label, { x: w / 2, y: h / 2 + 4, class: 'io-label', 'text-anchor': 'middle' }));
    } else {
      g.appendChild(
        el('circle', { cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2, class: 'node-shape' }),
      );
      // process name outside, above the circle
      g.appendChild(mathLabel(m.label, { x: w / 2, y: -6, class: 'process-name', 'text-anchor': 'middle' }));
      if (m.badge) {
        g.appendChild(text(m.badge, { x: w / 2 + 24, y: -6, class: 'node-badge' }));
      }
      // stacked constructor / rates / function lines inside
      const stack = m.stack ?? [];
      const lineH = 14;
      const y0 = h / 2 - ((stack.length - 1) * lineH) / 2 + 4;
      stack.forEach((line, i) => {
        const cls = i === 1 && stack.length === 3 ? 'stack-rates' : 'stack-name';
        g.appendChild(
          text(line, { x: w / 2, y: y0 + i * lineH, class: cls, 'text-anchor': 'middle' }),
        );
      });
    }
    root.appendChild(g);
  }
}

/** One-time SVG scaffolding: defs with the arrow marker + a zoomable group. */
export function initSvg(svg: SVGSVGElement): SVGGElement {
  svg.innerHTML = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="8" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head"/>
      </marker>
    </defs>
    <g class="viewport"></g>
  `;
  return svg.querySelector('.viewport') as SVGGElement;
}
