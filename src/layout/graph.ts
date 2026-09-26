import { isDelay, type IRSystem } from '../core/ir';
import { expectedPorts, type ExpectedPort } from '../scene/validate';

export interface GNode {
  id: string;
  kind: 'actor' | 'delay' | 'io';
  input: boolean;
  output: boolean;
  /** Port ids by index. */
  ins: string[];
  outs: string[];
  /** A delay's initial token count. */
  tokens: number;
}

export interface GEdge {
  id: string;
  signal: string;
  from: string;
  to: string;
  /** Scene source/target refs: port id, or the io node id. */
  source: string;
  target: string;
  feedback: boolean;
}

export interface Graph {
  nodes: Map<string, GNode>;
  edges: GEdge[];
  ports: Map<string, ExpectedPort>;
  layer: Map<string, number>;
  last: number;
}

/** Node order everything else iterates in: inputs, processes, outputs (IR order). */
function nodeList(ir: IRSystem, ports: Map<string, ExpectedPort>): Map<string, GNode> {
  const nodes = new Map<string, GNode>();
  const io = (id: string, input: boolean) => {
    const n = nodes.get(id);
    if (n) n[input ? 'input' : 'output'] = true;
    else nodes.set(id, { id, kind: 'io', input, output: !input, ins: [], outs: [], tokens: 0 });
  };
  ir.inputs.forEach((i) => io(i, true));
  for (const p of ir.processes)
    nodes.set(p.name, {
      id: p.name,
      kind: isDelay(p) ? 'delay' : 'actor',
      input: false,
      output: false,
      ins: [],
      outs: [],
      tokens: isDelay(p) ? p.tokens.length : 0,
    });
  ir.outputs.forEach((o) => io(o, false));
  const byIndex = [...ports.values()].sort((a, b) => a.index - b.index);
  for (const p of byIndex) nodes.get(p.node)?.[p.dir === 'in' ? 'ins' : 'outs'].push(p.id);
  return nodes;
}

/** Tarjan; returns the component index of every node. */
function sccs(ids: string[], succ: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const comp = new Map<string, number>();
  const stack: string[] = [];
  let next = 0;
  let c = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    for (const w of succ.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (!comp.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        comp.set(w, c);
      } while (w !== v);
      c++;
    }
  };
  for (const v of ids) if (!index.has(v)) visit(v);
  return comp;
}

/**
 * Feedback edges: first every cyclic edge leaving a delay (the lecture
 * convention), then DFS back edges for whatever cycles remain (deadlocked,
 * delay-free loops, self-loops).
 */
function markFeedback(nodes: Map<string, GNode>, edges: GEdge[]): void {
  const ids = [...nodes.keys()];
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) succ.get(e.from)!.push(e.to);
  const comp = sccs(ids, succ);
  for (const e of edges)
    if (nodes.get(e.from)!.kind === 'delay' && comp.get(e.from) === comp.get(e.to))
      e.feedback = true;

  const state = new Map<string, 1 | 2>();
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const e of edges) {
      if (e.from !== v || e.feedback) continue;
      const s = state.get(e.to);
      if (s === 1) e.feedback = true;
      else if (!s) dfs(e.to);
    }
    state.set(v, 2);
  };
  for (const v of ids) if (!state.has(v)) dfs(v);
}

/** Longest path from the sources; null when the constraints are cyclic. */
function longestPath(ids: string[], cons: [string, string][]): Map<string, number> | null {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [a, b] of cons) {
    succ.get(a)!.push(b);
    indeg.set(b, indeg.get(b)! + 1);
  }
  const layer = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (queue.length) {
    const v = queue.shift()!;
    seen++;
    for (const w of succ.get(v)!) {
      layer.set(w, Math.max(layer.get(w)!, layer.get(v)! + 1));
      indeg.set(w, indeg.get(w)! - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }
  return seen === ids.length ? layer : null;
}

export function buildGraph(ir: IRSystem): Graph {
  const ports = expectedPorts(ir);
  const nodes = nodeList(ir, ports);
  const isProc = (n: string) => nodes.get(n)?.kind !== 'io';
  const edges: GEdge[] = ir.signals.map((s) => ({
    id: `e_${s.name}_${s.source.name}_${s.target.name}`,
    signal: s.name,
    from: s.source.name,
    to: s.target.name,
    source: isProc(s.source.name) ? `${s.source.name}.out.${s.name}` : s.source.name,
    target: isProc(s.target.name) ? `${s.target.name}.in.${s.name}` : s.target.name,
    feedback: false,
  }));
  markFeedback(nodes, edges);

  // outputs are placed after the others; inputs stay in layer 0
  const inner = [...nodes.values()].filter((n) => !(n.output && !n.input)).map((n) => n.id);
  const innerSet = new Set(inner);
  const forward: [string, string][] = [];
  const reversed: [string, string][] = [];
  for (const e of edges) {
    if (e.from === e.to || !innerSet.has(e.from) || !innerSet.has(e.to)) continue;
    if (!e.feedback) forward.push([e.from, e.to]);
    else if (!nodes.get(e.from)!.input) reversed.push([e.to, e.from]);
  }
  // a reversed feedback edge keeps its target left of its source; drop that
  // wish if it contradicts the forward edges
  const layer = longestPath(inner, [...forward, ...reversed]) ?? longestPath(inner, forward)!;
  for (const n of nodes.values()) if (n.input) layer.set(n.id, 0);

  let last = Math.max(0, ...layer.values());
  for (const e of edges)
    if (!e.feedback && innerSet.has(e.from) && !innerSet.has(e.to))
      last = Math.max(last, layer.get(e.from)! + 1);
  for (const n of nodes.values()) if (!innerSet.has(n.id)) layer.set(n.id, last);
  return { nodes, edges, ports, layer, last };
}
