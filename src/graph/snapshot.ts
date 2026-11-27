import { AnalysisData } from '../model/data';
import type { Rect } from './camera';
import { UniverseGraph } from './graph';

const CELL = 160;

/**
 * A uniform grid over node centres, built once per snapshot. Lets the renderer visit only the
 * nodes near the viewport, and lets a click find its node without scanning the whole graph.
 */
export class SpatialIndex {
  /** Largest node radius, so a query can widen itself to catch nodes whose centre is outside. */
  readonly maxRadius: number;

  private readonly n: number;
  private minX = 0;
  private minY = 0;
  private cols = 1;
  private rows = 1;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(
    private readonly graph: UniverseGraph,
    private readonly xs: Float64Array,
    private readonly ys: Float64Array,
  ) {
    const n = (this.n = graph.nodes.length);
    this.maxRadius = graph.nodes.reduce((max, node) => Math.max(max, node.radius), 0);
    this.cellItems = new Int32Array(n);
    if (n === 0) {
      this.cellStart = new Int32Array(2);
      return;
    }
    let maxX = -Infinity;
    let maxY = -Infinity;
    this.minX = Infinity;
    this.minY = Infinity;
    for (let i = 0; i < n; i++) {
      this.minX = Math.min(this.minX, xs[i]);
      this.minY = Math.min(this.minY, ys[i]);
      maxX = Math.max(maxX, xs[i]);
      maxY = Math.max(maxY, ys[i]);
    }
    this.cols = Math.min(Math.max(Math.floor((maxX - this.minX) / CELL) + 1, 1), 2048);
    this.rows = Math.min(Math.max(Math.floor((maxY - this.minY) / CELL) + 1, 1), 2048);
    const cells = this.cols * this.rows;
    this.cellStart = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellY(ys[i]) * this.cols + this.cellX(xs[i]);
      cellOf[i] = c;
      this.cellStart[c + 1]++;
    }
    for (let c = 0; c < cells; c++) this.cellStart[c + 1] += this.cellStart[c];
    const cursor = this.cellStart.slice(0, cells);
    for (let i = 0; i < n; i++) this.cellItems[cursor[cellOf[i]]++] = i;
  }

  private cellX(x: number): number {
    return Math.min(Math.max(Math.floor((x - this.minX) / CELL), 0), this.cols - 1);
  }

  private cellY(y: number): number {
    return Math.min(Math.max(Math.floor((y - this.minY) / CELL), 0), this.rows - 1);
  }

  /** Visits every node whose circle may touch the given world rectangle. */
  forEachNear(left: number, top: number, right: number, bottom: number, action: (node: number) => void): void {
    if (this.n === 0) return;
    const pad = this.maxRadius;
    const x0 = this.cellX(left - pad);
    const x1 = this.cellX(right + pad);
    const y0 = this.cellY(top - pad);
    const y1 = this.cellY(bottom + pad);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = cy * this.cols + cx;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) action(this.cellItems[k]);
      }
    }
  }

  /**
   * The node under a world point, allowing `slop` world units of miss beyond its rim.
   * Returns -1 when nothing is close enough.
   */
  hit(x: number, y: number, slop: number, visible: readonly boolean[] | null): number {
    let best = -1;
    let bestDistance = Infinity;
    this.forEachNear(x - slop, y - slop, x + slop, y + slop, (i) => {
      if (visible && !visible[i]) return;
      const rim = Math.hypot(this.xs[i] - x, this.ys[i] - y) - this.graph.nodes[i].radius;
      if (rim <= slop && rim < bestDistance) {
        bestDistance = rim;
        best = i;
      }
    });
    return best;
  }
}

/** A soft disc per community of three or more creators, drawn as a glow when zoomed far out. */
export interface Blob {
  x: number;
  y: number;
  radius: number;
  members: number[];
}

/**
 * One consistent view of the analysis: the data it was built from, the graph, and where each node
 * sits. Immutable, so the map, Insights and the poster renderer can all hold the same instance
 * and are guaranteed to agree.
 */
export class UniverseSnapshot {
  readonly index: SpatialIndex;
  private _communities?: Blob[];
  private _fullBounds?: Rect;

  constructor(
    readonly data: AnalysisData,
    readonly graph: UniverseGraph,
    readonly xs: Float64Array,
    readonly ys: Float64Array,
    /** False while the layout is still moving. */
    readonly settled: boolean,
    /** Increases with every rebuild of the graph (not with every layout step). */
    readonly generation: number,
  ) {
    this.index = new SpatialIndex(graph, xs, ys);
  }

  get communities(): Blob[] {
    if (!this._communities) {
      const groups = new Map<number, number[]>();
      for (const node of this.graph.nodes) {
        const group = groups.get(node.community);
        if (group) group.push(node.index);
        else groups.set(node.community, [node.index]);
      }
      this._communities = [...groups.values()]
        .filter((members) => members.length >= 3)
        .map((members) => {
          const x = members.reduce((sum, i) => sum + this.xs[i], 0) / members.length;
          const y = members.reduce((sum, i) => sum + this.ys[i], 0) / members.length;
          const reach = members.reduce(
            (max, i) => Math.max(max, Math.hypot(this.xs[i] - x, this.ys[i] - y) + this.graph.nodes[i].radius),
            0,
          );
          return { x, y, radius: reach * 1.25, members };
        });
    }
    return this._communities;
  }

  /** Bounds of every node. Cached: the view reads this on each frame of a pan or zoom. */
  get fullBounds(): Rect {
    return (this._fullBounds ??= this.bounds());
  }

  /** World-space bounds of the given nodes (all nodes when `visible` is omitted), rims included. */
  bounds(visible?: readonly boolean[]): Rect {
    const r: Rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const node of this.graph.nodes) {
      if (visible && !visible[node.index]) continue;
      const x = this.xs[node.index];
      const y = this.ys[node.index];
      r.left = Math.min(r.left, x - node.radius);
      r.top = Math.min(r.top, y - node.radius);
      r.right = Math.max(r.right, x + node.radius);
      r.bottom = Math.max(r.bottom, y + node.radius);
    }
    return r.left > r.right ? { left: -1, top: -1, right: 1, bottom: 1 } : r;
  }

  /** Same graph and distances, rotated 90 degrees. */
  quarterTurned(): UniverseSnapshot {
    return new UniverseSnapshot(
      this.data,
      this.graph,
      this.ys.map((y) => -y),
      this.xs.slice(),
      this.settled,
      this.generation,
    );
  }

  static readonly EMPTY = new UniverseSnapshot(
    AnalysisData.EMPTY,
    UniverseGraph.EMPTY,
    new Float64Array(0),
    new Float64Array(0),
    true,
    0,
  );
}
