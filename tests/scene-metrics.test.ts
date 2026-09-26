import { describe, expect, it } from 'vitest';
import { estimateMeasure } from '../src/scene/measure';
import { scoreScene } from '../src/scene/metrics';
import type { Pt, Scene, SceneEdge, SceneLabel } from '../src/scene/types';
import { sceneLabels } from '../src/scene/labels';
import { expectedPorts, validateScene } from '../src/scene/validate';
import { evaluateLayout } from './helpers/evaluate';
import { ALL_ON, DEFAULT_FLAGS, loadFixtures } from './helpers/fixtures';

// SDF_example_003: (s_out, s_1) = a_a s_in s_2; s_2 = d_1 s_1
const fx = loadFixtures().find((f) => f.name === 'SDF_example_003')!;
const ir = fx.ir;

// a_a is a circle at (140, 60) r 40; its ports sit on the circle at y 50 and 70
const PX = Math.sqrt(40 * 40 - 10 * 10);

/**
 * s_in | a_a | d_1 | s_out, with s_2 fed back under everything:
 *
 *   s_in -> a_a -> s_out
 *           a_a -> d_1 -> (loop below) -> a_a
 */
function validScene(): Scene {
  return {
    nodes: [
      {
        id: 's_in',
        kind: 'io',
        shape: 'pill',
        box: { x: 0, y: 40, w: 40, h: 20 },
        ports: [],
        layer: 0,
        order: 0,
      },
      {
        id: 'a_a',
        kind: 'actor',
        shape: 'circle',
        box: { x: 100, y: 20, w: 80, h: 80 },
        layer: 1,
        order: 0,
        ports: [
          {
            id: 'a_a.in.s_in',
            node: 'a_a',
            signal: 's_in',
            dir: 'in',
            index: 0,
            side: 'W',
            at: { x: 140 - PX, y: 50 },
            rate: 1,
          },
          {
            id: 'a_a.in.s_2',
            node: 'a_a',
            signal: 's_2',
            dir: 'in',
            index: 1,
            side: 'W',
            at: { x: 140 - PX, y: 70 },
            rate: 1,
          },
          {
            id: 'a_a.out.s_out',
            node: 'a_a',
            signal: 's_out',
            dir: 'out',
            index: 0,
            side: 'E',
            at: { x: 140 + PX, y: 50 },
            rate: 1,
          },
          {
            id: 'a_a.out.s_1',
            node: 'a_a',
            signal: 's_1',
            dir: 'out',
            index: 1,
            side: 'E',
            at: { x: 140 + PX, y: 70 },
            rate: 1,
          },
        ],
      },
      {
        id: 'd_1',
        kind: 'delay',
        shape: 'circle',
        box: { x: 240, y: 120, w: 40, h: 40 },
        layer: 2,
        order: 0,
        ports: [
          {
            id: 'd_1.in.s_1',
            node: 'd_1',
            signal: 's_1',
            dir: 'in',
            index: 0,
            side: 'W',
            at: { x: 240, y: 140 },
            rate: 1,
          },
          {
            id: 'd_1.out.s_2',
            node: 'd_1',
            signal: 's_2',
            dir: 'out',
            index: 0,
            side: 'E',
            at: { x: 280, y: 140 },
            rate: 1,
          },
        ],
      },
      {
        id: 's_out',
        kind: 'io',
        shape: 'pill',
        box: { x: 320, y: 40, w: 40, h: 20 },
        ports: [],
        layer: 3,
        order: 0,
      },
    ],
    edges: [
      edge('s_in', 's_in', 'a_a.in.s_in', [
        { x: 40, y: 50 },
        { x: 140 - PX, y: 50 },
      ]),
      edge('s_out', 'a_a.out.s_out', 's_out', [
        { x: 140 + PX, y: 50 },
        { x: 320, y: 50 },
      ]),
      edge('s_1', 'a_a.out.s_1', 'd_1.in.s_1', [
        { x: 140 + PX, y: 70 },
        { x: 210, y: 70 },
        { x: 210, y: 140 },
        { x: 240, y: 140 },
      ]),
      edge('s_2', 'd_1.out.s_2', 'a_a.in.s_2', [
        { x: 280, y: 140 },
        { x: 300, y: 140 },
        { x: 300, y: 180 },
        { x: 80, y: 180 },
        { x: 80, y: 70 },
        { x: 140 - PX, y: 70 },
      ]),
    ],
    labels: [
      label('a_a#name', 'name', 'a_a', 125, 0, 30, 15),
      label('a_a#stack', 'stack', 'a_a', 115, 50, 50, 20),
      label('s_in#signal', 'signal', 'e_s_in_s_in_a_a', 50, 30, 30, 15),
    ],
    bounds: { x: 0, y: 0, w: 360, h: 180 },
  };
}

