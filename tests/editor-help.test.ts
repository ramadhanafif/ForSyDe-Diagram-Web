import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  constructorHelp,
  constructorSnippet,
  documentNames,
  forsydeCompletions,
} from '../src/editor/help';

/** Complete at the end of `doc`. */
const complete = (doc: string, explicit: boolean) =>
  forsydeCompletions(new CompletionContext(EditorState.create({ doc }), doc.length, explicit));

describe('editor help', () => {
  it('snippets write one rate bare and several as a tuple', () => {
    expect(constructorSnippet(1, 1)).toBe('actor11SDF ${1:1} ${2:1} ${3:f}');
    expect(constructorSnippet(1, 2)).toBe('actor12SDF ${1:1} (${2:1}, ${3:1}) ${4:f}');
    expect(constructorSnippet(2, 1)).toBe('actor21SDF (${1:1}, ${2:1}) ${3:1} ${4:f}');
  });

  it('opens by itself only on actor and delay words', () => {
    const doc = 'a_a = actor11SDF 1 1 f\ns_1 = a_a s_0\n';
    expect(complete(doc + 's_', false)).toBeNull();
    const auto = complete(doc + 'actor2', false)!;
    expect(auto.from).toBe(doc.length);
    const labels = auto.options.map((o) => o.label);
    expect(labels).toContain('actor21SDF');
    expect(labels).toContain('delaySDF');
    expect(labels).toContain('a_a');
    expect(labels).not.toContain('actor2');
    expect(complete(doc + 'delay', false)).not.toBeNull();
    expect(complete(doc + 's_', true)!.options.map((o) => o.label)).toContain('s_1');
  });

  it('offers defined names but not keywords, comments or constructors', () => {
    const names = documentNames(
      'module M where\n-- ignored words\nf [x] = [x]\na_a = actor11SDF 1 1 f\nd = delaySDF [0]\n',
    );
    expect(names.sort()).toEqual(['a_a', 'd', 'f', 'x']);
  });

  it('explains constructors in plain words', () => {
    expect(constructorHelp('actor21SDF')).toBe(
      'actor21SDF (in1, in2) out f: 2 inputs, 1 output. Rates are tokens consumed per input ' +
        'and produced per output on each firing; f takes 2 lists and returns 1 list.',
    );
    expect(constructorHelp('actor11SDF')).toMatch(/^actor11SDF in out f: 1 input, 1 output\./);
    expect(constructorHelp('delaySDF')).toBe(
      'delaySDF [tokens]: puts these initial tokens on the signal before the first firing.',
    );
    expect(constructorHelp('actor55SDF')).toBeNull();
    expect(constructorHelp('f')).toBeNull();
  });
});
