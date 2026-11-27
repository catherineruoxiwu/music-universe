import type { UniverseGraph } from './graph';

/** Preferred rim-to-rim distance between linked nodes, in world units. */
const IDEAL = 80;
const CUTOFF = IDEAL * 5;
const REPULSION = IDEAL * IDEAL * 0.9;
const GRAVITY = 0.035;
const END_TEMPERATURE = 0.6;

/** How vigorously to rearrange. The temperature caps how far a node may move in one step. */
export interface Heat {
  startTemperature: number;
  iterations: number;
}

/** No usable starting positions: start hot so the graph can untangle. */
export const FRESH: Heat = { startTemperature: IDEAL * 2.2, iterations: 320 };
/** Starting from a layout that was interrupted before it finished. */
export const WARM: Heat = { startTemperature: IDEAL * 1.0, iterations: 200 };
/** A settled map gaining or losing a few nodes: stay recognisable. */
export const GENTLE: Heat = { startTemperature: IDEAL * 0.25, iterations: 90 };

/**
 * Force-directed placement in world coordinates.
 *
 * Knows nothing about the screen: panning and zooming never come near this class. Its output is
 * cached, so the map is the same every time it is opened.
 *
 * Repulsion is only evaluated between nodes in neighbouring grid cells, which keeps a step roughly
 * linear in the number of nodes instead of quadratic.
 */
export class ForceLayout {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** How many nodes started from a known position. */
  readonly seededCount: number;

  private readonly n: number;
  private readonly dx: Float64Array;
  private readonly dy: Float64Array;
  private readonly radius: Float64Array;

  // Uniform grid, rebuilt each step, in CSR form (cellStart/cellItems).
  private cellStart = new Int32Array(0);
  private readonly cellItems: Int32Array;
  private readonly cellOf: Int32Array;

  private heat: Heat = FRESH;
  private stepsDone = 0;

