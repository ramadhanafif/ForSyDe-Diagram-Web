import { useEffect, useRef, useState } from 'react';
import { layoutFailed, type Diagnostic } from '../core/ast';
import { elaborate } from '../core/elaborate';
import type { IRSignal, IRSystem } from '../core/ir';
import { parse } from '../core/parser';
import { computeScheduleAndBuffers, type ScheduleResult } from '../core/schedule';
import { layout } from '../layout';
import { edgeId, sceneMeta, type SceneMeta } from '../scene/labels';
import type { DiagramStyle, LabelFlags, Measure, Scene } from '../scene/types';

/** The model the diagram currently shows, plus the exact source it came from. */
export interface SceneModel {
  ir: IRSystem;
  scene: Scene;
  source: string;
  schedule: ScheduleResult;
  /** Tooltip data: stack lines, repetitions, buffer sizes. */
  meta: SceneMeta;
  /** The IR signal each edge draws (diagram-driven editing needs its spans). */
  edgeSignals: Map<string, IRSignal>;
}

export interface SceneState {
  diagnostics: Diagnostic[];
  /** Last-good model; kept while the current text has errors. */
  model: SceneModel | null;
  schedule: ScheduleResult | null;
  /** True when `model` no longer matches the current text (errors). */
  stale: boolean;
  errorCount: number;
}

export const EMPTY_SCENE_STATE: SceneState = {
  diagnostics: [],
  model: null,
  schedule: null,
  stale: false,
  errorCount: 0,
};

/**
 * parse -> elaborate -> schedule -> layout, as a pure step from the previous
 * state: its scene seeds the layout for stability, and its model survives
 * when the new source does not elaborate. A throw anywhere becomes an error
 * diagnostic over the last good model, not a frozen diagram.
 */
export function computeModel(
  source: string,
  flags: LabelFlags,
  measure: Measure,
  prev: SceneState,
  style: DiagramStyle = 'lecture',
): SceneState {
  try {
    return pipeline(source, flags, measure, prev, style);
  } catch (err) {
    const failed: Diagnostic = {
      severity: 'error',
      code: 'pipeline-failed',
      message: `diagram failed: ${err instanceof Error ? err.message : String(err)}`,
      span: { from: 0, to: 0 },
    };
    return { ...prev, diagnostics: [failed], stale: true, errorCount: 1 };
  }
}

function pipeline(
  source: string,
  flags: LabelFlags,
  measure: Measure,
  prev: SceneState,
  style: DiagramStyle = 'lecture',
): SceneState {
  const { module: mod, diagnostics } = parse(source);
  const { ir, diagnostics: elabDiags } = elaborate(mod);
  const allDiags = [...diagnostics, ...elabDiags];
  const errorCount = allDiags.filter((d) => d.severity === 'error').length;
  if (!ir) return { ...prev, diagnostics: allDiags, stale: true, errorCount };
  const schedule = computeScheduleAndBuffers(ir);
  let scene: Scene;
  try {
    scene = layout({ ir, schedule, flags, measure, style, prev: prev.model?.scene });
  } catch (err) {
    return {
      ...prev,
      diagnostics: [...allDiags, layoutFailed(err)],
      stale: true,
      errorCount: errorCount + 1,
    };
  }
  const edgeSignals = new Map(ir.signals.map((s) => [edgeId(s), s]));
  return {
    diagnostics: allDiags,
    model: { ir, scene, source, schedule, meta: sceneMeta(ir, schedule), edgeSignals },
    schedule,
    stale: false,
    errorCount,
  };
}

/**
 * Runs computeModel at most once per animation frame: a burst of keystrokes
 * or flag toggles within one frame lays out once. `flags` and `measure` are
 * effect dependencies, so callers keep their identities stable (useState,
 * useMemo) or every render re-lays out. `measure` should be
 * canvasMeasure(style) for the same `style`.
 */
export function useScene(
  source: string,
  flags: LabelFlags,
  measure: Measure,
  style: DiagramStyle = 'lecture',
): SceneState {
  const [state, setState] = useState(EMPTY_SCENE_STATE);
  const last = useRef(EMPTY_SCENE_STATE);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      last.current = computeModel(source, flags, measure, last.current, style);
      setState(last.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [source, flags, measure, style]);

  return state;
}
