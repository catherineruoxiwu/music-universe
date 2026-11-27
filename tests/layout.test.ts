import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/builder';
import { Camera, distanceSqToSegment, segmentIntersectsRect } from '../src/graph/camera';
import { ForceLayout } from '../src/graph/layout';
import { UniverseSnapshot } from '../src/graph/snapshot';
import { demoData } from './fixtures';

const data = demoData();
const graph = buildGraph(data);

function laidOut(seed = new Map<string, [number, number]>()): ForceLayout {
  const layout = new ForceLayout(graph, seed);
  layout.run();
  return layout;
}

describe('force layout', () => {
  const layout = laidOut();

  it('gives every node a finite position', () => {
    expect(layout.xs.every(Number.isFinite)).toBe(true);
    expect(layout.ys.every(Number.isFinite)).toBe(true);
  });

  it('arrives at the same map every time', () => {
    const again = laidOut();
    expect(Array.from(again.xs)).toEqual(Array.from(layout.xs));
    expect(Array.from(again.ys)).toEqual(Array.from(layout.ys));
  });

  it('leaves no two nodes on top of each other', () => {
    let overlaps = 0;
    for (const a of graph.nodes) {
      for (const b of graph.nodes) {
        if (b.index <= a.index) continue;
        const distance = Math.hypot(layout.xs[a.index] - layout.xs[b.index], layout.ys[a.index] - layout.ys[b.index]);
        if (distance < a.radius + b.radius) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('puts linked creators closer together than unlinked ones', () => {
    const distance = (a: number, b: number) => Math.hypot(layout.xs[a] - layout.xs[b], layout.ys[a] - layout.ys[b]);
    const linked = graph.edges.reduce((sum, e) => sum + distance(e.a, e.b), 0) / graph.edges.length;
    let total = 0;
    let pairs = 0;
    for (let a = 0; a < graph.nodes.length; a += 7) {
      for (let b = a + 1; b < graph.nodes.length; b += 5) {
        total += distance(a, b);
        pairs++;
      }
    }
    expect(linked).toBeLessThan((total / pairs) * 0.5);
  });

  it('keeps a settled map recognisable when it is laid out again', () => {
    const seed = new Map(graph.nodes.map((node) => [node.id, [layout.xs[node.index], layout.ys[node.index]] as [number, number]]));
    const resumed = new ForceLayout(graph, seed);
    expect(resumed.seededCount).toBe(graph.nodes.length);
    expect(resumed.isIncremental).toBe(true);
    resumed.run();

    const moved = graph.nodes
      .map((node) => Math.hypot(resumed.xs[node.index] - layout.xs[node.index], resumed.ys[node.index] - layout.ys[node.index]))
      .sort((a, b) => a - b);
    const width = Math.max(...layout.xs) - Math.min(...layout.xs);
    // Nobody crosses the map: the typical creator shifts by a few percent of its width.
    expect(moved[moved.length >> 1]).toBeLessThan(width * 0.05);
    expect(moved[moved.length - 1]).toBeLessThan(width * 0.1);
  });

  it('can be run a slice at a time and ends in the same place', () => {
    const sliced = new ForceLayout(graph, new Map());
    sliced.begin();
    let slices = 0;
    while (!sliced.advance(0)) slices++;
    expect(slices).toBeGreaterThan(1);
    expect(Array.from(sliced.xs)).toEqual(Array.from(layout.xs));
  });
});

describe('snapshot', () => {
  const layout = laidOut();
  const snapshot = new UniverseSnapshot(data, graph, layout.xs, layout.ys, true, 1);

  it('finds the node under a point, and nothing in empty space', () => {
    const node = graph.nodes[graph.nodesByWeight[0]];
    expect(snapshot.index.hit(layout.xs[node.index], layout.ys[node.index], 0, null)).toBe(node.index);
    const bounds = snapshot.fullBounds;
    expect(snapshot.index.hit(bounds.right + 500, bounds.bottom + 500, 10, null)).toBe(-1);
  });

  it('does not find a node the filter has hidden', () => {
    const node = graph.nodes[graph.nodesByWeight[0]];
    const hidden = graph.nodes.map((n) => n.index !== node.index);
    expect(snapshot.index.hit(layout.xs[node.index], layout.ys[node.index], 0, hidden)).not.toBe(node.index);
  });

  it('visits every node when asked about the whole world', () => {
    const seen = new Set<number>();
    snapshot.index.forEachNear(-Infinity, -Infinity, Infinity, Infinity, (i) => seen.add(i));
    expect(seen.size).toBe(graph.nodes.length);
  });

  it('keeps distances when turned a quarter', () => {
    const turned = snapshot.quarterTurned();
    const before = snapshot.fullBounds;
    const after = turned.fullBounds;
    expect(after.right - after.left).toBeCloseTo(before.bottom - before.top);
    expect(after.bottom - after.top).toBeCloseTo(before.right - before.left);
  });
});

describe('camera', () => {
  it('maps a point to the screen and back', () => {
    const camera = new Camera();
    camera.viewWidth = 800;
    camera.viewHeight = 600;
    camera.centerX = 120;
    camera.centerY = -40;
    camera.setScale(0.5);
    expect(camera.toWorldX(camera.toScreenX(333))).toBeCloseTo(333);
    expect(camera.toWorldY(camera.toScreenY(-77))).toBeCloseTo(-77);
  });

  it('zooms around the pointer, not the centre', () => {
    const camera = new Camera();
    camera.viewWidth = 800;
    camera.viewHeight = 600;
    const worldX = camera.toWorldX(700);
    const worldY = camera.toWorldY(100);
    camera.zoomBy(2, 700, 100);
    expect(camera.scale).toBe(2);
    expect(camera.toScreenX(worldX)).toBeCloseTo(700);
    expect(camera.toScreenY(worldY)).toBeCloseTo(100);
  });

  it('keeps the zoom within its limits', () => {
    const camera = new Camera();
    camera.setScale(1000);
    expect(camera.scale).toBe(camera.maxScale);
    camera.setScale(0);
    expect(camera.scale).toBe(camera.minScale);
  });

  it('frames bounds inside the padded area', () => {
    const camera = new Camera();
    camera.viewWidth = 1000;
    camera.viewHeight = 800;
    const bounds = { left: -500, top: -100, right: 500, bottom: 100 };
    camera.fit(bounds, { left: 0, top: 200, right: 0, bottom: 0 }, 10);
    expect(camera.scale).toBe(1);
    // Centred in the 600px left below the 200px header.
    expect(camera.toScreenY(0)).toBeCloseTo(500);
    expect(camera.toScreenX(-500)).toBeCloseTo(0);
  });
});

describe('geometry', () => {
  const rect = { left: 0, top: 0, right: 10, bottom: 10 };

  it('sees a line that crosses the viewport with both ends outside', () => {
    expect(segmentIntersectsRect(-5, 5, 15, 5, rect)).toBe(true);
    expect(segmentIntersectsRect(-5, -5, 15, 15, rect)).toBe(true);
  });

  it('rejects a line that passes the corner', () => {
    expect(segmentIntersectsRect(-5, 8, 2, 15, rect)).toBe(false);
    expect(segmentIntersectsRect(20, 0, 30, 10, rect)).toBe(false);
  });

  it('measures distance to the nearest point of a segment', () => {
    expect(distanceSqToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(9);
    expect(distanceSqToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(25);
  });
});
