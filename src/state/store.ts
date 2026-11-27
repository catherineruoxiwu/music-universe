import libraryFile from '../data/demo-library.json';
import { createMusicBrainzApi, PoliteFetcher } from '../enrich/musicbrainz';
import { EnrichmentRunner, type RunState } from '../enrich/runner';
import { sleep } from '../enrich/ticker';
import { buildGraph } from '../graph/builder';
import { NO_FILTER, type GraphFilter, type UniverseGraph } from '../graph/graph';
import { FRESH, ForceLayout, GENTLE, WARM } from '../graph/layout';
import { UniverseSnapshot } from '../graph/snapshot';
import type { ImportedSong } from '../import/appleLibrary';
import { computeInsights, type Insights } from '../insights/engine';
import { deleteValue, loadValue, saveValue } from '../library/storage';
import { UserLibrary, type LibraryCounts, type LibraryMeta, type StoredLibrary } from '../library/userLibrary';
import { loadLibrary, type LibraryFile } from '../model/data';

const FILE = libraryFile as unknown as LibraryFile;

const KEY_EXCLUDED = 'music-universe:excluded';
const KEY_LAYOUT = 'music-universe:layout';
const KEY_LAYOUT_MINE = 'music-universe:layout:mine';
const KEY_NICKNAME = 'music-universe:nickname';
const KEY_SHOWING = 'music-universe:showing';
const KEY_LAST_REQUEST = 'music-universe:last-request';
/** Where the imported library is kept, in IndexedDB. */
const KEY_LIBRARY = 'library';

/** Budget for layout work per frame once the page is up, and for the one blocking pass at start. */
const FRAME_BUDGET_MS = 12;
const FIRST_BUDGET_MS = 120;

/** While songs are being looked up, the map is redrawn from the results no more often than this. */
const REBUILD_INTERVAL_MS = 2_500;
/** …and spends at most about one part in this many of the time rebuilding, however large the library. */
const REBUILD_SHARE = 20;
/** How soon to look again when a redraw is due but the map is still settling from the last one. */
const SETTLING_CHECK_MS = 300;
/** Lookup results are written to storage this long after the first unsaved one. */
const SAVE_DELAY_MS = 8_000;
/** How often to try again while MusicBrainz cannot be reached. */
const OFFLINE_RETRY_MS = 60_000;

/** Which library the site is showing: the bundled sample, or the one the user imported. */
export type Showing = 'demo' | 'mine';

/** Where the imported library stands. */
export interface ImportStatus {
  meta: LibraryMeta;
  counts: LibraryCounts;
  state: RunState;
  /** Title of the song being looked up right now. */
  current: string | null;
  /** Roughly how long the remaining lookups will take. */
  etaMs: number;
  /** The last attempt to store the library in this browser failed. */
  saveFailed: boolean;
}

type Rebuild =
  /** Start from where the nodes are now, so the map changes instead of reshuffling. */
  | 'evolve'
  /** Start from the positions stored for the library being shown. */
  | 'restore'
  /** Lay everything out anew. */
  | 'fresh';

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

function remove(...keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing was stored, so there is nothing to remove.
    }
  }
}

/**
 * The one place that holds what the user is looking at: the library being shown with their
 * exclusions, the graph built from it, where each node sits, and the active filter. It also owns
 * the imported library and the lookups that fill it in.
 *
 * Whenever the analysis set changes, the graph is rebuilt and laid out starting from the previous
 * positions, so the map evolves instead of reshuffling.
 */
export class Store {
  snapshot = UniverseSnapshot.EMPTY;
  filter: GraphFilter = NO_FILTER;
  showing: Showing = 'demo';

  private readonly excluded = new Set<string>(read<string[]>(KEY_EXCLUDED, []));
  private readonly listeners = new Set<() => void>();
  private readonly progressListeners = new Set<() => void>();
  private generation = 0;
  private insightsCache: { generation: number; value: Insights } | null = null;

