import { needsLookup, type Enrichment } from '../enrich/enricher';
import type { ImportedSong } from '../import/appleLibrary';
import { AnalysisData, type LibraryFile } from '../model/data';
import { GENRE_LEVELS, ROLES, SCOPES, type Creator, type Credit, type GenreTag, type LibraryItem } from '../model/types';

export interface LibraryMeta {
  /** Name of the file the library was read from. */
  fileName: string;
  /** Which part of the file was imported, e.g. "Whole library" or a playlist's name. */
  choice: string;
  importedAt: number;
  /** The user stopped the lookups; they must not start again by themselves. */
  paused: boolean;
}

/** How a library is kept in the browser: the bundled demo's format, plus where it came from. */
export interface StoredLibrary extends LibraryFile {
  version: 1;
  meta: LibraryMeta;
  items: LibraryItem[];
}

export interface LibraryCounts {
  total: number;
  /** Still to be looked up. */
  remaining: number;
  withCredits: number;
  noCredits: number;
  needsReview: number;
  unmatched: number;
  failed: number;
}

/**
 * A library the user imported, filling in as its songs are looked up. Items are replaced, never
 * changed in place, so data handed out earlier stays as it was.
 */
export class UserLibrary {
  private readonly position = new Map<string, number>();
  private readonly creators = new Map<string, Creator>();
  private readonly credits = new Map<string, Credit[]>();
  private readonly genres = new Map<string, GenreTag[]>();
  /** Ids to look up before the rest, most recently asked for first. Not stored: it is a wish of this visit. */
  private readonly front: string[] = [];

  private constructor(
    readonly meta: LibraryMeta,
    readonly items: LibraryItem[],
  ) {
    items.forEach((item, i) => this.position.set(item.id, i));
  }

  static fromSongs(songs: ImportedSong[], meta: LibraryMeta): UserLibrary {
    const library = new UserLibrary(
      meta,
      songs.map((song) => ({
        id: song.id,
        kind: 'SONG',
        title: song.title,
        artist: song.artist,
        album: song.album,
        year: song.year,
        durationMs: song.durationMs,
        addedAt: song.addedAt,
        matchStatus: 'PENDING',
        creditsStatus: 'NOT_QUERIED',
        included: true,
      })),
    );
    for (const song of songs) {
      if (song.genre) library.genres.set(song.id, [{ itemId: song.id, genre: song.genre.toLowerCase(), level: 'SOURCE', votes: 1 }]);
    }
    return library;
  }

  static fromStored(stored: StoredLibrary): UserLibrary {
    const library = new UserLibrary(stored.meta, stored.items);
    for (const creator of stored.creators) library.creators.set(creator.id, creator);
    for (const [item, creator, role, detail, scope, trackCount] of stored.credits) {
      const itemId = stored.items[item].id;
      const credit: Credit = { itemId, creatorId: stored.creators[creator].id, role: ROLES[role], detail, scope: SCOPES[scope], trackCount };
      const list = library.credits.get(itemId);
      if (list) list.push(credit);
      else library.credits.set(itemId, [credit]);
    }
    for (const [item, genre, level, votes] of stored.genres) {
      const itemId = stored.items[item].id;
      const tag: GenreTag = { itemId, genre, level: GENRE_LEVELS[level], votes };
      const list = library.genres.get(itemId);
      if (list) list.push(tag);
      else library.genres.set(itemId, [tag]);
    }
    return library;
  }

  toStored(): StoredLibrary {
    const creatorIndex = new Map<string, number>();
    const creators: Creator[] = [];
    const credits: StoredLibrary['credits'] = [];
    const genres: StoredLibrary['genres'] = [];
    this.items.forEach((item, i) => {
      for (const credit of this.credits.get(item.id) ?? []) {
        let index = creatorIndex.get(credit.creatorId);
        if (index === undefined) {
          index = creators.length;
          creatorIndex.set(credit.creatorId, index);
          creators.push(this.creators.get(credit.creatorId)!);
        }
        credits.push([i, index, ROLES.indexOf(credit.role), credit.detail, SCOPES.indexOf(credit.scope), credit.trackCount]);
      }
      for (const tag of this.genres.get(item.id) ?? []) genres.push([i, tag.genre, GENRE_LEVELS.indexOf(tag.level), tag.votes]);
    });
    return { version: 1, meta: { ...this.meta }, items: this.items.slice(), creators, credits, genres };
  }

  item(id: string): LibraryItem | undefined {
    const index = this.position.get(id);
    return index === undefined ? undefined : this.items[index];
  }

  /** Replaces an item with a changed copy. Unknown ids are ignored. */
  update(id: string, change: Partial<LibraryItem>): void {
    const index = this.position.get(id);
    if (index !== undefined) this.items[index] = { ...this.items[index], ...change };
  }

  /** Stores what a lookup found. Whether the work is included stays as the user last set it. */
  apply(found: Enrichment): void {
    const id = found.item.id;
    const current = this.item(id);
    if (!current) return;
    this.update(id, { ...found.item, included: current.included });
    if (!found.replaceCredits) return;
    for (const creator of found.creators) this.creators.set(creator.id, creator);
    this.credits.set(id, found.credits);
    // What the source library said about the genre is kept beside what MusicBrainz says.
    this.genres.set(id, [...(this.genres.get(id) ?? []).filter((tag) => tag.level === 'SOURCE'), ...found.genres]);
  }

  /** Forgets what was found for an item, leaving it as the source library listed it. */
  clearLookup(id: string, change: Partial<LibraryItem>): void {
    this.update(id, {
      matchConfidence: undefined,
      matchMethod: undefined,
      matchedTitle: undefined,
      matchedArtist: undefined,
      recordingMbid: undefined,
      lastError: undefined,
      creditsStatus: 'NOT_QUERIED',
      ...change,
    });
    this.credits.delete(id);
    this.genres.set(id, (this.genres.get(id) ?? []).filter((tag) => tag.level === 'SOURCE'));
  }

  /** Puts a work at the front of the queue. */
  prioritise(id: string): void {
    this.front.unshift(id);
  }

  /** The next song with a lookup to make, or undefined when all are done. */
  next(): LibraryItem | undefined {
    while (this.front.length > 0) {
      const item = this.item(this.front[0]);
      if (item && needsLookup(item)) return item;
      this.front.shift();
    }
    return this.items.find(needsLookup);
  }

  counts(): LibraryCounts {
    const counts: LibraryCounts = { total: this.items.length, remaining: 0, withCredits: 0, noCredits: 0, needsReview: 0, unmatched: 0, failed: 0 };
    for (const item of this.items) {
      if (needsLookup(item)) counts.remaining++;
      else if (item.matchStatus === 'LOW_CONFIDENCE') counts.needsReview++;
      else if (item.matchStatus === 'UNMATCHED') counts.unmatched++;
      else if (item.matchStatus === 'FAILED' || item.creditsStatus === 'FAILED') counts.failed++;
      else if (item.creditsStatus === 'FETCHED') counts.withCredits++;
      else counts.noCredits++;
    }
    return counts;
  }

  /** A snapshot for analysis; later changes to the library do not reach it. */
  toData(): AnalysisData {
    return new AnalysisData(this.items.slice(), new Map(this.creators), [...this.credits.values()].flat(), [...this.genres.values()].flat());
  }
}
