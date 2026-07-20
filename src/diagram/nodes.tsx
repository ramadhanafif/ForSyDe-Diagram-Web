import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode } from './toFlow';

/**
 * Identifier in math style: the part after the first underscore becomes a
 * subscript (s_in_1 -> s with subscript in,1).
 */
export function MathLabel({ name }: { name: string }) {
  const idx = name.indexOf('_');
  if (idx <= 0 || idx === name.length - 1) return <>{name}</>;
  return (
    <>
      {name.slice(0, idx)}
      <sub>{name.slice(idx + 1).replace(/_/g, ',')}</sub>
    </>
  );
}

function Ports({ ports }: { ports: FlowNode['data']['ports'] }) {
  return (
    <>
      {ports.map((p) => (
        <Handle
          key={p.id}
          id={p.id}
          type={p.kind === 'in' ? 'target' : 'source'}
          position={p.kind === 'in' ? Position.Left : Position.Right}
          style={{ top: p.y + 1 }}
        />
      ))}
    </>
  );
}

function CircleNode({ data }: NodeProps<FlowNode>) {
  const { meta, ports, width, height } = data;
  const stack = meta.stack ?? [];
  return (
    <div className={`fsd-node ${meta.kind}`} style={{ width, height }}>
      <svg width={width} height={height} className="node-svg">
        <circle
          cx={width / 2}
          cy={height / 2}
          r={Math.min(width, height) / 2 - 1}
          className="node-shape"
        />
      </svg>
      <div className="process-name">
        <MathLabel name={meta.label} />
        {meta.badge && <span className="node-badge">{meta.badge}</span>}
      </div>
      <div className="stack">
        {stack.map((line, i) => (
          <div key={i} className={i === 1 && stack.length === 3 ? 'stack-rates' : 'stack-name'}>
            {line}
          </div>
        ))}
      </div>
      <Ports ports={ports} />
      {meta.kind === 'actor' && (
        <Handle
          id={`${meta.label}.in.__new`}
          type="target"
          position={Position.Left}
          className="new-input-handle"
          title="drag a signal here to add an input"
        />
      )}
    </div>
  );
}

function IoNode({ data }: NodeProps<FlowNode>) {
  const { meta, width, height } = data;
  // io nodes have no elk ports; edges attach to default handles
  return (
    <div className="fsd-node io" style={{ width, height }}>
      <div className="io-label">
        <MathLabel name={meta.label} />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id={`${meta.label}.io.src`}
        className="io-handle"
      />
      <Handle type="target" position={Position.Left} className="io-handle" />
    </div>
  );
}

export const nodeTypes = {
  actor: CircleNode,
  delay: CircleNode,
  io: IoNode,
};