function edge(signal: string, source: string, target: string, points: Pt[]): SceneEdge {
  const node = (ref: string) => ref.split('.')[0]!;
  return {
    id: `e_${signal}_${node(source)}_${node(target)}`,
    signal,
    source,
    target,
    points,
    feedback: signal === 's_2',
  };
}

function label(
  id: string,
  kind: SceneLabel['kind'],
  owner: string,
  x: number,
  y: number,
  w: number,
  h: number,
): SceneLabel {
  return { id, kind, owner, text: id, box: { x, y, w, h } };
}

/** A scene holding only edges, for the edge-vs-edge metrics. */
function edgesOnly(...es: [string, string, Pt[]][]): Scene {
  return {
    nodes: [],
    labels: [],
    edges: es.map(([id, source, points]) => ({
      id,
      signal: id,
      source,
      target: 't',
      points,
      feedback: false,
    })),
    bounds: { x: 0, y: 0, w: 100, h: 100 },
  };
}

describe('scoreScene', () => {
  it('scores the clean scene as overlap free', () => {
    expect(scoreScene(validScene())).toEqual({
      labelLabel: 0,
      labelNode: 0,
      labelEdge: 0,
      edgeNode: 0,
      edgeEdgeOverlap: 0,
      overlaps: 0,
      crossings: 0,
      bends: 6,
      area: 360 * 180,
    });
  });

  it('labelLabel counts intersections deeper than 0.5 px only', () => {
    const s = validScene();
    s.labels.push(label('x', 'rate', 'p', 150, 10, 10, 10)); // 5 x 5 into the name
    expect(scoreScene(s).labelLabel).toBe(1);
    s.labels.pop();
    s.labels.push(label('x', 'rate', 'p', 154.6, 10, 10, 1)); // 0.4 x 1
    expect(scoreScene(s).labelLabel).toBe(0);
  });

  it('labelNode tests the drawn shape, and keeps stacks inside their owner', () => {
    const s = validScene();
    s.labels[0]!.box.y = 10; // name bottom 25 dips below the circle top at 20
    expect(scoreScene(s).labelNode).toBe(1);

    const corner = validScene();
    corner.labels.push(label('x', 'rate', 'p', 100, 20, 6, 6)); // box corner, outside the circle
    expect(scoreScene(corner).labelNode).toBe(0);

    const wide = validScene();
    wide.labels[1]!.box = { x: 95, y: 50, w: 90, h: 20 }; // stack pokes out of its circle
    expect(scoreScene(wide).labelNode).toBe(1);

    const other = validScene();
    other.labels[1]!.owner = 'd_1'; // inside a_a, but a_a is not its owner
    expect(scoreScene(other).labelNode).toBe(1);
  });

  it('labelEdge ignores edges grazing the box by less than 0.5 px', () => {
    const s = validScene();
    s.labels[2]!.box.y = 40; // spans the s_in edge at y 50
    expect(scoreScene(s).labelEdge).toBe(1);
    s.labels[2]!.box.y = 35.4; // bottom at 50.4
    expect(scoreScene(s).labelEdge).toBe(0);
  });

  it('edgeNode counts an edge through a foreign node, not its own attach points', () => {
    const s = validScene();
    s.edges[2]!.points = [
      { x: 140 + PX, y: 70 },
      { x: 290, y: 70 },
      { x: 290, y: 140 },
      { x: 240, y: 140 }, // enters d_1 from the east side, through its body
    ];
    expect(scoreScene(s).edgeNode).toBe(1);

    const through = validScene();
    through.edges[0]!.points = [
      { x: 40, y: 50 },
      { x: 90, y: 50 },
      { x: 90, y: 60 },
      { x: 200, y: 60 },
      { x: 200, y: 50 },
      { x: 140 - PX, y: 50 },
    ];
    expect(scoreScene(through).edgeNode).toBe(1);
  });

  it('edgeEdgeOverlap counts collinear runs longer than 1 px', () => {
    const a: Pt[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ];
    expect(
      scoreScene(
        edgesOnly(
          ['a', 'p', a],
          [
            'b',
            'q',
            [
              { x: 40, y: 0 },
              { x: 90, y: 0 },
            ],
          ],
        ),
      ).edgeEdgeOverlap,
    ).toBe(1);
    expect(
      scoreScene(
        edgesOnly(
          ['a', 'p', a],
          [
            'b',
            'q',
            [
              { x: 49.5, y: 0 },
              { x: 90, y: 0 },
            ],
          ],
        ),
      ).edgeEdgeOverlap,
    ).toBe(0);
    expect(
      scoreScene(
        edgesOnly(
          ['a', 'p', a],
          [
            'b',
            'q',
            [
              { x: 0, y: 2 },
              { x: 50, y: 2 },
            ],
          ],
        ),
      ).edgeEdgeOverlap,
    ).toBe(0);
    const fork: Pt[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 30 },
    ];
    expect(scoreScene(edgesOnly(['a', 'p', a], ['b', 'p', fork])).edgeEdgeOverlap).toBe(0);
  });

  it('crossings counts proper crossings only', () => {
    const h: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(
      scoreScene(
        edgesOnly(
          ['a', 'p', h],
          [
            'b',
            'q',
            [
              { x: 5, y: -5 },
              { x: 5, y: 5 },
            ],
          ],
        ),
      ).crossings,
    ).toBe(1);
    expect(
      scoreScene(
        edgesOnly(
          ['a', 'p', h],
          [
            'b',
            'q',
            [
              { x: 5, y: 0 },
              { x: 5, y: 5 },
            ],
          ],
        ),
      ).crossings,
    ).toBe(0);
    expect(
      scoreScene(
        edgesOnly(
          ['a', 'p', h],
          [
            'b',
            'q',
            [
              { x: 15, y: -5 },
              { x: 15, y: 5 },
            ],
          ],
        ),
      ).crossings,
    ).toBe(0);
  });

  it('labelLabel ignores slivers thinner than 0.5 px however long', () => {
    const s = validScene();
    s.labels.push(label('x', 'rate', 'p', 154.6, 0, 10, 15)); // 0.4 x 15 into the name
    expect(scoreScene(s).labelLabel).toBe(0);
  });

  it('bends and crossings see the drawn polyline, not repeated or straight-through points', () => {
    const v: Pt[] = [
      { x: 5, y: -5 },
      { x: 5, y: 0 }, // on the other edge, where the vertical passes straight through
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ];
    const h: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const m = scoreScene(edgesOnly(['a', 'p', h], ['b', 'q', v]));
    expect(m.bends).toBe(0);
    expect(m.crossings).toBe(1);
    // a U-turn is drawn, so its middle point stays a bend
    const u: Pt[] = [
      { x: 0, y: 50 },
      { x: 20, y: 50 },
      { x: 10, y: 50 },
    ];
    expect(scoreScene(edgesOnly(['a', 'p', u])).bends).toBe(1);
  });

  it('edgeEdgeOverlap spares only the shared trunk of two edges from one port', () => {
    const a: Pt[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 30 },
      { x: 60, y: 30 },
    ];
    const b: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
      { x: 80, y: 30 }, // parts at x 10, then runs on top of a again at y 30
    ];
    expect(scoreScene(edgesOnly(['a', 'p', a], ['b', 'p', b])).edgeEdgeOverlap).toBe(1);
  });

  it('edgeEdgeOverlap counts parallel lines closer than the stroke can separate', () => {
    const a: Pt[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ];
    const b: Pt[] = [
      { x: 0, y: 1 },
      { x: 50, y: 1 },
    ];
    expect(scoreScene(edgesOnly(['a', 'p', a], ['b', 'q', b])).edgeEdgeOverlap).toBe(1);
  });

  it('area is the content box, not the declared bounds', () => {
    const s = validScene();
    s.bounds = { x: -100, y: -100, w: 1000, h: 1000 };
    expect(scoreScene(s).area).toBe(360 * 180);
  });

  it('overlaps sums the five overlap kinds', () => {
    const s = validScene();
    s.labels[0]!.box.y = 10;
    s.labels[2]!.box.y = 40;
    const m = scoreScene(s);
    expect(m.overlaps).toBe(
      m.labelLabel + m.labelNode + m.labelEdge + m.edgeNode + m.edgeEdgeOverlap,
    );
    expect(m.overlaps).toBe(2);
  });
});

