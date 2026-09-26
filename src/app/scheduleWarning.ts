import type { Diagnostic } from '../core/ast';
import type { Explanation } from './explain';

/**
 * A failed schedule as an editor diagnostic. It is a warning, not an error:
 * the model parses and the diagram draws, it only has no static schedule.
 * The squiggle goes where the explanation points: the actor at fault, else
 * the system's parameters.
 */
export function scheduleWarning(e: Pick<Explanation, 'message' | 'span'>): Diagnostic {
  return {
    severity: 'warning',
    code: 'not-schedulable',
    message: `Not schedulable: ${e.message}`,
    span: e.span,
  };
}
