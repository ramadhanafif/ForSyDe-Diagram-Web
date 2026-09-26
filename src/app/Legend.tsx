import { Strip } from '../render/SceneShapes';
import { fifoSize } from '../scene/measure';
import type { DiagramStyle } from '../scene/types';

/** A three-slot strip holding one token, as the modern style draws a buffer. */
const LEGEND_STRIP = fifoSize(3, 0);

export function Legend({ style }: { style: DiagramStyle }) {
  const modern = style === 'modern';
  return (
    <div className="legend">
      <div className="legend-title">Legend</div>
      <div className="legend-row">
        <span className="legend-swatch swatch-actor" />
        <span>actor: constructor and function inside</span>
      </div>
      <div className="legend-row">
        <span className="legend-swatch swatch-delay" />
        <span>
          {modern
            ? 'delay: its initial tokens, pre-filled on the signal'
            : 'delay with its initial tokens [..]'}
        </span>
      </div>
      <div className="legend-row">
        <span className="legend-pill">s</span>
        <span>system input or output</span>
      </div>
      <div className="legend-row">
        <span className="legend-glyph legend-rate">2</span>
        <span>rate at an edge end: tokens produced or consumed per firing</span>
      </div>
      <div className="legend-row">
        {modern ? (
          <svg
            className="legend-glyph"
            width={LEGEND_STRIP.w}
            height={LEGEND_STRIP.h}
            aria-hidden="true"
          >
            <rect
              className="fifo-outline"
              x={0.5}
              y={0.5}
              width={LEGEND_STRIP.w - 1}
              height={LEGEND_STRIP.h - 1}
              rx={3}
            />
            <Strip x={0} y={0} capacity={3} filled={1} />
          </svg>
        ) : (
          <span className="legend-glyph legend-buffer">&middot;4</span>
        )}
        <span>
          {modern
            ? 'buffer: one slot per token it holds at most under this schedule, filled slots hold tokens now'
            : 'buffer: maximum tokens held on the signal under this schedule'}
        </span>
      </div>
      <div className="legend-row">
        <span className="legend-glyph legend-badge">&times;2</span>
        <span>repetitions of the actor in one schedule iteration</span>
      </div>
      <div className="legend-row">
        <span className="legend-swatch swatch-newinput" />
        <span>drop target: drag a signal here to add an input</span>
      </div>
    </div>
  );
}