  private mine: UserLibrary | null = null;
  private runner: EnrichmentRunner | null = null;
  // One for the whole visit, and with a memory that outlives it, so that neither pausing and
  // resuming nor reloading the page can get around the rate limit.
  private readonly fetcher = new PoliteFetcher({
    sleep,
    lastRequest: { get: () => read<number>(KEY_LAST_REQUEST, 0), set: (at) => write(KEY_LAST_REQUEST, at) },
  });

  /** The imported library has results the map does not show yet. */
  private stale = false;
  private rebuildTimer = 0;
  private lastRebuildAt = 0;
  private lastRebuildCostMs = 0;

  private unsaved = false;
  private saveTimer = 0;
  private saveFailed = false;
  /** Storage operations run one after another, so a late save cannot undo a delete. */
  private storage: Promise<void> = Promise.resolve();
  private retryTimer = 0;

  private constructor(stored: StoredLibrary | undefined) {
    if (stored?.version === 1) {
      this.mine = UserLibrary.fromStored(stored);
      this.runner = this.createRunner(this.mine);
      if (read<Showing>(KEY_SHOWING, 'mine') === 'mine') this.showing = 'mine';
    }
    this.rebuild('restore', FIRST_BUDGET_MS);

    // Leaving the page is the last chance to keep what has been looked up since the last save.
    window.addEventListener('pagehide', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save();
    });
    window.addEventListener('online', () => this.retryIfOffline());

