import type { ElkNode } from 'elkjs/lib/elk-api';
import type { EdgeMeta, NodeMeta } from './toElk';

const SVG = 'http://www.w3.org/2000/svg';

function el<K extends string>(tag: K, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
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

  for (const edge of graph.edges ?? []) {
    const m = edgeMeta.get(edge.id);
    const g = el('g', { class: 'edge' });
    g.setAttribute('data-id', m?.signal ?? edge.id);
    const section = (edge as { sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[] }).sections?.[0];
    if (!section) continue;
    const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    g.appendChild(el('path', { d, class: 'edge-line', 'marker-end': 'url(#arrow)' }));

    if (m) {
      const start = pts[0]!;
      const end = pts[pts.length - 1]!;
      if (m.sourceRate !== 1 || opts.showUnitRates) {
        g.appendChild(
          text(String(m.sourceRate), { x: start.x + 6, y: start.y - 5, class: 'rate-label' }),
        );
      }
      if (m.targetRate !== 1 || opts.showUnitRates) {
        g.appendChild(
          text(String(m.targetRate), {
            x: end.x - 6,
            y: end.y - 5,
            class: 'rate-label',
            'text-anchor': 'end',
          }),
        );
      }
      if (m.buffer !== undefined) {
        const mid = pts[Math.floor(pts.length / 2)]!;
        g.appendChild(
          text(`${m.signal} · ${m.buffer}`, {
            x: (mid.x + end.x) / 2,
            y: mid.y - 7,
            class: 'buffer-label',
            'text-anchor': 'middle',
          }),
        );
      }
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

    if (m.kind === 'actor') {
      g.appendChild(el('rect', { width: w, height: h, rx: 8, class: 'node-shape' }));
      g.appendChild(
        text(m.label, { x: w / 2, y: m.sublabel ? h / 2 - 4 : h / 2 + 4, class: 'node-label', 'text-anchor': 'middle' }),
      );
      if (m.sublabel) {
        g.appendChild(
          text(m.sublabel, { x: w / 2, y: h / 2 + 14, class: 'node-sublabel', 'text-anchor': 'middle' }),
        );
      }
      if (m.badge) {
        g.appendChild(text(m.badge, { x: w - 4, y: 12, class: 'node-badge', 'text-anchor': 'end' }));
      }
    } else if (m.kind === 'delay') {
      g.appendChild(el('rect', { width: w, height: h, rx: 14, class: 'node-shape' }));
      g.appendChild(
        text(m.label, { x: w / 2, y: h / 2 + 4, class: 'node-label small', 'text-anchor': 'middle' }),
      );
    } else {
      g.appendChild(
        text(m.label, { x: w / 2, y: h / 2 + 4, class: 'io-label', 'text-anchor': 'middle' }),
      );
    }
    root.appendChild(g);
  }
}

/** One-time SVG scaffolding: defs with the arrow marker + a zoomable group. */
export function initSvg(svg: SVGSVGElement): SVGGElement {
  svg.innerHTML = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head"/>
      </marker>
    </defs>
    <g class="viewport"></g>
  `;
  return svg.querySelector('.viewport') as SVGGElement;
}
