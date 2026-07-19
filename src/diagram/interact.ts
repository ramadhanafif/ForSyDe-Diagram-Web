import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import type { ElkNode } from 'elkjs/lib/elk-api';

export interface Viewport {
  svg: SVGSVGElement;
  group: SVGGElement;
  fit(graph: ElkNode): void;
}

export function setupZoom(svg: SVGSVGElement, group: SVGGElement): Viewport {
  const selection = select(svg as Element);
  const behavior: ZoomBehavior<Element, unknown> = zoom<Element, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (ev: { transform: unknown }) => {
      group.setAttribute('transform', String(ev.transform));
    });
  selection.call(behavior);
  selection.on('dblclick.zoom', null);

  return {
    svg,
    group,
    fit(graph: ElkNode) {
      const w = graph.width ?? 1;
      const h = graph.height ?? 1;
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(2, 0.9 * Math.min(rect.width / w, rect.height / h));
      const tx = (rect.width - w * scale) / 2;
      const ty = (rect.height - h * scale) / 2;
      selection.call(behavior.transform, zoomIdentity.translate(tx, ty).scale(scale));
    },
  };
}
