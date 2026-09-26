import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import type { Point } from '../core/layoutBlock';
import type { EditorApi } from '../editor/EditorPane';
import { examples } from './examples';
import { storageGetWorkingCopy, storageSetWorkingCopy, type WorkingCopy } from './storage';

/** Keystroke quiet period before the editor text is written to localStorage. */
const AUTOSAVE_MS = 500;
/** localStorage key for the working copy (text, baseline, example, positions). */
const WORKING_COPY_KEY = 'workingCopy';

const DEFAULT_EXAMPLE = examples.find((e) => e.group === 'Lessons') ?? examples[0];

/** Stored working copy, else the default example, unedited. */
export const initialWorkingCopy = (): WorkingCopy => {
  const stored = storageGetWorkingCopy(WORKING_COPY_KEY);
  if (stored) {
    const known = examples.some((e) => e.name === stored.example);
    return { ...stored, example: known ? stored.example : '' };
  }
  const text = DEFAULT_EXAMPLE?.source ?? '';
  return {
    source: text,
    baseline: text,
    example: DEFAULT_EXAMPLE?.name ?? '',
    positions: new Map(),
    layoutEdited: false,
  };
};

/**
 * The working copy: the text, its example, its pinned positions and the
 * unsaved-changes baseline, autosaved whole under one key (debounced, plus a
 * flush on pagehide so a quick close keeps the last keystrokes). `load` puts
 * a text and its positions on screen; replaceDoc calls it after the
 * unsaved-changes confirm, and the mount calls it with `initial`.
 */
export function useWorkingCopy(
  editorRef: RefObject<EditorApi | null>,
  initial: WorkingCopy,
  source: string,
  positions: Map<string, Point>,
  load: (text: string, pos: Map<string, Point>) => void,
) {
  const [example, setExample] = useState(initial.example);
  const baselineRef = useRef(initial.baseline);
  // a drag or Tidy since the baseline: unsaved even when the text is unchanged
  const layoutEditedRef = useRef(initial.layoutEdited);

  const latestRef = useRef<WorkingCopy | null>(null); // null until the editor is loaded
  const flush = useCallback(() => {
    if (latestRef.current)
      storageSetWorkingCopy(WORKING_COPY_KEY, {
        ...latestRef.current,
        baseline: baselineRef.current,
        layoutEdited: layoutEditedRef.current,
      });
  }, []);
  useEffect(() => {
    if (latestRef.current === null) return; // editor not loaded yet: keep what is stored
    latestRef.current = { ...latestRef.current, source, example, positions };
    const t = setTimeout(flush, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [source, example, positions, flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [flush]);

  /** `text` is saved (loaded, opened or exported): the new baseline, stored now. */
  const markSaved = useCallback(
    (text: string) => {
      baselineRef.current = text;
      layoutEditedRef.current = false;
      if (latestRef.current) latestRef.current = { ...latestRef.current, source: text };
      flush();
    },
    [flush],
  );

  /** Replace the whole working copy after the unsaved-changes confirm; false if declined. */
  const replaceDoc = useCallback(
    (text: string, from: string, pos: Map<string, Point>, what: string): boolean => {
      if (editorRef.current?.getDoc() !== baselineRef.current || layoutEditedRef.current) {
        if (!window.confirm(`Discard unsaved changes and ${what}?`)) return false;
      }
      setExample(from);
      load(text, pos);
      // stored after the editor has the text, as one consistent copy
      if (latestRef.current)
        latestRef.current = { ...latestRef.current, example: from, positions: pos };
      markSaved(text);
      return true;
    },
    [editorRef, load, markSaved],
  );

  // restore the working copy once the editor is mounted (idempotent under StrictMode)
  const restore = useEffectEvent(() => load(initial.source, initial.positions));
  useEffect(() => {
    latestRef.current = initial;
    restore();
  }, [initial]);

  return { example, replaceDoc, markSaved, layoutEditedRef };
}
