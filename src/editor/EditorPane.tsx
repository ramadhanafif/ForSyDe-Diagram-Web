import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Diagnostic } from '../core/ast';
import type { Splice } from '../core/edits';

/** Imperative editor API: the single write path for source text. */
export interface EditorApi {
  /** Replace the document and reset undo history (example loads). */
  setSource(source: string): void;
  /** Apply diagram-edit splices as one undoable transaction. */
  applySplices(splices: Splice[]): void;
  /** Move the cursor and scroll to an offset (goto definition). */
  gotoOffset(offset: number): void;
  getDoc(): string;
}

interface Props {
  onChange(source: string): void;
  diagnostics: Diagnostic[];
}

export const EditorPane = forwardRef<EditorApi, Props>(function EditorPane(
  { onChange, diagnostics },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const diagsRef = useRef(diagnostics);

  useEffect(() => {
    const cmLinter = linter(
      (v): CmDiagnostic[] => {
        const len = v.state.doc.length;
        return diagsRef.current.map((d) => ({
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
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
    ];
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ extensions }),
    });
    view.current = v;
    (v as EditorView & { fsdExtensions?: unknown[] }).fsdExtensions = extensions;
    return () => v.destroy();
  }, []);

  // re-trigger the linter whenever diagnostics change
  useEffect(() => {
    diagsRef.current = diagnostics;
    view.current?.dispatch({});
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    setSource(source) {
      const v = view.current;
      if (!v) return;
      const extensions = (v as EditorView & { fsdExtensions?: unknown[] }).fsdExtensions ?? [];
      // fresh state so the example load is not part of the undo history
      v.setState(EditorState.create({ doc: source, extensions: extensions as never }));
      onChangeRef.current(source);
    },
    applySplices(splices) {
      view.current?.dispatch({
        changes: splices.map((s) => ({ from: s.from, to: s.to, insert: s.insert })),
      });
    },
    gotoOffset(offset) {
      const v = view.current;
      if (!v) return;
      v.dispatch({
        selection: { anchor: offset },
        effects: EditorView.scrollIntoView(offset, { y: 'center' }),
      });
      v.focus();
    },
    getDoc() {
      return view.current?.state.doc.toString() ?? '';
    },
  }));

  return <div className="editor-host" ref={host} />;
});
