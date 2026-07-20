import { useLayoutEffect, useRef, useState } from 'react';
import {
  deleteProcess,
  insertOnEdge,
  renameProcess,
  renameSignal,
  setFunction,
  setRates,
  setTokens,
  type Splice,
} from '../core/edits';
import { isDelay, type IRProcess, type IRSignal } from '../core/ir';
import type { ModelState } from '../app/usePipeline';
import type { EditorApi } from '../editor/EditorPane';

export type PopoverTarget = { kind: 'node'; name: string } | { kind: 'edge'; edgeId: string };

interface Props {
  target: PopoverTarget;
  x: number;
  y: number;
  model: ModelState;
  editorRef: React.RefObject<EditorApi | null>;
  onClose(): void;
}

function parseInts(text: string): number[] | null {
  const parts = text.split(',').map((t) => t.trim());
  if (parts.some((p) => !/^-?\d+$/.test(p))) return null;
  return parts.map(Number);
}

export function EditPopover({ target, x, y, model, editorRef, onClose }: Props) {
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // clamp inside the pane once rendered
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent as HTMLElement | null;
    if (!el || !pane) return;
    setPos({
      x: Math.max(8, Math.min(x, pane.clientWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, pane.clientHeight - el.offsetHeight - 8)),
    });
  }, [x, y]);

  /** Guard: the model must still match the editor text, then apply.
      make() returns splices, or an error message string to display. */
  const apply = (make: () => Splice[] | string) => {
    const editor = editorRef.current;
    if (!editor || editor.getDoc() !== model.source) {
      setError('source changed, reopen this popover');
      return;
    }
    const result = make();
    if (typeof result === 'string') {
      setError(result);
      return;
    }
    onClose();
    editor.applySplices(result);
  };

  let body: React.ReactNode = null;
  if (target.kind === 'edge') {
    const meta = model.dg.edgeMeta.get(target.edgeId);
    if (meta) body = <EdgeBody sig={meta.sig} model={model} apply={apply} />;
  } else {
    const p = model.ir.processes.find((q) => q.name === target.name);
    if (p)
      body = <NodeBody p={p} model={model} apply={apply} editorRef={editorRef} onClose={onClose} />;
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
      {error && <div className="err">{error}</div>}
    </div>
  );
}

type Apply = (make: () => Splice[] | string) => void;

function EdgeBody({ sig, model, apply }: { sig: IRSignal; model: ModelState; apply: Apply }) {
  const [name, setName] = useState(sig.name);
  const applyRename = () =>
    apply(
      () => renameSignal(model.source, model.ir, sig.name, name.trim()) ?? 'name taken or invalid',
    );
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
        <button
          type="button"
          onClick={() => apply(() => insertOnEdge(model.source, model.ir, sig, 'actor').splices)}
        >
          actor
        </button>
        <button
          type="button"
          onClick={() => apply(() => insertOnEdge(model.source, model.ir, sig, 'delay').splices)}
        >
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
  editorRef,
  onClose,
}: {
  p: IRProcess;
  model: ModelState;
  apply: Apply;
  editorRef: React.RefObject<EditorApi | null>;
  onClose(): void;
}) {
  const delay = isDelay(p);
  const [name, setName] = useState(p.name);
  const [inR, setInR] = useState(delay ? '' : p.inRates.join(', '));
  const [outR, setOutR] = useState(delay ? '' : p.outRates.join(', '));
  const [fn, setFn] = useState(delay ? '' : p.function === 'NULL' ? 'undefined' : p.function);
  const [tokens, setTokens_] = useState(delay ? p.tokens.join(', ') : '');

  const buildSplices = (): { splices: Splice[]; error?: string } => {
    const all: Splice[] = [];
    if (delay) {
      const t = parseInts(tokens);
      if (!t) return { splices: [], error: 'tokens must be integers' };
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
      return r.error ?? r.splices;
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
            <button
              type="button"
              onClick={() => {
                const editor = editorRef.current;
                if (!editor) return;
                const m = new RegExp(`^${fn.trim()}\\b`, 'm').exec(editor.getDoc());
                if (m) {
                  onClose();
                  editor.gotoOffset(m.index);
                }
              }}
            >
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
          onClick={() =>
            apply(
              () =>
                deleteProcess(model.source, model.ir, p.name) ??
                'only single-input single-output processes can be deleted here',
            )
          }
        >
          delete
        </button>
      </label>
    </form>
  );
}
