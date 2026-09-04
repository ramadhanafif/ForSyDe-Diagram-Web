import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { haskellHighlight } from '../src/editor/EditorPane';

/** Mount a headless editor (needs DOM; skipped in node). */
function mount(doc: string): EditorView | null {
  if (typeof document === 'undefined') return null;
  return new EditorView({
    parent: document.createElement('div'),
    state: EditorState.create({
      doc,
      extensions: [StreamLanguage.define(haskell), syntaxHighlighting(haskellHighlight)],
    }),
  });
}

describe('editor syntax highlighting', () => {
  const src = 'module M where\n-- note\nf = actor11SDF 1 1 g\n';

  it('the custom theme maps the token kinds the haskell mode emits', () => {
    // the StreamLanguage mode decorates with the standard lezer tags; the
    // theme must have a rule for each token kind that should be colored.
    const tagsOf = (kind: string) =>
      haskellHighlight.specs.filter((s) =>
        (Array.isArray(s.tag) ? s.tag : [s.tag]).some((t) => t.name === kind),
      );
    for (const kind of ['keyword', 'comment', 'string', 'number']) {
      expect(tagsOf(kind).length, `theme has a ${kind} rule`).toBeGreaterThan(0);
    }
    // theme colors follow the app CSS variables, so the dark toggle recolors
    // tokens with no editor reconfigure
    for (const spec of haskellHighlight.specs) {
      expect(spec.color, `${spec.tag} uses a theme variable`).toMatch(/^var\(--/);
    }
  });

  it('colored spans appear in the rendered DOM (browser only)', () => {
    const view = mount(src);
    if (!view) return; // node: no DOM to render into
    try {
      const spans = view.dom.querySelectorAll('.cm-content span[class*="tok-"]');
      expect(spans.length).toBeGreaterThan(0);
    } finally {
      view.destroy();
    }
  });
});
