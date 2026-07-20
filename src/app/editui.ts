import { EditorView } from '@codemirror/view';
import type { ElkNode } from 'elkjs/lib/elk-api';
import {
  addSourceActor,
  deleteProcess,
  insertOnEdge,
  renameProcess,
  renameSignal,
  setFunction,
  setRates,
  setTokens,
  type Splice,
} from '../core/edits';
import type { IRProcess, IRSignal, IRSystem } from '../core/ir';
import { isDelay } from '../core/ir';
import type { EdgeMeta } from '../diagram/toElk';

/** The model the diagram currently shows, plus the exact source it came from. */
export interface ModelState {
  ir: IRSystem;
  graph: ElkNode;
  source: string;
}

interface Deps {
  svg: SVGSVGElement;
  pane: HTMLElement;
  view: EditorView;
  current(): ModelState | null;
}

/**
 * Diagram-side editing: click a node or edge for a popover, apply changes as
 * text splices to the editor. The re-parse pipeline redraws the diagram.
 */
export function setupEditUi({ svg, pane, view, current }: Deps): { addActor(): void } {
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.hidden = true;
  pane.appendChild(pop);

  const hide = () => {
    pop.hidden = true;
  };

  /** State is only usable while the editor text still matches it. */
  const liveState = (state: ModelState): ModelState | null =>
    view.state.doc.toString() === state.source ? state : null;

  function dispatch(splices: Splice[]): void {
    hide();
    view.dispatch({ changes: splices.map((s) => ({ from: s.from, to: s.to, insert: s.insert })) });
  }

  function textInput(value: string): HTMLInputElement {
    const i = document.createElement('input');
    i.value = value;
    i.spellcheck = false;
    return i;
  }

  function row(label: string, ...items: HTMLElement[]): HTMLElement {
    const r = document.createElement('label');
    r.className = 'row';
    const s = document.createElement('span');
    s.textContent = label;
    r.append(s, ...items);
    return r;
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  const err = document.createElement('div');
  err.className = 'err';
  const fail = (msg: string) => {
    err.textContent = msg;
    pop.appendChild(err);
  };

  /** Run an edit against the captured state; refuse if the text moved on. */
  function apply(
    state: ModelState,
    make: (s: ModelState) => Splice[] | null,
    msg: string | (() => string),
  ): void {
    const live = liveState(state);
    if (!live) return fail('source changed, reopen this popover');
    const splices = make(live);
    if (!splices) return fail(typeof msg === 'function' ? msg() : msg);
    dispatch(splices);
  }

  function parseInts(text: string): number[] | null {
    const parts = text.split(',').map((t) => t.trim());
    if (parts.some((p) => !/^-?\d+$/.test(p))) return null;
    return parts.map(Number);
  }

  function showAt(x: number, y: number): void {
    pop.hidden = false;
    const pr = pane.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(x - pr.left, pr.width - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(y - pr.top, pr.height - pop.offsetHeight - 8))}px`;
  }

  function title(text: string): HTMLElement {
    const t = document.createElement('div');
    t.className = 'pop-title';
    t.textContent = text;
    return t;
  }

  function showEdge(ev: MouseEvent, sig: IRSignal, state: ModelState): void {
    pop.innerHTML = '';
    const name = textInput(sig.name);
    pop.append(
      title(`signal ${sig.name}`),
      row(
        'insert',
        button('actor', () =>
          apply(state, (s) => insertOnEdge(s.source, s.ir, sig, 'actor').splices, ''),
        ),
        button('delay', () =>
          apply(state, (s) => insertOnEdge(s.source, s.ir, sig, 'delay').splices, ''),
        ),
      ),
      row(
        'rename',
        name,
        button('apply', () =>
          apply(
            state,
            (s) => renameSignal(s.source, s.ir, sig.name, name.value.trim()),
            'name taken or invalid',
          ),
        ),
      ),
    );
    showAt(ev.clientX, ev.clientY);
  }

  function showProcess(ev: MouseEvent, p: IRProcess, state: ModelState): void {
    pop.innerHTML = '';
    const name = textInput(p.name);
    const collect: (() => Splice[] | null)[] = [];
    let failMsg = '';

    if (isDelay(p)) {
      const tokens = textInput(p.tokens.join(', '));
      pop.append(title(`${p.name} (delaySDF)`), row('name', name), row('tokens', tokens));
      collect.push(() => {
        const t = parseInts(tokens.value);
        if (!t) {
          failMsg = 'tokens must be integers';
          return null;
        }
        return t.join(',') === p.tokens.join(',') ? [] : setTokens(state.ir, p.name, t);
      });
    } else {
      const inR = textInput(p.inRates.join(', '));
      const outR = textInput(p.outRates.join(', '));
      const fn = textInput(p.function === 'NULL' ? 'undefined' : p.function);
      pop.append(
        title(`${p.name} (actor${p.type.slice(5)}SDF)`),
        row('name', name),
        row('in rates', inR),
        row('out rates', outR),
        row(
          'function',
          fn,
          button('goto', () => {
            const m = new RegExp(`^${fn.value.trim()}\\b`, 'm').exec(view.state.doc.toString());
            if (!m) return fail('no definition found');
            view.dispatch({
              selection: { anchor: m.index },
              effects: EditorView.scrollIntoView(m.index, { y: 'center' }),
            });
            view.focus();
          }),
        ),
      );
      collect.push(() => {
        const ri = parseInts(inR.value);
        const ro = parseInts(outR.value);
        if (!ri || !ro) {
          failMsg = 'rates must be integers';
          return null;
        }
        const same = ri.join(',') === p.inRates.join(',') && ro.join(',') === p.outRates.join(',');
        if (same) return [];
        const s = setRates(state.ir, p.name, ri, ro);
        if (!s) failMsg = 'rates must be positive and match the actor arity';
        return s;
      });
      collect.push(() => {
        const v = fn.value.trim();
        if (v === (p.function === 'NULL' ? 'undefined' : p.function)) return [];
        const s =
          v === 'undefined'
            ? setFunction(state.ir, p.name, 'undefined')
            : setFunction(state.ir, p.name, v);
        if (!s) failMsg = 'invalid function name';
        return s;
      });
    }

    collect.push(() => {
      const v = name.value.trim();
      if (v === p.name) return [];
      const s = renameProcess(state.source, state.ir, p.name, v);
      if (!s) failMsg = 'name taken or invalid';
      return s;
    });

    pop.append(
      row(
        '',
        button('apply', () =>
          apply(
            state,
            () => {
              const all: Splice[] = [];
              for (const c of collect) {
                const s = c();
                if (!s) return null;
                all.push(...s);
              }
              return all;
            },
            () => failMsg || 'invalid input',
          ),
        ),
        button('delete', () =>
          apply(
            state,
            (s) => deleteProcess(s.source, s.ir, p.name),
            'only single-input single-output processes can be deleted here',
          ),
        ),
      ),
    );
    showAt(ev.clientX, ev.clientY);
  }

  svg.addEventListener('click', (ev) => {
    const target = ev.target as Element;
    if (pop.contains(target)) return;
    const state = current();
    if (!state) return hide();
    const edgeG = target.closest('g.edge');
    if (edgeG) {
      const meta = (state.graph as unknown as { $edgeMeta: Map<string, EdgeMeta> }).$edgeMeta.get(
        edgeG.getAttribute('data-id') ?? '',
      );
      if (meta) return showEdge(ev, meta.sig, state);
    }
    const nodeG = target.closest('g.node');
    if (nodeG) {
      const p = state.ir.processes.find((q) => q.name === nodeG.getAttribute('data-id'));
      if (p) return showProcess(ev, p, state);
    }
    hide();
  });

  return {
    addActor() {
      const state = current();
      if (!state || !liveState(state)) return;
      dispatch(addSourceActor(state.source, state.ir).splices);
    },
  };
}
