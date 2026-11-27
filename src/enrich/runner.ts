import type { UserLibrary } from '../library/userLibrary';
import { enrichSong } from './enricher';
import { NetworkError, type MusicBrainzApi } from './musicbrainz';

export type RunState =
  /** Not looking anything up: finished, or stopped by the user. */
  | 'idle'
  | 'running'
  /** MusicBrainz cannot be reached. Starts again by itself when the connection is back. */
  | 'offline'
  /** Another tab of this site is already doing the lookups. */
  | 'elsewhere';

export interface RunnerHooks {
  /** A song's lookup finished and the library holds the result. */
  onItem(): void;
  /** The state changed. */
  onState(): void;
}

const LOCK = 'music-universe:lookups';

/**
 * What one song takes before there is a pace to measure: a search and a lookup a second apart,
 * and the waits MusicBrainz asks for when it is busy, which is much of the time.
 */
export const TYPICAL_MS = 3_500;

/** Works through a library's songs one at a time until none is left to look up. */
export class EnrichmentRunner {
  state: RunState = 'idle';
  /** Title of the song being looked up. */
  current: string | null = null;

  private abort: AbortController | null = null;
  private averageMs = TYPICAL_MS;

  constructor(
    private readonly library: UserLibrary,
    private readonly hooks: RunnerHooks,
    private readonly createApi: (signal: AbortSignal) => MusicBrainzApi,
  ) {}

  /** Roughly how long the remaining lookups will take. */
  etaMs(remaining: number): number {
    return remaining * this.averageMs;
  }

  start(): void {
    if (this.abort || !this.library.next()) return;
    const abort = new AbortController();
    this.abort = abort;
    this.setState('running');
    const work = async () => {
      try {
        // Two tabs working through the same library would ask for everything twice, and twice as fast as allowed.
        if (navigator.locks) {
          await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
            if (lock) await this.run(abort.signal);
            else this.setState('elsewhere');
          });
        } else {
          await this.run(abort.signal);
        }
      } finally {
        if (this.abort === abort) this.abort = null;
        this.current = null;
        if (this.state === 'running') this.setState('idle');
      }
    };
    void work();
  }

  /** Stops after abandoning the lookup in progress; that song stays to be looked up. */
  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.current = null;
    this.setState('idle');
  }

  private setState(state: RunState): void {
    this.state = state;
    this.hooks.onState();
  }

  private async run(signal: AbortSignal): Promise<void> {
    const api = this.createApi(signal);
    while (!signal.aborted) {
      const item = this.library.next();
      if (!item) return;
      this.current = item.title;
      this.hooks.onState();
      const started = performance.now();
      try {
        this.library.apply(await enrichSong(api, item));
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof NetworkError) {
          // Nothing was learnt about the song, so it stays in the queue.
          this.setState('offline');
          return;
        }
        // A fault in handling one song must not hold up the thousands behind it. The song is
        // marked as failed, which the page shows and offers to retry.
        console.error(error);
        this.library.update(item.id, { matchStatus: 'FAILED', lastError: 'Something went wrong while reading the answer' });
      }
      this.averageMs += (performance.now() - started - this.averageMs) * 0.1;
      this.hooks.onItem();
    }
  }
}
