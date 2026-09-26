import { orderDiagnostics, type Diagnostic } from '../core/ast';

/** Clickable list of diagnostics, errors first; click jumps the cursor to the span. */
export function ErrorBar({
  diagnostics,
  onGoto,
}: {
  diagnostics: Diagnostic[];
  onGoto(offset: number): void;
}) {
  if (!diagnostics.length) return null;
  return (
    <div className="error-bar">
      {orderDiagnostics(diagnostics).map((d, i) => (
        <button
          key={i}
          className={d.severity === 'error' ? 'err' : 'warn'}
          title="Jump to this diagnostic"
          onClick={() => onGoto(d.span.from)}
        >
          {d.message}
        </button>
      ))}
    </div>
  );
}
