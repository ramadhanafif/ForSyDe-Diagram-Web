import { useLayoutEffect, useRef, useState } from 'react';
import { balanceEquation, channelOf, processFacts, type Analysis } from '../core/analysis';
import {
  deleteProcess,
  insertOnEdge,
  outputRenames,
  renameProcess,
  renameSignal,
  setFunction,
  setRates,
  setTokens,
  type Splice,
} from '../core/edits';
import { parseInts, parseTokens } from '../core/inlineEdit';
import { isDelay, type IRProcess, type IRSignal } from '../core/ir';
import type { SceneModel } from '../app/useScene';
import type { EditorApi } from '../editor/EditorPane';

export type PopoverTarget = { kind: 'node'; name: string } | { kind: 'edge'; edgeId: string };

/** Minimum gap between the popover and the pane edge. */
export const POPOVER_MARGIN = 8;

/**
 * Runs `make` only while the diagram shows the editor text as it is; returns
 * why it refused, or make's own refusal, else null. `quiet` leaves showing
 * the refusal to the caller.
 */
export type EditGuard = (
  make: (model: SceneModel, editor: EditorApi) => string | void,
  quiet?: boolean,
) => string | null;

interface Props {
  target: PopoverTarget;
  x: number;
  y: number;
  model: SceneModel;
  /** App's analysis of the model, null when it has none. */
  facts: Analysis | null;
  editGuarded: EditGuard;
  /** Go to a function's definition in the editor; false when there is none. */
  onGoto(fn: string): boolean;
  onClose(): void;
  /** A process was inserted on the target edge (before its splices apply). */
  onInserted?(proc: string): void;
  /** A process or signal is being renamed; the layout carries its position. */
  onRenamed?(oldId: string, newId: string): void;
  /** What the run shows about the target, such as what a stuck actor waits for. */
  notes?: string[];
}

export function EditPopover({
  target,
  x,
  y,
  model,
  facts,
  editGuarded,
  onGoto,
  onClose,
  onInserted,
  onRenamed,
  notes,
}: Props) {
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // clamp inside the pane once rendered
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent as HTMLElement | null;
    if (!el || !pane) return;
    setPos({
      x: Math.max(POPOVER_MARGIN, Math.min(x, pane.clientWidth - el.offsetWidth - POPOVER_MARGIN)),
      y: Math.max(
        POPOVER_MARGIN,
        Math.min(y, pane.clientHeight - el.offsetHeight - POPOVER_MARGIN),
      ),
    });
  }, [x, y]);

  /** Guard: the model must still match the editor text, then apply.
      make() returns splices, or an error message string to display. */
  const apply = (make: () => Splice[] | string) => {
    const refused = editGuarded((_, editor) => {
      const result = make();
      if (typeof result === 'string') return result;
      onClose();
      editor.applySplices(result);
    }, true);
    if (refused) setError(refused);
  };

  let body: React.ReactNode = null;
  if (target.kind === 'edge') {
    const sig = model.edgeSignals.get(target.edgeId);
    if (sig)
      body = (
        <EdgeBody
          sig={sig}
          model={model}
          apply={apply}
          onInserted={onInserted}
          onRenamed={onRenamed}
        />
      );
  } else {
    const p = model.ir.processes.find((q) => q.name === target.name);
    if (p)
      body = (
        <NodeBody
          p={p}
          model={model}
          apply={apply}
          onGoto={(fn) => {
            if (onGoto(fn)) onClose();
          }}
          onRenamed={onRenamed}
        />
      );
  }
  if (!body) return null;

  return (
    <div
      className="popover"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {body}
      {facts && <Facts target={target} model={model} facts={facts} />}
      {notes?.map((n) => (
        <div key={n} className="pop-note">
          {n}
        </div>
      ))}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

/** The SDF meaning of the target: firings, rates and balance equations with numbers. */
function Facts({
  target,
  model,
  facts,
}: {
  target: PopoverTarget;
  model: SceneModel;
  facts: Analysis;
}) {
  let rows: { text: string; eq?: string }[];
  if (target.kind === 'node') rows = processFacts(facts, target.name);
  else {
    const sig = model.edgeSignals.get(target.edgeId);
    const c = sig && channelOf(facts, sig.name, sig.source.name);
    // a delay folds its two signals into one buffer, named after the input signal
    const sched = model.schedule.ok ? model.schedule : null;
    const key = sig && (sched?.aliases.get(sig.name) ?? sig.name);
    const buffer = sched?.buffers.find(([n]) => n === key)?.[1];
    rows = c
      ? [
          {
            text: `${c.src} writes ${c.prod}, ${c.dst} reads ${c.cons} per firing`,
            eq: balanceEquation(c, facts.q),
          },
        ]
      : [];
    if (buffer !== undefined)
      rows.push({
        text: `holds at most ${buffer} token${buffer === 1 ? '' : 's'} in this schedule`,
      });
  }
  if (!rows.length) return null;
  return (
    <div className="pop-facts">
      {rows.map((r) => (
        <div key={r.text}>
          {r.text}
          {r.eq && <code>{r.eq}</code>}
        </div>
      ))}
    </div>
  );
}

type Apply = (make: () => Splice[] | string) => void;

function EdgeBody({
  sig,
  model,
  apply,
  onInserted,
  onRenamed,
}: {
  sig: IRSignal;
  model: SceneModel;
  apply: Apply;
  onInserted?(proc: string): void;
  onRenamed?(oldId: string, newId: string): void;
}) {
  const [name, setName] = useState(sig.name);
  const applyRename = () =>
    apply(() => {
      const splices = renameSignal(model.source, model.ir, sig.name, name.trim());
      if (!splices) return 'name taken or invalid';
      onRenamed?.(sig.name, name.trim());
      return splices;
    });
  // an insert lands at the edge's middle, and an output it rewires keeps its spot
  const insert = (kind: 'actor' | 'delay') =>
    apply(() => {
      const r = insertOnEdge(model.source, model.ir, sig, kind);
      onInserted?.(r.created[0]!);
      for (const [a, b] of outputRenames(model.ir, r.splices)) onRenamed?.(a, b);
      return r.splices;
    });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyRename();
      }}
    >
      <div className="pop-title">signal {sig.name}</div>
      <label className="row">
        <span>insert</span>
        <button type="button" onClick={() => insert('actor')}>
          actor
        </button>
        <button type="button" onClick={() => insert('delay')}>
          delay
        </button>
      </label>
      <label className="row">
        <span>rename</span>
        <input
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit">apply</button>
      </label>
    </form>
  );
}

