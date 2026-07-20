import ELK from 'elkjs/lib/elk.bundled.js';
import { useEffect, useRef, useState } from 'react';
import type { Diagnostic } from '../core/ast';
import { elaborate } from '../core/elaborate';
import type { IRSystem } from '../core/ir';
import { parse } from '../core/parser';
import { computeScheduleAndBuffers, type ScheduleResult } from '../core/schedule';
import { buildElkGraph, type DiagramGraph } from '../diagram/toElk';

const elk = new ELK();

/** The model the diagram currently shows, plus the exact source it came from. */
export interface ModelState {
  ir: IRSystem;
  dg: DiagramGraph;
  source: string;
}

export interface PipelineState {
  diagnostics: Diagnostic[];
  /** Last-good laid-out model; kept while the current text has errors. */
  model: ModelState | null;
  schedule: ScheduleResult | null;
  /** True when `model` no longer matches the current text (errors). */
  stale: boolean;
  errorCount: number;
}

const EMPTY: PipelineState = {
  diagnostics: [],
  model: null,
  schedule: null,
  stale: false,
  errorCount: 0,
};

/** Debounced parse -> elaborate -> schedule -> elk layout, dropping stale results. */
export function usePipeline(source: string): PipelineState {
  const [state, setState] = useState<PipelineState>(EMPTY);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    const timer = setTimeout(() => {
      void (async () => {
        const { module: mod, diagnostics } = parse(source);
        const { ir, diagnostics: elabDiags } = elaborate(mod);
        const allDiags = [...diagnostics, ...elabDiags];
        const errorCount = allDiags.filter((d) => d.severity === 'error').length;
        if (!ir) {
          if (gen === generation.current)
            setState((s) => ({ ...s, diagnostics: allDiags, stale: true, errorCount }));
          return;
        }
        const schedule = computeScheduleAndBuffers(ir);
        const dg = buildElkGraph(ir, schedule);
        dg.graph = await elk.layout(dg.graph);
        if (gen !== generation.current) return;
        setState({
          diagnostics: allDiags,
          model: { ir, dg, source },
          schedule,
          stale: false,
          errorCount,
        });
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [source]);

  return state;
}
