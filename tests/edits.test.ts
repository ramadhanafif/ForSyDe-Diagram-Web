import { describe, expect, it } from 'vitest';
import {
  addInput,
  addSourceActor,
  applySplices,
  deleteProcess,
  insertOnEdge,
  renameProcess,
  renameSignal,
  setFunction,
  setRates,
  setTokens,
} from '../src/core/edits';
import { elaborate } from '../src/core/elaborate';
import type { IRSystem } from '../src/core/ir';
import { parse } from '../src/core/parser';

const MODEL = `module M where
import ForSyDe.Shallow
system s_in = s_out
  where
    s_1 = a_a s_in
    s_2 = d_d s_1
    s_out = a_b s_2
a_a = actor11SDF 1 2 f
d_d = delaySDF [0]
a_b = actor11SDF 2 1 g
f :: [Int] -> [Int]
f [x] = [x, x]
g :: [Int] -> [Int]
g [x, y] = [x + y]
`;

function build(source: string): IRSystem {
  const { module: mod, diagnostics } = parse(source);
  const { ir, diagnostics: elabDiags } = elaborate(mod);
  const errors = [...diagnostics, ...elabDiags].filter((d) => d.severity === 'error');
  expect(errors).toEqual([]);
  expect(ir).not.toBeNull();
  return ir!;
}

/** Apply an edit and re-elaborate; every op must leave the model valid. */
function roundTrip(source: string, splices: { from: number; to: number; insert: string }[]) {
  const next = applySplices(source, splices);
  return { next, ir: build(next) };
}

const edgeByName = (ir: IRSystem, name: string, target?: string) =>
  ir.signals.find((s) => s.name === name && (!target || s.target.name === target))!;

