// The slice of the MusicBrainz web service (ws/2) this app uses, and a client that keeps to its rules.

export interface MbGenre {
  name?: string;
  count?: number;
}

export interface MbArtist {
  id: string;
  name?: string;
  type?: string | null;
  disambiguation?: string | null;
  /** Other names of the artist: translations, transliterations, former names. Search results carry them. */
  aliases?: { name?: string }[];
  genres?: MbGenre[];
}

export interface MbArtistCredit {
  name?: string | null;
  joinphrase?: string | null;
  artist: MbArtist;
}

export interface MbRelation {
  type?: string;
  attributes?: string[];
  artist?: MbArtist | null;
  work?: MbWork | null;
}

export interface MbWork {
  id: string;
  relations?: MbRelation[];
}

export interface MbReleaseGroup {
  id: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string | null;
  genres?: MbGenre[];
}

export interface MbRelease {
  id: string;
  title?: string | null;
  status?: string | null;
  date?: string | null;
  'release-group'?: MbReleaseGroup | null;
}

export interface MbRecording {
  id: string;
  title?: string;
  length?: number | null;
  video?: boolean | null;
  /** Editors' note telling same-named recordings apart, e.g. "live, 2008-06-09: ..." or "DJ-mix". */
  disambiguation?: string | null;
  'first-release-date'?: string | null;
  'artist-credit'?: MbArtistCredit[];
  releases?: MbRelease[];
  relations?: MbRelation[];
  genres?: MbGenre[];
}

/** What the enricher needs from MusicBrainz. Tests supply a fake. */
export interface MusicBrainzApi {
  searchRecordings(query: string): Promise<MbRecording[]>;
  recording(mbid: string): Promise<MbRecording>;
}

/** The names of a credit as printed: "A feat. B". */
export function creditedName(credit: MbArtistCredit[] | undefined): string {
  return (credit ?? []).map((c) => (c.name ?? c.artist.name ?? '') + (c.joinphrase ?? '')).join('');
}

/** MusicBrainz answered, but not with what was asked for. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`MusicBrainz returned HTTP ${status}`);
  }
}

/** MusicBrainz could not be reached at all: offline, blocked, or timed out. */
export class NetworkError extends Error {}

export interface PoliteOptions {
  fetch?: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  maxRetries?: number;
  /**
   * Where the time of the latest request is kept, when it should outlive this object: reloading
   * the page must not be a way of asking twice within a second.
   */
  lastRequest?: { get(): number; set(at: number): void };
}

const RETRY_PADDING_MS = 500;
const MAX_NETWORK_RETRIES = 3;
const TIMEOUT_MS = 40_000;

const backoffMs = (attempt: number) => 2_000 << Math.min(attempt, 4);

/**
 * Enforces MusicBrainz's public rate limit (one request per second on average) and backs off when
 * the server says it is busy. Both are conditions of using the public API, not optimisations.
 */
export class PoliteFetcher {
  private readonly fetch: typeof fetch;
  private readonly sleep: PoliteOptions['sleep'];
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly lastRequest: PoliteOptions['lastRequest'];
  private nextAllowedAt = 0;

  constructor(options: PoliteOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 1_100;
    this.maxRetries = options.maxRetries ?? 6;
    this.lastRequest = options.lastRequest;
  }

  async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; ) {
      await this.awaitTurn(signal);
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        response = await this.fetch(url, {
          headers: { Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // A dead connection is not worth as many tries as a busy server. A refusal for asking too
        // fast can also land here: without the headers that let a page read it, it looks the same.
        if (attempt >= Math.min(this.maxRetries, MAX_NETWORK_RETRIES)) throw new NetworkError(String(error));
        await this.sleep(backoffMs(attempt++), signal);
        continue;
      }
      // 503 is MusicBrainz's "busy / slow down"; 429 is used by some gateways.
      if ((response.status === 503 || response.status === 429) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        // When the server names a wait, take it at its word, plus a little more each time.
        await this.sleep(retryAfter > 0 ? retryAfter * 1_000 + RETRY_PADDING_MS * attempt : backoffMs(attempt), signal);
        attempt++;
        continue;
      }
      if (!response.ok) throw new HttpError(response.status);
      return response.json();
    }
  }

  /** Requests are serialised: each waits until `minIntervalMs` after the previous one started. */
  private async awaitTurn(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    // A remembered time in the future is a clock that was changed; it must not hold things up.
    const remembered = Math.min(this.lastRequest?.get() ?? 0, now) + this.minIntervalMs;
    const startAt = Math.max(now, this.nextAllowedAt, remembered);
    this.nextAllowedAt = startAt + this.minIntervalMs;
    this.lastRequest?.set(startAt);
    if (startAt > now) await this.sleep(startAt - now, signal);
  }
}

const BASE_URL = 'https://musicbrainz.org/ws/2/';

/** One request returns performers, production credits, writers (via works) and genres. */
const RECORDING_INC = 'artist-credits releases release-groups genres artist-rels work-rels work-level-rels';

// A popular song has a dozen live and remixed namesakes that all score 100; ten results regularly
// left the studio recording out.
const SEARCH_LIMIT = 25;

export function createMusicBrainzApi(fetcher: PoliteFetcher, signal?: AbortSignal): MusicBrainzApi {
  const get = (path: string, params: Record<string, string>) =>
    fetcher.getJson(`${BASE_URL}${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`, signal);
  return {
    async searchRecordings(query) {
      const found = (await get('recording', { query, limit: String(SEARCH_LIMIT) })) as { recordings?: MbRecording[] };
      return found.recordings ?? [];
    },
    async recording(mbid) {
      return (await get(`recording/${encodeURIComponent(mbid)}`, { inc: RECORDING_INC })) as MbRecording;
    },
  };
}
