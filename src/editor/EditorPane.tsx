import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
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

/**
 * Reconfigured on app-theme toggle so CodeMirror's own `&dark` styles kick
 * in. Only the dark flag goes in the compartment — drawSelection() lives at
 * top level so reconfiguring the flag never disturbs the cursor layer.
 * NOTE: this returns the raw extension; callers wrap it with
 * `schemeCompartment.of(...)` when mounting, and pass it bare to
 * `schemeCompartment.reconfigure(...)` (nesting `.of()` inside reconfigure
 * throws "Duplicate use of compartment").
 */
const schemeCompartment = new Compartment();

/**
 * Token colors for the Haskell mode. Colors reference the app CSS variables
 * so the light/dark toggle recolors tokens with no CodeMirror reconfigure.
 */
export const haskellHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: tags.comment, color: 'var(--fg-dim)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--buffer-fg)' },
  { tag: tags.number, color: 'var(--rate-fg)' },
  { tag: tags.typeName, color: 'var(--rate-fg)' },
]);

/** CodeMirror-side theme, mirroring the app `data-theme` toggle. */
export function schemeExtension(dark: boolean): Extension {
  return EditorView.theme({}, { dark });
}

interface Props {
  onChange(source: string): void;
  diagnostics: Diagnostic[];
  dark: boolean;
}

export const EditorPane = forwardRef<EditorApi, Props>(function EditorPane(
  { onChange, diagnostics, dark },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    // base extensions are stable and reusable across setSource() states;
    // the scheme compartment instance is created fresh per state instead
    const baseExtensions = [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
      highlightSelectionMatches(),
      StreamLanguage.define(haskell),
      syntaxHighlighting(haskellHighlight),
      lintGutter(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
    ];
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        extensions: [
          ...baseExtensions,
          schemeCompartment.of(schemeExtension(darkRef.current)),
          drawSelection({ cursorBlinkRate: 1200 }),
        ],
      }),
    });
    view.current = v;
    (v as EditorView & { fsdBaseExtensions?: unknown[] }).fsdBaseExtensions = baseExtensions;
    return () => v.destroy();
  }, []);

  // follow the app theme toggle without rebuilding the editor: the scheme
  // compartment flips CodeMirror's `cm-light`/`cm-dark` class, which its own
  // base styles (`&dark .cm-cursor`, `&dark .cm-content` caret-color, ...) key on
  useEffect(() => {
    view.current?.dispatch({ effects: schemeCompartment.reconfigure(schemeExtension(dark)) });
  }, [dark]);

  // push diagnostics into the editor as soon as the pipeline produces them;
  // a pull-based linter() only refreshes on doc changes, which made squiggles
  // lag one keystroke behind
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    v.dispatch(
      setDiagnostics(
        v.state,
        diagnostics.map((d) => ({
          from: Math.min(d.span.from, len),
          to: Math.min(Math.max(d.span.to, d.span.from + 1), len),
          severity: d.severity,
          message: d.message,
        })),
      ),
    );
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    setSource(source) {
      const v = view.current;
      if (!v) return;
      // fresh state so the example load is not part of the undo history;
      // base extensions (without the scheme compartment instance, which
      // cannot be reused across states) are rebuilt with the current theme
      const stored = (v as EditorView & { fsdBaseExtensions?: unknown[] }).fsdBaseExtensions ?? [];
      v.setState(
        EditorState.create({
          doc: source,
          extensions: [
            ...(stored as Extension[]),
            schemeCompartment.of(schemeExtension(darkRef.current)),
            drawSelection({ cursorBlinkRate: 1200 }),
          ],
        }),
      );
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
      const at = Math.min(Math.max(offset, 0), v.state.doc.length);
      v.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      });
      v.focus();
    },
    getDoc() {
      return view.current?.state.doc.toString() ?? '';
    },
  }));

  return <div className="editor-host" ref={host} />;
});
