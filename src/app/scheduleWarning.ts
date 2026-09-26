import type { Diagnostic } from '../core/ast';
import type { IRSystem } from '../core/ir';

/**
 * A failed schedule as an editor diagnostic. It is a warning, not an error:
 * the model parses and the diagram draws, it only has no static schedule.
 * The squiggle goes on the spec of the first process the message names in
 * quotes (the scheduler names the actor or signal at fault), else on the
 * system's parameters.
 */
export function scheduleWarning(ir: IRSystem, message: string): Diagnostic {
  let span = ir.spans.anchors.systemParams;
  for (const [, name] of message.matchAll(/'([^']+)'/g)) {
    const ps = ir.spans.processes.get(name!);
    if (ps) {
      span = ps.name;
      break;
    }
  }
  return {
    severity: 'warning',
    code: 'not-schedulable',
    message: `Not schedulable: ${message}`,
    span,
  };
}
