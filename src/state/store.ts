import libraryFile from '../data/demo-library.json';
import { buildGraph } from '../graph/builder';
import { NO_FILTER, type GraphFilter, type UniverseGraph } from '../graph/graph';
import { FRESH, ForceLayout, GENTLE, WARM } from '../graph/layout';
import { UniverseSnapshot } from '../graph/snapshot';
import { computeInsights, type Insights } from '../insights/engine';
import { loadLibrary, type LibraryFile } from '../model/data';

const FILE = libraryFile as unknown as LibraryFile;

const KEY_EXCLUDED = 'music-universe:excluded';
const KEY_LAYOUT = 'music-universe:layout';
const KEY_NICKNAME = 'music-universe:nickname';

/** Budget for layout work per frame once the page is up, and for the one blocking pass at start. */
const FRAME_BUDGET_MS = 12;
const FIRST_BUDGET_MS = 120;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies) or hold something unreadable.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing is lost that matters: the choice simply will not survive a reload.
  }
}

/**
 * The one place that holds what the user is looking at: the library with their exclusions, the
 * graph built from it, where each node sits, and the active filter.
 *
 * Whenever the analysis set changes, the graph is rebuilt and laid out starting from the previous
 * positions, so the map evolves instead of reshuffling.
 */
export class Store {
  snapshot = UniverseSnapshot.EMPTY;
  filter: GraphFilter = NO_FILTER;

  private readonly excluded = new Set<string>(read<string[]>(KEY_EXCLUDED, []));
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private insightsCache: { generation: number; value: Insights } | null = null;

  constructor() {
    this.rebuild(false, FIRST_BUDGET_MS);
  }

  /** Calls `listener` whenever the snapshot or the filter changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  get insights(): Insights {
    if (this.insightsCache?.generation !== this.snapshot.generation) {
      this.insightsCache = {
        generation: this.snapshot.generation,
        value: computeInsights(this.snapshot.data, this.snapshot.graph),
      };
    }
    return this.insightsCache.value;
  }

  setFilter(filter: GraphFilter): void {
    if (filter.role === this.filter.role && filter.sharedOnly === this.filter.sharedOnly) return;
    this.filter = filter;
    this.notify();
  }

  /** Takes a work out of the analysis, or puts it back. It stays in the library either way. */
  setIncluded(itemId: string, included: boolean): void {
    if (included === !this.excluded.has(itemId)) return;
    if (included) this.excluded.delete(itemId);
    else this.excluded.add(itemId);
    write(KEY_EXCLUDED, [...this.excluded]);
    this.rebuild(false, FRAME_BUDGET_MS);
  }

  get nickname(): string {
    return read<string>(KEY_NICKNAME, '');
  }

  set nickname(value: string) {
    write(KEY_NICKNAME, value);
  }

  /** Forgets cached positions and lays the current graph out from scratch. */
  resetLayout(): void {
    this.rebuild(true, FRAME_BUDGET_MS);
  }

  /** Whether anything of the user's is stored in this browser. */
  get hasLocalChanges(): boolean {
    return this.excluded.size > 0 || this.nickname !== '';
  }

  /** Puts every excluded work back and forgets the nickname and the cached layout. */
  clearLocalData(): void {
    this.excluded.clear();
    for (const key of [KEY_EXCLUDED, KEY_LAYOUT, KEY_NICKNAME]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing was stored, so there is nothing to remove.
      }
    }
    this.filter = NO_FILTER;
    this.rebuild(true, FRAME_BUDGET_MS);
  }

  private rebuild(fresh: boolean, firstBudgetMs: number): void {
    const data = loadLibrary(FILE, this.excluded);
    const graph = buildGraph(data);
    const generation = ++this.generation;
    const publish = (xs: Float64Array, ys: Float64Array, settled: boolean) => {
      this.snapshot = new UniverseSnapshot(data, graph, xs, ys, settled, generation);
      this.notify();
    };

    const previous = !fresh && this.snapshot.graph.nodes.length > 0 ? this.snapshot : null;
    const seed = new Map<string, readonly [number, number]>();
    if (previous) {
      for (const node of previous.graph.nodes) seed.set(node.id, [previous.xs[node.index], previous.ys[node.index]]);
    } else if (!fresh) {
      for (const [id, position] of Object.entries(read<Record<string, [number, number]>>(KEY_LAYOUT, {}))) {
        if (Array.isArray(position) && position.every(Number.isFinite)) seed.set(id, position);
      }
    }

    const layout = new ForceLayout(graph, seed);
    const everyoneSeeded = layout.seededCount === graph.nodes.length;
    const unchanged = everyoneSeeded && previous !== null && sameStructure(previous.graph, graph);
    const restored = everyoneSeeded && previous === null && !fresh;
    if (unchanged || restored || graph.nodes.length === 0) {
      // Same people and links as before (or a cache that covers everyone): reuse positions as
      // they are. Excluding one song must not make the whole map twitch.
      publish(layout.xs, layout.ys, true);
      return;
    }

    layout.begin(
      !layout.isIncremental
        ? FRESH
        : // The positions we are starting from were still moving: keep untangling.
          previous !== null && !previous.settled
          ? WARM
          : GENTLE,
    );
    const slice = (budgetMs: number) => {
      // A newer rebuild has taken over.
      if (generation !== this.generation) return;
      const done = layout.advance(budgetMs);
      publish(layout.xs.slice(), layout.ys.slice(), done);
      if (done) {
        write(KEY_LAYOUT, Object.fromEntries(graph.nodes.map((node) => [node.id, [round(layout.xs[node.index]), round(layout.ys[node.index])]])));
      } else {
        requestAnimationFrame(() => slice(FRAME_BUDGET_MS));
      }
    };
    slice(firstBudgetMs);
  }
}

const round = (value: number) => Math.round(value * 10) / 10;

function sameStructure(a: UniverseGraph, b: UniverseGraph): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.nodes.length; i++) if (a.nodes[i].id !== b.nodes[i].id) return false;
  for (let i = 0; i < a.edges.length; i++) {
    if (a.edges[i].a !== b.edges[i].a || a.edges[i].b !== b.edges[i].b) return false;
  }
  return true;
}
