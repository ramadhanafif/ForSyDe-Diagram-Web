import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import type { Diagnostic } from '../core/ast';

export interface Editor {
  view: EditorView;
  /** Replace the document and reset undo history (used for example loads). */
  setSource(source: string): void;
  setDiagnostics(diags: Diagnostic[]): void;
}

export function createEditor(parent: HTMLElement, onChange: (source: string) => void): Editor {
  let currentDiags: Diagnostic[] = [];

  const cmLinter = linter(
    (view): CmDiagnostic[] => {
      const len = view.state.doc.length;
      return currentDiags.map((d) => ({
        from: Math.min(d.span.from, len),
        to: Math.min(Math.max(d.span.to, d.span.from + 1), len),
        severity: d.severity,
        message: d.message,
      }));
    },
    { delay: 0 },
  );

  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    StreamLanguage.define(haskell),
    lintGutter(),
    cmLinter,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ extensions }),
  });

  return {
    view,
    setSource(source) {
      // fresh state so the example load is not part of the undo history
      view.setState(EditorState.create({ doc: source, extensions }));
      onChange(source);
    },
    setDiagnostics(diags) {
      currentDiags = diags;
      // re-trigger the linter by dispatching an empty transaction
      view.dispatch({});
    },
  };
}
