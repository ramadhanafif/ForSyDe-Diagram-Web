import {
  autocompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';

/** `actorNMSDF`: N inputs, M outputs. */
const ACTOR = /^actor([1-4])([1-4])SDF$/;

/**
 * The snippet template for actorNMSDF. A single rate is a bare number and
 * several rates are a tuple, as the parser expects.
 */
export function constructorSnippet(n: number, m: number): string {
  let field = 0;
  const rates = (k: number) => {
    const r = Array.from({ length: k }, () => `\${${++field}:1}`);
    return k === 1 ? r[0] : `(${r.join(', ')})`;
  };
  const ins = rates(n);
  const outs = rates(m);
  return `actor${n}${m}SDF ${ins} ${outs} \${${++field}:f}`;
}

const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

/** What a constructor does, for the hover tooltip; null for any other word. */
export function constructorHelp(word: string): string | null {
  if (word === 'delaySDF')
    return 'delaySDF [tokens]: puts these initial tokens on the signal before the first firing.';
  const m = ACTOR.exec(word);
  if (!m) return null;
  const [n, k] = [Number(m[1]), Number(m[2])];
  const names = (count: number, base: string) =>
    count === 1
      ? base
      : `(${Array.from({ length: count }, (_, i) => `${base}${i + 1}`).join(', ')})`;
  return (
    `${word} ${names(n, 'in')} ${names(k, 'out')} f: ${plural(n, 'input')}, ${plural(k, 'output')}. ` +
    'Rates are tokens consumed per input and produced per output on each firing; ' +
    `f takes ${plural(n, 'list')} and returns ${plural(k, 'list')}.`
  );
}

const constructors: Completion[] = [
  ...[1, 2, 3, 4].flatMap((n) =>
    [1, 2, 3, 4].map((m) =>
      snippetCompletion(constructorSnippet(n, m), {
        label: `actor${n}${m}SDF`,
        type: 'function',
        detail: `${n} in, ${m} out`,
      }),
    ),
  ),
  snippetCompletion('delaySDF [${1:0}]', {
    label: 'delaySDF',
    type: 'function',
    detail: 'initial tokens',
  }),
];

const KEYWORDS = new Set('module where import let in case of if then else do'.split(' '));

/** Lowercase identifiers in the document outside comments, minus keywords and constructors. */
export function documentNames(doc: string): string[] {
  const names = new Set(doc.replace(/--.*$/gm, '').match(/\b[a-z_][\w']*/g) ?? []);
  return [...names].filter((w) => !KEYWORDS.has(w) && !ACTOR.test(w) && w !== 'delaySDF');
}

/**
 * Opens by itself only on words starting with actor or delay: popping up on
 * every identifier gets in the way of people who already know the language.
 * Ctrl-Space opens it anywhere.
 */
export function forsydeCompletions(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[\w']+/);
  if (!ctx.explicit && !(word && /^(actor|delay)/.test(word.text))) return null;
  const typed = word?.text;
  const names = documentNames(ctx.state.doc.toString())
    .filter((w) => w !== typed)
    .map((label): Completion => ({ label, type: 'variable' }));
  return {
    from: word?.from ?? ctx.pos,
    options: [...constructors, ...names],
    validFor: /^[\w']*$/,
  };
}

const constructorHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const at = pos - line.from;
  for (const m of line.text.matchAll(/[\w']+/g)) {
    if (m.index > at || m.index + m[0].length < at) continue;
    const text = constructorHelp(m[0]);
    if (!text) return null;
    return {
      pos: line.from + m.index,
      end: line.from + m.index + m[0].length,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-constructor-help';
        dom.textContent = text;
        return { dom };
      },
    };
  }
  return null;
});

/** Constructor completion and hover help for the editor. */
export const editorHelp: Extension = [
  autocompletion({ activateOnTyping: true, override: [forsydeCompletions] }),
  constructorHover,
  EditorView.theme({ '.cm-constructor-help': { padding: '4px 8px', maxWidth: '32em' } }),
];