  /**
   * @param seed known positions by creator id; nodes missing from it are placed near their
   *   neighbours.
   */
  constructor(
    private readonly graph: UniverseGraph,
    seed: ReadonlyMap<string, readonly [number, number]>,
  ) {
    const n = (this.n = graph.nodes.length);
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.dx = new Float64Array(n);
    this.dy = new Float64Array(n);
    this.radius = Float64Array.from(graph.nodes, (node) => node.radius);
    this.cellItems = new Int32Array(n);
    this.cellOf = new Int32Array(n);

    let seeded = 0;
    const placed = new Uint8Array(n);
    for (const node of graph.nodes) {
      const p = seed.get(node.id);
      if (!p) continue;
      this.xs[node.index] = p[0];
      this.ys[node.index] = p[1];
      placed[node.index] = 1;
      seeded++;
    }
    this.seededCount = seeded;

    const spread = IDEAL * Math.sqrt(Math.max(n, 1)) * 0.9;
    // Most-credited first, so hubs are down before the nodes that hang off them.
    for (const i of graph.nodesByWeight) {
      if (placed[i]) continue;
      // Seeded by the creator's id: the same library always starts from the same arrangement.
      const random = seededRandom(graph.nodes[i].id);
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const e of graph.adjacency[i]) {
        const other = graph.edges[e].other(i);
        if (placed[other]) {
          sx += this.xs[other];
          sy += this.ys[other];
          count++;
        }
      }
      const angle = random() * Math.PI * 2;
      if (count > 0) {
        const r = IDEAL * (0.6 + random() * 0.6);
        this.xs[i] = sx / count + Math.cos(angle) * r;
        this.ys[i] = sy / count + Math.sin(angle) * r;
      } else {
        const r = spread * Math.sqrt(random());
        this.xs[i] = Math.cos(angle) * r;
        this.ys[i] = Math.sin(angle) * r;
      }
      placed[i] = 1;
    }
  }

  /** True when most nodes already had positions. */
  get isIncremental(): boolean {
    return this.n > 0 && this.seededCount >= this.n * 0.6;
  }

  /** Chooses how hard to shake. Call before `advance`. */
  begin(heat: Heat = this.isIncremental ? GENTLE : FRESH): void {
    this.heat = heat;
    this.stepsDone = 0;
  }

  get finished(): boolean {
    return this.n === 0 || this.stepsDone >= this.heat.iterations;
  }

  /**
   * Runs steps until `budgetMs` has passed or the layout is done, whichever comes first, so a
   * big graph can be laid out across animation frames without freezing the page.
   *
   * @returns true when the layout has finished.
   */
  advance(budgetMs: number = Infinity): boolean {
    const deadline = budgetMs === Infinity ? Infinity : performance.now() + budgetMs;
    const { iterations, startTemperature } = this.heat;
    while (!this.finished) {
      const t = this.stepsDone / Math.max(iterations - 1, 1);
      this.step(startTemperature + (END_TEMPERATURE - startTemperature) * t);
      this.stepsDone++;
      // Checking the clock every few steps is plenty, and keeps it out of the hot loop.
      if (this.stepsDone % 4 === 0 && performance.now() >= deadline) break;
    }
    return this.finished;
  }

  /** Lays the whole graph out in one go. */
  run(heat?: Heat): void {
    this.begin(heat);
    this.advance();
  }

  private step(temperature: number): void {
    const { n, dx, dy, xs, ys } = this;
    dx.fill(0);
    dy.fill(0);
    this.repel();
    this.attract();
    this.gravitate();
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(dx[i], dy[i]);
      if (len < 1e-4) continue;
      const limited = Math.min(len, temperature);
      xs[i] += (dx[i] / len) * limited;
      ys[i] += (dy[i] / len) * limited;
    }
  }

  private repel(): void {
    const { n, xs, ys, dx, dy, radius, cellOf, cellItems } = this;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i];
      if (ys[i] < minY) minY = ys[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] > maxY) maxY = ys[i];
    }
    const cols = clamp(Math.floor((maxX - minX) / CUTOFF) + 1, 1, 4096);
    const rows = clamp(Math.floor((maxY - minY) / CUTOFF) + 1, 1, 4096);
    const cells = cols * rows;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
    const cellStart = this.cellStart;
    cellStart.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(Math.floor((xs[i] - minX) / CUTOFF), cols - 1);
      const cy = Math.min(Math.floor((ys[i] - minY) / CUTOFF), rows - 1);
      const c = cy * cols + cx;
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
    const cursor = cellStart.slice(0, cells);
    for (let i = 0; i < n; i++) cellItems[cursor[cellOf[i]]++] = i;

    const cutoffSq = CUTOFF * CUTOFF;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      for (let ny = Math.max(cy - 1, 0); ny <= Math.min(cy + 1, rows - 1); ny++) {
        for (let nx = Math.max(cx - 1, 0); nx <= Math.min(cx + 1, cols - 1); nx++) {
          const cell = ny * cols + nx;
          for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
            const j = cellItems[k];
            if (j <= i) continue;
            let ddx = xs[i] - xs[j];
            let ddy = ys[i] - ys[j];
            let distSq = ddx * ddx + ddy * ddy;
            if (distSq > cutoffSq) continue;
            if (distSq < 0.01) {
              // Coincident nodes: nudge apart along a direction fixed by their indices.
              const a = (i * 31 + j) * 0.618;
              ddx = Math.cos(a);
              ddy = Math.sin(a);
              distSq = 1;
            }
            const dist = Math.sqrt(distSq);
            // Measure from the rims, so large nodes claim more room.
            const gap = Math.max(dist - radius[i] - radius[j], 1);
            // Fade to zero at the cutoff so nodes do not jump as they cross it.
            const force = (REPULSION / gap) * (1 - dist / CUTOFF);
            const fx = (ddx / dist) * force;
            const fy = (ddy / dist) * force;
            dx[i] += fx;
            dy[i] += fy;
            dx[j] -= fx;
            dy[j] -= fy;
          }
        }
      }
    }
  }

  private attract(): void {
    const { xs, ys, dx, dy, radius, graph } = this;
    for (const e of graph.edges) {
      const a = e.a;
      const b = e.b;
      const ddx = xs[a] - xs[b];
      const ddy = ys[a] - ys[b];
      const dist = Math.hypot(ddx, ddy);
      if (dist < 1e-3) continue;
      const gap = Math.max(dist - radius[a] - radius[b], 0);
      // Repeated collaborators sit closer. Hubs pull each spoke less, otherwise a creator with
      // fifty links collapses everything onto itself.
      const strength = 1 + 0.35 * Math.log(e.weight);
      const hub = 1 + 0.12 * Math.min(graph.degree(a), graph.degree(b));
      const force = ((gap * gap) / IDEAL) * (strength / hub);
      const fx = (ddx / dist) * force;
      const fy = (ddy / dist) * force;
      dx[a] -= fx;
      dy[a] -= fy;
      dx[b] += fx;
      dy[b] += fy;
    }
  }

  /** A weak pull to the origin keeps unconnected nodes and islands from drifting away. */
  private gravitate(): void {
    const { n, xs, ys, dx, dy } = this;
    for (let i = 0; i < n; i++) {
      dx[i] -= xs[i] * GRAVITY;
      dy[i] -= ys[i] * GRAVITY;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A small repeatable random generator (mulberry32), seeded from a string. */
function seededRandom(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (Math.imul(state, 31) + seed.charCodeAt(i)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