function NodeBody({
  p,
  model,
  apply,
  onGoto,
  onRenamed,
}: {
  p: IRProcess;
  model: SceneModel;
  apply: Apply;
  onGoto(fn: string): void;
  onRenamed?(oldId: string, newId: string): void;
}) {
  const delay = isDelay(p);
  const [name, setName] = useState(p.name);
  const [inR, setInR] = useState(delay ? '' : p.inRates.join(', '));
  const [outR, setOutR] = useState(delay ? '' : p.outRates.join(', '));
  const [fn, setFn] = useState(delay ? '' : p.function === 'NULL' ? 'undefined' : p.function);
  const [tokens, setTokens_] = useState(delay ? p.tokens.join(', ') : '');
  const [confirmDelete, setConfirmDelete] = useState('');
  const armed = confirmDelete === p.name;

  const buildSplices = (): { splices: Splice[]; error?: string } => {
    const all: Splice[] = [];
    if (delay) {
      const t = parseTokens(tokens);
      if (!t) return { splices: [], error: 'tokens must be numbers' };
      if (t.join(',') !== p.tokens.join(',')) {
        const s = setTokens(model.ir, p.name, t);
        if (!s) return { splices: [], error: 'invalid tokens' };
        all.push(...s);
      }
    } else {
      const ri = parseInts(inR);
      const ro = parseInts(outR);
      if (!ri || !ro) return { splices: [], error: 'rates must be integers' };
      if (ri.join(',') !== p.inRates.join(',') || ro.join(',') !== p.outRates.join(',')) {
        const s = setRates(model.ir, p.name, ri, ro);
        if (!s) return { splices: [], error: 'rates must be positive and match the actor arity' };
        all.push(...s);
      }
      const fv = fn.trim();
      if (fv !== (p.function === 'NULL' ? 'undefined' : p.function)) {
        const s = setFunction(model.ir, p.name, fv);
        if (!s) return { splices: [], error: 'invalid function name' };
        all.push(...s);
      }
    }
    const nv = name.trim();
    if (nv !== p.name) {
      const s = renameProcess(model.source, model.ir, p.name, nv);
      if (!s) return { splices: [], error: 'name taken or invalid' };
      all.push(...s);
    }
    return { splices: all };
  };

  const applyAll = () =>
    apply(() => {
      const r = buildSplices();
      if (r.error) return r.error;
      if (name.trim() !== p.name) onRenamed?.(p.name, name.trim());
      return r.splices;
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyAll();
      }}
    >
      <div className="pop-title">
        {p.name} ({delay ? 'delaySDF' : `actor${p.type.slice(5)}SDF`})
      </div>
      <label className="row">
        <span>name</span>
        <input
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {delay ? (
        <label className="row">
          <span>tokens</span>
          <input value={tokens} spellCheck={false} onChange={(e) => setTokens_(e.target.value)} />
        </label>
      ) : (
        <>
          <label className="row">
            <span>in rates</span>
            <input value={inR} spellCheck={false} onChange={(e) => setInR(e.target.value)} />
          </label>
          <label className="row">
            <span>out rates</span>
            <input value={outR} spellCheck={false} onChange={(e) => setOutR(e.target.value)} />
          </label>
          <label className="row">
            <span>function</span>
            <input value={fn} spellCheck={false} onChange={(e) => setFn(e.target.value)} />
            <button type="button" onClick={() => onGoto(fn.trim())}>
              goto
            </button>
          </label>
        </>
      )}
      <label className="row">
        <span />
        <button type="submit">apply</button>
        <button
          type="button"
          onClick={() => {
            if (!armed) {
              setConfirmDelete(p.name);
              return;
            }
            setConfirmDelete('');
            apply(() => {
              const splices = deleteProcess(model.ir, p.name);
              if (!splices) return 'only single-input single-output processes can be deleted here';
              // an output rewired to the deleted process's input keeps its spot
              for (const [a, b] of outputRenames(model.ir, splices)) onRenamed?.(a, b);
              return splices;
            });
          }}
        >
          {armed ? 'confirm delete?' : 'delete'}
        </button>
      </label>
    </form>
  );
}