    if (this.mine && !this.mine.meta.paused) this.runner?.start();
  }

  /** Reads what this browser has stored, then starts. */
  static async open(): Promise<Store> {
    return new Store(await loadValue<StoredLibrary>(KEY_LIBRARY));
  }

  /** Calls `listener` whenever the snapshot or the filter changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` whenever {@link status} changes, which while looking songs up is every second or two. */
  subscribeProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private notifyProgress(): void {
    for (const listener of [...this.progressListeners]) listener();
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
    if (this.showing === 'mine' && this.mine) {
      if (this.mine.item(itemId)?.included === included) return;
      this.mine.update(itemId, { included });
      this.touch();
    } else {
      if (included === !this.excluded.has(itemId)) return;
      if (included) this.excluded.delete(itemId);
      else this.excluded.add(itemId);
      write(KEY_EXCLUDED, [...this.excluded]);
    }
    this.rebuild('evolve', FRAME_BUDGET_MS);
  }

  get nickname(): string {
    return read<string>(KEY_NICKNAME, '');
  }

  set nickname(value: string) {
    write(KEY_NICKNAME, value);
  }

  /** Forgets cached positions and lays the current graph out from scratch. */
  resetLayout(): void {
    this.rebuild('fresh', FRAME_BUDGET_MS);
  }

  /** Whether the user has changed anything about the library being shown that a reset would undo. */
  get hasLocalChanges(): boolean {
    return this.nickname !== '' || this.snapshot.data.items.some((item) => !item.included);
  }

  /** Puts every excluded work of the library being shown back, and forgets the nickname and its cached layout. */
  clearLocalData(): void {
    if (this.showing === 'mine' && this.mine) {
      for (const item of this.mine.items.slice()) if (!item.included) this.mine.update(item.id, { included: true });
      this.touch();
      remove(KEY_LAYOUT_MINE, KEY_NICKNAME);
    } else {
      this.excluded.clear();
      remove(KEY_EXCLUDED, KEY_LAYOUT, KEY_NICKNAME);
    }
    this.filter = NO_FILTER;
    this.rebuild('fresh', FRAME_BUDGET_MS);
  }

  // --- the imported library ---------------------------------------------------------------------

  /** Null when nothing has been imported. */
  get status(): ImportStatus | null {
    if (!this.mine || !this.runner) return null;
    const counts = this.mine.counts();
    return {
      meta: this.mine.meta,
      counts,
      state: this.runner.state,
      current: this.runner.current,
      etaMs: this.runner.etaMs(counts.remaining),
      saveFailed: this.saveFailed,
    };
  }

  /** Replaces whatever was imported before with these songs, shows them, and starts looking them up. */
  importLibrary(songs: ImportedSong[], source: Pick<LibraryMeta, 'fileName' | 'choice'>): void {
    this.runner?.stop();
    this.mine = UserLibrary.fromSongs(songs, { ...source, importedAt: Date.now(), paused: false });
    this.runner = this.createRunner(this.mine);
    remove(KEY_LAYOUT_MINE);
    this.touch();
    this.save();
    this.show('mine');
    this.runner.start();
  }

  /** Switches between the sample library and the imported one. */
  show(which: Showing): void {
    if (which === 'mine' && !this.mine) return;
    this.showing = which;
    write(KEY_SHOWING, which);
    this.filter = NO_FILTER;
    this.rebuild('restore', FRAME_BUDGET_MS);
    this.notifyProgress();
  }

  /** Removes the imported library and everything looked up for it from this browser. */
  deleteMine(): void {
    this.runner?.stop();
    this.runner = null;
    this.mine = null;
    this.unsaved = false;
    this.saveFailed = false;
    window.clearTimeout(this.retryTimer);
    remove(KEY_LAYOUT_MINE, KEY_SHOWING);
    this.storage = this.storage.then(() => deleteValue(KEY_LIBRARY));
    this.showing = 'demo';
    this.filter = NO_FILTER;
    this.rebuild('restore', FRAME_BUDGET_MS);
    this.notifyProgress();
  }

  /** Stops the lookups until {@link resume}, also across reloads. */
  pause(): void {
    if (!this.mine) return;
    this.mine.meta.paused = true;
    this.runner?.stop();
    this.touch();
    this.save();
  }

  resume(): void {
    if (!this.mine) return;
    if (this.mine.meta.paused) {
      this.mine.meta.paused = false;
      this.touch();
      // At once, like pausing: a reload a moment later must find what the user last chose.
      this.save();
    }
    this.runner?.start();
    this.notifyProgress();
  }

  /** Accepts the doubtful candidate found for a work, and reads its credits. */
  confirmMatch(itemId: string): void {
    const item = this.mine?.item(itemId);
    if (!this.mine || item?.matchStatus !== 'LOW_CONFIDENCE' || !item.recordingMbid) return;
    this.mine.update(itemId, { matchStatus: 'MATCHED', matchMethod: 'user', creditsStatus: 'NOT_QUERIED' });
    this.lookUpNext(itemId);
  }

  /** Turns the doubtful candidate found for a work down. The work stays, without credits. */
  rejectMatch(itemId: string): void {
    if (this.mine?.item(itemId)?.matchStatus !== 'LOW_CONFIDENCE') return;
    this.mine.clearLookup(itemId, { matchStatus: 'UNMATCHED' });
    this.changedMine();
  }

  /** Looks a work up again from the beginning. */
  retry(itemId: string): void {
    if (!this.mine?.item(itemId)) return;
    this.mine.clearLookup(itemId, { matchStatus: 'PENDING' });
    this.lookUpNext(itemId);
  }

  /** Looks up again every work whose lookup did not complete. */
  retryFailed(): void {
    if (!this.mine) return;
    for (const item of this.mine.items.slice()) {
      if (item.matchStatus === 'FAILED') this.mine.clearLookup(item.id, { matchStatus: 'PENDING' });
      else if (item.creditsStatus === 'FAILED') this.mine.update(item.id, { creditsStatus: 'NOT_QUERIED', lastError: undefined });
    }
    this.changedMine();
    this.resume();
  }

  /** An explicit request for one work: it goes to the front, and the lookups run even if they were paused. */
  private lookUpNext(itemId: string): void {
    this.mine?.prioritise(itemId);
    this.changedMine();
    this.resume();
  }

  /** The imported library was changed by the user: show it now rather than at the next scheduled redraw. */
  private changedMine(): void {
    this.touch();
    this.notifyProgress();
    if (this.showing === 'mine') this.rebuild('evolve', FRAME_BUDGET_MS);
  }

  private createRunner(library: UserLibrary): EnrichmentRunner {
    const runner: EnrichmentRunner = new EnrichmentRunner(
      library,
      {
        onItem: () => {
          this.touch();
          this.stale = true;
          this.scheduleRebuild();
          this.notifyProgress();
        },
        onState: () => {
          if (runner !== this.runner) return;
          window.clearTimeout(this.retryTimer);
          if (runner.state === 'offline') this.retryTimer = window.setTimeout(() => this.retryIfOffline(), OFFLINE_RETRY_MS);
          if (runner.state === 'idle') {
            // Finished or stopped: nothing more is coming for a while, so show and keep what there is.
            this.save();
            if (this.stale && this.showing === 'mine') this.rebuild('evolve', FRAME_BUDGET_MS);
          }
          this.notifyProgress();
        },
      },
      (signal) => createMusicBrainzApi(this.fetcher, signal),
    );
    return runner;
  }

  private retryIfOffline(): void {
    if (this.runner?.state === 'offline' && !this.mine?.meta.paused) this.runner.start();
  }

  private scheduleRebuild(): void {
    if (this.showing !== 'mine' || this.rebuildTimer !== 0) return;
    const interval = Math.max(REBUILD_INTERVAL_MS, this.lastRebuildCostMs * REBUILD_SHARE);
    const check = () => {
      this.rebuildTimer = 0;
      if (!this.stale || this.showing !== 'mine') return;
      // Starting over before the map has come to rest would keep it moving for as long as the lookups run.
      if (this.snapshot.settled) this.rebuild('evolve', FRAME_BUDGET_MS);
      else this.rebuildTimer = window.setTimeout(check, SETTLING_CHECK_MS);
    };
    this.rebuildTimer = window.setTimeout(check, Math.max(0, this.lastRebuildAt + interval - performance.now()));
  }

  /** Notes that the imported library has changes that are not stored yet. */
  private touch(): void {
    this.unsaved = true;
    if (this.saveTimer === 0) this.saveTimer = window.setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  private save(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    // While another tab is doing the lookups, the stored copy is that tab's to write.
    if (!this.mine || !this.unsaved || this.runner?.state === 'elsewhere') return;
    this.unsaved = false;
    const stored = this.mine.toStored();
    this.storage = this.storage.then(async () => {
      let failed = false;
      try {
        await saveValue(KEY_LIBRARY, stored);
      } catch {
        // Typically the browser's quota, or site data being blocked. The lookups go on; the page says that they will not survive a reload.
        failed = true;
      }
      if (failed !== this.saveFailed) {
        this.saveFailed = failed;
        this.notifyProgress();
      }
    });
  }

  // --- graph and layout ---------------------------------------------------------------------------

  private rebuild(mode: Rebuild, firstBudgetMs: number): void {
    const started = performance.now();
    const mine = this.showing === 'mine' ? this.mine : null;
    const data = mine ? mine.toData() : loadLibrary(FILE, this.excluded);
    const graph = buildGraph(data);
    this.stale = false;
    this.lastRebuildAt = started;
    this.lastRebuildCostMs = performance.now() - started;
    const layoutKey = mine ? KEY_LAYOUT_MINE : KEY_LAYOUT;

    const generation = ++this.generation;
    const publish = (xs: Float64Array, ys: Float64Array, settled: boolean) => {
      this.snapshot = new UniverseSnapshot(data, graph, xs, ys, settled, generation);
      this.notify();
    };

    const previous = mode === 'evolve' && this.snapshot.graph.nodes.length > 0 ? this.snapshot : null;
    const seed = new Map<string, readonly [number, number]>();
    if (previous) {
      for (const node of previous.graph.nodes) seed.set(node.id, [previous.xs[node.index], previous.ys[node.index]]);
    } else if (mode === 'restore') {
      for (const [id, position] of Object.entries(read<Record<string, [number, number]>>(layoutKey, {}))) {
        if (Array.isArray(position) && position.every(Number.isFinite)) seed.set(id, position);
      }
    }

    const layout = new ForceLayout(graph, seed);
    const everyoneSeeded = layout.seededCount === graph.nodes.length;
    // Positions that were still moving are not worth keeping as they are.
    const unchanged = everyoneSeeded && previous !== null && previous.settled && sameStructure(previous.graph, graph);
    const restored = everyoneSeeded && mode === 'restore';
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
        write(layoutKey, Object.fromEntries(graph.nodes.map((node) => [node.id, [round(layout.xs[node.index]), round(layout.ys[node.index])]])));
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