describe('validateScene', () => {
  const errorsAfter = (mutate: (s: Scene) => void): string[] => {
    const s = validScene();
    mutate(s);
    return validateScene(s, ir);
  };
  const node = (s: Scene, id: string) => s.nodes.find((n) => n.id === id)!;
  const port = (s: Scene, id: string) => s.nodes.flatMap((n) => n.ports).find((p) => p.id === id)!;

  it('accepts the clean scene', () => {
    expect(validateScene(validScene(), ir)).toEqual([]);
  });

  it('derives out-port indices from the tuple, not the signal order', () => {
    // ir.signals lists s_1 (consumed by d_1) before s_out (a system output)
    const names = ir.signals.filter((s) => s.source.name === 'a_a').map((s) => s.name);
    expect(names).toEqual(['s_1', 's_out']);
    const ports = expectedPorts(ir);
    expect(ports.get('a_a.out.s_out')?.index).toBe(0);
    expect(ports.get('a_a.out.s_1')?.index).toBe(1);
    expect(ports.get('a_a.in.s_in')?.index).toBe(0);
    expect(ports.get('a_a.in.s_2')?.index).toBe(1);
  });

  it('wants exactly one node per process and io', () => {
    expect(errorsAfter((s) => s.nodes.splice(2, 1))).toContain('node d_1: 0 nodes, expected 1');
    expect(errorsAfter((s) => s.nodes.push(structuredClone(node(s, 's_out'))))).toContain(
      'node s_out: 2 nodes, expected 1',
    );
    expect(errorsAfter((s) => (node(s, 'd_1').kind = 'actor'))).toContain(
      'node d_1: kind actor, expected delay',
    );
  });

  it('wants exactly one edge per signal with the right id and ends', () => {
    expect(errorsAfter((s) => s.edges.splice(3, 1))).toContain(
      'edge e_s_2_d_1_a_a: 0 edges, expected 1',
    );
    expect(errorsAfter((s) => (s.edges[0]!.id = 'e_s_in_x_a_a'))).toContain(
      'edge e_s_in_x_a_a: not in the IR',
    );
    expect(errorsAfter((s) => (s.edges[2]!.source = 'a_a.out.s_out'))).toContain(
      'edge e_s_1_a_a_d_1: source a_a.out.s_out, expected a_a.out.s_1',
    );
  });

  it('wants edges to start and end at their attach points', () => {
    expect(errorsAfter((s) => (s.edges[2]!.points[0] = { x: 190, y: 70 })).join()).toMatch(
      /e_s_1_a_a_d_1: starts at/,
    );
    // s_out ends at the io node: anywhere on its box border, not inside it
    const bent = [
      { x: 140 + PX, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 45 },
      { x: 320, y: 45 },
    ];
    expect(errorsAfter((s) => (s.edges[1]!.points = bent))).toEqual([]);
    expect(errorsAfter((s) => (s.edges[1]!.points[1] = { x: 330, y: 50 })).join()).toMatch(
      /e_s_out_a_a_s_out: ends at/,
    );
  });

  it('wants orthogonal segments', () => {
    const errs = errorsAfter((s) => s.edges[2]!.points.splice(1, 1));
    expect(errs.join()).toMatch(/e_s_1_a_a_d_1: segment 0 .* is not orthogonal/);
  });

  it('wants ports on the node outline', () => {
    const errs = errorsAfter((s) => {
      port(s, 'a_a.in.s_in').at = { x: 100, y: 50 }; // box border, not the circle
      s.edges[0]!.points[1] = { x: 100, y: 50 };
    });
    expect(errs).toEqual(['port a_a.in.s_in: at (100, 50) is off the node outline']);
  });

  // ports may sit in any order on their side (layout reorders them to save
  // a crossing and tags them with index labels), but each keeps its index
  it('wants the argument index on every port, and ports on a side apart', () => {
    const errs = errorsAfter((s) => {
      port(s, 'a_a.in.s_in').index = 1;
      port(s, 'a_a.in.s_2').index = 0;
    });
    expect(errs).toEqual([
      'port a_a.in.s_in: index 1, expected 0',
      'port a_a.in.s_2: index 0, expected 1',
    ]);
    expect(
      errorsAfter((s) => (port(s, 'a_a.in.s_2').at = { ...port(s, 'a_a.in.s_in').at })),
    ).toContain(`node a_a: two in ports at y ${port(validScene(), 'a_a.in.s_in').at.y}`);
  });

  it('wants inputs in the first layer and outputs in the last', () => {
    expect(errorsAfter((s) => (node(s, 's_in').layer = 1))).toContain(
      'node s_in: system input in layer 1, not 0',
    );
    expect(errorsAfter((s) => (node(s, 'd_1').layer = 4))).toContain(
      'node s_out: system output in layer 3, not 4',
    );
  });

  it('wants disjoint node boxes', () => {
    expect(errorsAfter((s) => (node(s, 's_in').box.x = 70))).toContain(
      'node s_in: box intersects node a_a',
    );
  });

  it('wants bounds around everything', () => {
    const errs = errorsAfter((s) => (s.bounds.h = 170));
    expect(errs).toEqual(['bounds: edge e_s_2_d_1_a_a sticks out']);
    expect(errorsAfter((s) => (s.bounds.y = 5))).toContain('bounds: label a_a#name sticks out');
  });

  it('wants the declared shape to match the box', () => {
    expect(errorsAfter((s) => (node(s, 'd_1').box.w = 50))).toContain(
      'node d_1: circle in a 50 x 40 box',
    );
    expect(errorsAfter((s) => (node(s, 's_in').shape = 'circle'))).toContain(
      'node s_in: io drawn as circle',
    );
  });

  it('wants layer numbers to run left to right', () => {
    // s_in keeps layer 0 but is drawn right of everything
    const errs = errorsAfter((s) => (node(s, 's_in').box.x = 400));
    expect(errs).toContain('node a_a: layer 1 is not right of node s_in in layer 0');
  });

  it('wants labels near what they annotate', () => {
    expect(errorsAfter((s) => (s.labels[2]!.box.y = 500)).join()).toMatch(
      /label s_in#signal: 450.0 px from e_s_in_s_in_a_a/,
    );
    expect(errorsAfter((s) => (s.labels[0]!.owner = 'e_s_in_s_in_a_a'))).toContain(
      'label a_a#name: owner e_s_in_s_in_a_a is not a name owner in the scene',
    );
  });

  it('with flags, wants exactly the visible labels at full size', () => {
    const flags = { ...DEFAULT_FLAGS, rates: false, functions: false, buffers: false };
    const ctx = { schedule: fx.schedule, flags, measure: estimateMeasure };
    const want = sceneLabels(ir, fx.schedule, flags);
    expect(want.map((l) => `${l.kind} ${l.owner}`).sort()).toEqual(
      [
        'badge a_a',
        'name a_a',
        'name d_1',
        'signal e_s_1_a_a_d_1',
        'signal e_s_2_d_1_a_a',
        'signal e_s_in_s_in_a_a',
        'signal e_s_out_a_a_s_out',
        'stack a_a',
        'stack d_1',
      ].sort(),
    );
    // functions hidden: the actor stack keeps only its constructor line
    expect(want.find((l) => l.kind === 'stack' && l.owner === 'a_a')?.text).toBe('actor22SDF');

    const s = validScene();
    const errs = validateScene(s, ir, ctx);
    expect(errs).toContain('label signal e_s_2_d_1_a_a "s_2": missing');
    expect(errs.join()).toMatch(/label a_a#stack: stack a_a "a_a#stack" is not expected/);
    expect(errs.join()).toMatch(/label s_in#signal: 30 x 15 box, its text needs/);
  });

  it('rejects NaN', () => {
    expect(errorsAfter((s) => (s.labels[0]!.box.x = NaN))).toContain(
      'label a_a#name: non-finite number',
    );
  });
});

describe('evaluateLayout', () => {
  it('catches state leaking between calls, which a back-to-back rerun cannot', () => {
    const pure = evaluateLayout(() => validScene(), { flags: [ALL_ON] });
    expect(pure.nondeterministic).toEqual([]);
    expect(pure.runs).toBe(2 * 35);
    expect(Object.keys(pure.perFixture)).toHaveLength(35);

    const seen = new Set<unknown>();
    const leaky = evaluateLayout(
      (input) => {
        seen.add(input.ir);
        const s = validScene();
        s.bounds.x = seen.size; // same answer twice in a row, different after other fixtures
        return s;
      },
      { flags: [ALL_ON] },
    );
    expect(leaky.nondeterministic.length).toBeGreaterThan(0);
  });
});

describe('estimateMeasure', () => {
  it('measures rates and buffers bold, as the default theme draws them', () => {
    expect(estimateMeasure('buf 3', 'buffer').w).toBeCloseTo(
      1.1 * 10 * (0.65 + 0.65 + 0.4 + 0.35 + 0.65),
    );
  });

  it('is deterministic and grows with text, lines and font size', () => {
    const a = estimateMeasure('map', 'signal');
    expect(estimateMeasure('map', 'signal')).toEqual(a);
    expect(estimateMeasure('mapm', 'signal').w).toBeGreaterThan(a.w);
    expect(estimateMeasure('map', 'name').w).toBeGreaterThan(a.w);
    expect(estimateMeasure('actor11SDF\n1 1\nf', 'stack')).toEqual({
      w: estimateMeasure('actor11SDF', 'stack').w,
      h: 42,
    });
  });
});
