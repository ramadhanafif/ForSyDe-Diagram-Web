import { Fragment, memo, type CSSProperties, type ReactNode } from 'react';
import type { SceneModel } from '../app/useScene';
import { splitSubscript } from '../diagram/labels';
import { LABEL_FONTS } from '../scene/measure';
import type {
  DiagramStyle,
  LabelFlags,
  LabelKind,
  Rect,
  SceneLabel,
  ScenePort,
} from '../scene/types';
import { frameOf, TITLE_H } from './SceneShapes';

/** Identifier in math style: the part after the first underscore becomes a subscript. */
export function MathLabel({ name }: { name: string }) {
  const parts = splitSubscript(name);
  if (!parts) return <>{name}</>;
  return (
    <>
      {parts[0]}
      <sub>{parts[1]}</sub>
    </>
  );
}

const STACK_TITLES = {
  ctor: 'the process constructor',
  fn: 'the Haskell function this actor applies',
  tokens: 'initial tokens on the delayed signal',
};

const plural = (n: number) => (n === 1 ? '' : 's');

// longhands, not the font shorthand: React warns when a shorthand and its
// longhand (lineHeight) are updated together
const place = (b: Rect, style: DiagramStyle, kind: LabelKind): CSSProperties => {
  const f = LABEL_FONTS[style][kind];
  return {
    left: b.x,
    top: b.y,
    width: b.w,
    height: b.h,
    fontFamily: f.family,
    fontSize: f.size,
    fontWeight: f.weight,
    fontStyle: f.italic ? 'italic' : 'normal',
    lineHeight: `${f.lineHeight}px`,
  };
};

interface Props {
  model: SceneModel;
  style: DiagramStyle;
  flags: LabelFlags;
}

/**
 * The HTML label layer: every scene label at its box, in the font the layout
 * measured it with, plus the io pill texts and the boundary title. Each
 * element names the node or edge it belongs to, so a click or hover on a
 * label acts on its owner.
 */
export const SceneLabels = memo(function SceneLabels({ model, style, flags }: Props) {
  const { scene, meta, edgeSignals } = model;
  const ports = new Map<string, ScenePort>();
  for (const n of scene.nodes) for (const port of n.ports) ports.set(port.id, port);
  // a rate belongs to the edge at its port (or io node)
  const edgeAt = new Map<string, string>();
  for (const e of scene.edges) {
    if (!edgeAt.has(e.source)) edgeAt.set(e.source, e.id);
    if (!edgeAt.has(e.target)) edgeAt.set(e.target, e.id);
  }
  const lineShown = { ctor: flags.constructors, fn: flags.functions, tokens: true };

  const label = (l: SceneLabel) => {
    const common = {
      className: `scene-label label-${l.kind}`,
      'data-label-id': l.id,
      'data-label-kind': l.kind,
      style: place(l.box, style, l.kind),
    };
    const node = { ...common, 'data-owner-node': l.owner };
    let body: ReactNode = l.text;
    switch (l.kind) {
      case 'name':
        return (
          <div {...node}>
            <MathLabel name={l.text} />
          </div>
        );
      case 'badge': {
        const n = meta.nodes.get(l.owner)?.repetitions ?? 0;
        return (
          <div
            {...node}
            title={`repetitions: ${l.owner} fires ${n} time${plural(n)} in one schedule iteration`}
          >
            {l.text}
          </div>
        );
      }
      case 'stack': {
        const lines = (meta.nodes.get(l.owner)?.stack ?? []).filter((s) => lineShown[s.kind]);
        return (
          <div {...node}>
            {lines.map((s) => (
              <div
                key={s.kind}
                className={`stack-line stack-${s.kind}`}
                title={STACK_TITLES[s.kind]}
              >
                {s.text}
              </div>
            ))}
          </div>
        );
      }
      case 'signal':
        body = <MathLabel name={l.text} />;
        break;
      case 'buffer': {
        const sig = edgeSignals.get(l.owner)?.name ?? '';
        const n = meta.edges.get(l.owner)?.buffer ?? 0;
        return (
          <div
            {...common}
            data-owner-edge={l.owner}
            title={`buffer: ${sig} holds at most ${n} token${plural(n)} during one iteration of this schedule (round robin: after a firing, the next ready actor in declaration order fires)`}
          >
            {/* the modern style draws a FIFO strip in the SVG layer under this box */}
            {style === 'lecture' ? `·${n}` : null}
          </div>
        );
      }
      case 'index': {
        const port = ports.get(l.owner);
        const what = port?.dir === 'out' ? 'result' : 'argument';
        return (
          <div
            {...common}
            data-owner-edge={edgeAt.get(l.owner) ?? ''}
            title={`${what} ${l.text.slice(1)} of ${port?.node ?? ''}: ports on this side are drawn out of order to avoid a crossing`}
          >
            {l.text}
          </div>
        );
      }
      case 'rate': {
        const edge = edgeAt.get(l.owner) ?? '';
        const port = ports.get(l.owner);
        const r = Number(l.text);
        const out = port ? port.dir === 'out' : edgeSignals.get(edge)?.source.name === l.owner;
        const proc = port?.node ?? l.owner;
        const sig = port?.signal ?? edgeSignals.get(edge)?.name ?? l.owner;
        const title = out
          ? `production rate: ${proc} writes ${r} token${plural(r)} onto ${sig} per firing`
          : `consumption rate: ${proc} reads ${r} token${plural(r)} from ${sig} per firing`;
        // a rate of 1 completes the balance equation but is the default: drawn quietly
        return (
          <div
            {...common}
            className={r === 1 ? `${common.className} label-unit` : common.className}
            data-owner-edge={edge}
            title={title}
          >
            {l.text}
          </div>
        );
      }
    }
    return (
      <div {...common} data-owner-edge={l.owner}>
        {body}
      </div>
    );
  };

  const f = frameOf(scene.bounds);
  return (
    <div className="scene-labels">
      <div
        className="system-label"
        style={{ left: f.x, top: f.y, width: f.w, height: TITLE_H, lineHeight: `${TITLE_H}px` }}
      >
        System
      </div>
      {scene.nodes
        .filter((n) => n.kind === 'io')
        .map((n) => (
          <div
            key={n.id}
            className="io-label"
            data-owner-node={n.id}
            style={{ ...place(n.box, style, 'stack'), lineHeight: `${n.box.h}px` }}
          >
            <MathLabel name={n.id} />
          </div>
        ))}
      {scene.labels.map((l) => (
        <Fragment key={l.id}>{label(l)}</Fragment>
      ))}
    </div>
  );
});
