import { BaseEdge, type EdgeProps } from '@xyflow/react';
import type { FlowEdge } from './toFlow';

/** SVG math label: part after the first underscore becomes a subscript tspan. */
function MathText({
  name,
  suffix,
  ...attrs
}: { name: string; suffix?: string } & React.SVGProps<SVGTextElement>) {
  const idx = name.indexOf('_');
  const plain = idx <= 0 || idx === name.length - 1;
  // the name lives in its own tspans so signal names and buffer sizes
  // can be shown or hidden independently
  return (
    <text {...attrs}>
      {plain ? (
        <tspan className="sig-name">{name}</tspan>
      ) : (
        <>
          <tspan className="sig-name">{name.slice(0, idx)}</tspan>
          <tspan className="sig-name" baselineShift="sub" fontSize="75%">
            {name.slice(idx + 1).replace(/_/g, ',')}
          </tspan>
        </>
      )}
      {suffix && <tspan className="buffer-label"> {suffix}</tspan>}
    </text>
  );
}

/** Renders elk's routed orthogonal path verbatim; React Flow never re-routes. */
export function ElkEdge({ id, data }: EdgeProps<FlowEdge>) {
  if (!data) return null;
  const { points, meta, showUnitRates } = data;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const mid =
    points.length === 2
      ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      : points[Math.floor(points.length / 2)]!;

  return (
    <>
      <BaseEdge id={id} path={d} className="edge-line" markerEnd="url(#fsd-arrow)" />
      {(meta.sourceRate !== 1 || showUnitRates) && (
        <text x={start.x + 5} y={start.y - 4} className="rate-label">
          {meta.sourceRate}
        </text>
      )}
      {(meta.targetRate !== 1 || showUnitRates) && (
        <text x={end.x - 7} y={end.y - 4} className="rate-label" textAnchor="end">
          {meta.targetRate}
        </text>
      )}
      <MathText
        name={meta.signal}
        suffix={meta.buffer !== undefined ? `·${meta.buffer}` : undefined}
        x={mid.x}
        y={mid.y - 6}
        className="signal-label"
        textAnchor="middle"
      />
    </>
  );
}

export const edgeTypes = { elk: ElkEdge };