describe('diagram edit operations', () => {
  it('inserts an actor on a mid-graph edge', () => {
    const ir = build(MODEL);
    const { splices, created } = insertOnEdge(MODEL, ir, edgeByName(ir, 's_1'), 'actor');
    const { next, ir: ir2 } = roundTrip(MODEL, splices);
    const [proc, sig, fn] = created;
    expect(ir2.processes.map((p) => p.name)).toContain(proc);
    // new actor consumes s_1, delay now consumes the fresh signal
    expect(ir2.signals.some((s) => s.name === 's_1' && s.target.name === proc)).toBe(true);
    expect(ir2.signals.some((s) => s.name === sig && s.target.name === 'd_d')).toBe(true);
    // runnable function stub appended
    expect(next).toContain(`${fn} :: [Int] -> [Int]`);
    expect(next).toContain(`${fn} _ = replicate 1 0`);
  });

  it('inserts a delay on a system-output edge', () => {
    const ir = build(MODEL);
    const edge = edgeByName(ir, 's_out', 's_out');
    const { splices, created } = insertOnEdge(MODEL, ir, edge, 'delay');
    const { ir: ir2 } = roundTrip(MODEL, splices);
    const [proc, sig] = created;
    expect(ir2.processes.some((p) => p.name === proc && p.type === 'Delay')).toBe(true);
    expect(ir2.outputs).toEqual([sig]);
    expect(ir2.signals.some((s) => s.name === 's_out' && s.target.name === proc)).toBe(true);
  });

  it('adds a source actor wired to a new input and output', () => {
    const ir = build(MODEL);
    const { splices, created } = addSourceActor(MODEL, ir);
    const { ir: ir2 } = roundTrip(MODEL, splices);
    const [proc, inSig, outSig] = created;
    expect(ir2.inputs).toContain(inSig);
    expect(ir2.outputs).toEqual(['s_out', outSig]);
    expect(ir2.signals.some((s) => s.name === inSig && s.target.name === proc)).toBe(true);
  });

  it('adds a source actor when outputs are already a tuple', () => {
    const ir = build(MODEL);
    const once = applySplices(MODEL, addSourceActor(MODEL, ir).splices);
    const ir2 = build(once);
    const { splices } = addSourceActor(once, ir2);
    const { ir: ir3 } = roundTrip(once, splices);
    expect(ir3.outputs.length).toBe(3);
  });

  it('edits rates, function and tokens in place', () => {
    const ir = build(MODEL);
    let next = applySplices(MODEL, setRates(ir, 'a_a', [3], [4])!);
    next = applySplices(next, setFunction(build(next), 'a_a', 'g')!);
    next = applySplices(next, setTokens(build(next), 'd_d', [1, 2])!);
    const ir2 = build(next);
    const aa = ir2.processes.find((p) => p.name === 'a_a')!;
    expect(aa).toMatchObject({ inRates: [3], outRates: [4], function: 'g' });
    expect(ir2.processes.find((p) => p.name === 'd_d')).toMatchObject({ tokens: [1, 2] });
  });

  it('rejects invalid rate and name edits', () => {
    const ir = build(MODEL);
    expect(setRates(ir, 'a_a', [0], [1])).toBeNull();
    expect(setRates(ir, 'a_a', [1, 1], [1])).toBeNull();
    expect(renameProcess(MODEL, ir, 'a_a', 's_in')).toBeNull(); // taken
    expect(renameSignal(MODEL, ir, 's_1', '9bad')).toBeNull();
  });

  it('renames a process everywhere', () => {
    const ir = build(MODEL);
    const { ir: ir2 } = roundTrip(MODEL, renameProcess(MODEL, ir, 'a_a', 'splitter')!);
    expect(ir2.processes.map((p) => p.name)).toContain('splitter');
    expect(ir2.signals.some((s) => s.source.name === 'splitter')).toBe(true);
  });

  it('renames a signal everywhere', () => {
    const ir = build(MODEL);
    const { next, ir: ir2 } = roundTrip(MODEL, renameSignal(MODEL, ir, 's_1', 's_mid')!);
    expect(ir2.signals.some((s) => s.name === 's_mid')).toBe(true);
    expect(next).not.toMatch(/\bs_1\b/);
  });

  it('deletes a 1-in-1-out process and rewires its consumer', () => {
    const ir = build(MODEL);
    const { ir: ir2 } = roundTrip(MODEL, deleteProcess(MODEL, ir, 'd_d')!);
    expect(ir2.processes.map((p) => p.name)).toEqual(['a_a', 'a_b']);
    expect(ir2.signals.some((s) => s.name === 's_1' && s.target.name === 'a_b')).toBe(true);
  });

  it('insert-then-delete restores the original wiring', () => {
    const ir = build(MODEL);
    const { splices, created } = insertOnEdge(MODEL, ir, edgeByName(ir, 's_1'), 'delay');
    const inserted = applySplices(MODEL, splices);
    const irIns = build(inserted);
    const restored = applySplices(inserted, deleteProcess(inserted, irIns, created[0]!)!);
    const irBack = build(restored);
    expect(irBack.processes.map((p) => p.name)).toEqual(ir.processes.map((p) => p.name));
    expect(irBack.signals.map((s) => [s.name, s.source.name, s.target.name])).toEqual(
      ir.signals.map((s) => [s.name, s.source.name, s.target.name]),
    );
  });

  it('adds an input to an actor from an unconsumed signal (drag-to-connect)', () => {
    // s_out is only a system output, so it may fan into a_a as a new input
    const ir = build(MODEL);
    const splices = addInput(MODEL, ir, 'a_a', 's_out');
    expect(splices).not.toBeNull();
    const { next, ir: ir2 } = roundTrip(MODEL, splices!);
    expect(next).toContain('a_a = actor21SDF (1, 1) 2 f');
    expect(next).toContain('s_1 = a_a s_in s_out');
    expect(ir2.signals.some((s) => s.name === 's_out' && s.target.name === 'a_a')).toBe(true);
  });

  it('adds a third input, extending an existing rate tuple', () => {
    const ir = build(MODEL);
    const once = applySplices(MODEL, addInput(MODEL, ir, 'a_a', 's_out')!);
    const irOnce = build(once);
    // wire in a fresh system input as well
    const withInput = applySplices(once, addSourceActor(once, irOnce).splices);
    const ir2 = build(withInput);
    const freeSignal = ir2.outputs.find((o) => o !== 's_out')!;
    const splices = addInput(withInput, ir2, 'a_a', freeSignal);
    expect(splices).not.toBeNull();
    const { next } = roundTrip(withInput, splices!);
    expect(next).toMatch(/a_a = actor31SDF \(1, 1, 1\) 2 f/);
  });

  it('refuses invalid connect targets and sources', () => {
    const ir = build(MODEL);
    expect(addInput(MODEL, ir, 'd_d', 's_out')).toBeNull(); // delay target
    expect(addInput(MODEL, ir, 'a_a', 's_1')).toBeNull(); // s_1 already consumed by d_d
    expect(addInput(MODEL, ir, 'a_b', 's_out')).toBeNull(); // self-loop: a_b produces s_out
    expect(addInput(MODEL, ir, 'a_a', 's_ghost')).toBeNull(); // unknown signal
    const eta = MODEL.replace('a_a = actor11SDF 1 2 f', 'a_a s = actor11SDF 1 2 f s');
    const irEta = build(eta);
    expect(addInput(eta, irEta, 'a_a', 's_out')).toBeNull(); // eta-expanded spec
  });

  it('refuses to delete a multi-port process', () => {
    const src = MODEL.replace('a_a = actor11SDF 1 2 f', 'a_a = actor12SDF 1 (2, 2) f').replace(
      's_1 = a_a s_in',
      '(s_1, s_x) = a_a s_in',
    );
    // consume s_x too so the model stays valid
    const src2 = src
      .replace('s_out = a_b s_2', 's_out = a_b s_2\n    s_y = d_e s_x')
      .replace('d_d = delaySDF [0]', 'd_d = delaySDF [0]\nd_e = delaySDF [0]');
    const ir = build(src2);
    expect(deleteProcess(src2, ir, 'a_a')).toBeNull();
  });
});
