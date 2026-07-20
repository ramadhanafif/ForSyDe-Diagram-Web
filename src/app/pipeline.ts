import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Diagnostic } from '../core/ast';
import { elaborate } from '../core/elaborate';
import type { IRSystem } from '../core/ir';
import { parse } from '../core/parser';
import { computeScheduleAndBuffers, type ScheduleResult } from '../core/schedule';
import { buildElkGraph } from '../diagram/toElk';

const elk = new ELK();

export interface PipelineOutput {
  diagnostics: Diagnostic[];
  /** Laid-out graph, or null when the source has errors (keep last good). */
  graph: ElkNode | null;
  ir: IRSystem | null;
  schedule: ScheduleResult | null;
}

let generation = 0;

/** source -> diagnostics + laid-out diagram. Stale async layouts are dropped. */
export async function runPipeline(source: string): Promise<PipelineOutput | 'stale'> {
  const gen = ++generation;
  const { module: mod, diagnostics } = parse(source);
  const { ir, diagnostics: elabDiags } = elaborate(mod);
  const allDiags = [...diagnostics, ...elabDiags];
  if (!ir) return { diagnostics: allDiags, graph: null, ir: null, schedule: null };

  const schedule = computeScheduleAndBuffers(ir);
  const graph = await elk.layout(buildElkGraph(ir, schedule));
  if (gen !== generation) return 'stale';
  return { diagnostics: allDiags, graph, ir, schedule };
}
