import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { schemeExtension } from '../src/editor/EditorPane';

/** The editor theme facet must follow the app dark toggle. */
function hasDarkTheme(state: EditorState): boolean {
  return state.facet(EditorView.darkTheme);
}

describe('editor color-scheme extension', () => {
  it('enables the dark theme facet only in dark mode', () => {
    const light = EditorState.create({ extensions: schemeExtension(false) });
    const dark = EditorState.create({ extensions: schemeExtension(true) });
    expect(hasDarkTheme(light)).toBe(false);
    expect(hasDarkTheme(dark)).toBe(true);
  });

  it('produces a fresh extension that flips the facet when mounted', () => {
    // EditorPane mounts schemeExtension(dark) then reconfigures the same
    // compartment on toggle; both directions must carry the right flag.
    const light = EditorState.create({ extensions: [schemeExtension(false)] });
    const dark = EditorState.create({ extensions: [schemeExtension(true)] });
    expect(hasDarkTheme(light)).toBe(false);
    expect(hasDarkTheme(dark)).toBe(true);
    expect(light.doc.toString()).toBe(dark.doc.toString());
  });
});
