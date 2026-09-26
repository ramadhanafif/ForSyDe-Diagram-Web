import { Component, type ReactNode } from 'react';

/**
 * Catches a render crash in the diagram pane only, so the editor stays up and
 * the user can edit their way out, then retry.
 */
export class DiagramBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="diagram-crash" role="alert">
        <p>The diagram crashed on this text: {this.state.error}</p>
        <p>Edit the text, then retry.</p>
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
