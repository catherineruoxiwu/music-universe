import {
  GENRE_LEVELS,
  ROLES,
  SCOPES,
  type Creator,
  type Credit,
  type GenreTag,
  type LibraryItem,
} from './types';

/** Everything one analysis pass works from. Immutable once built. */
export class AnalysisData {
  readonly itemsById: ReadonlyMap<string, LibraryItem>;
  readonly creditsByItem: ReadonlyMap<string, Credit[]>;
  readonly creditsByCreator: ReadonlyMap<string, Credit[]>;
  /** Items that count: the ones the user kept in. */
  readonly analysedItems: LibraryItem[];

  constructor(
    readonly items: LibraryItem[],
    readonly creators: ReadonlyMap<string, Creator>,
    readonly credits: Credit[],
    readonly genres: GenreTag[],
  ) {
    this.itemsById = new Map(items.map((item) => [item.id, item]));
    this.creditsByItem = groupBy(credits, (c) => c.itemId);
    this.creditsByCreator = groupBy(credits, (c) => c.creatorId);
    this.analysedItems = items.filter((item) => item.included);
  }

  static readonly EMPTY = new AnalysisData([], new Map(), [], []);
}

export function groupBy<T, K>(list: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of list) {
    const k = key(value);
    const group = groups.get(k);
    if (group) group.push(value);
    else groups.set(k, [value]);
  }
  return groups;
}

/**
 * The shape of the bundled library file. Credits and genres point at items and creators by
 * position to keep the file small.
 */
export interface LibraryFile {
  items: Omit<LibraryItem, 'included'>[];
  creators: Creator[];
  /** [item index, creator index, role index, detail, scope index, track count] */
  credits: [number, number, number, string, number, number][];
  /** [item index, genre, level index, votes] */
  genres: [number, string, number, number][];
}

/** Expands a library file into analysis data, leaving out nothing but marking what is excluded. */
export function loadLibrary(file: LibraryFile, excluded: ReadonlySet<string> = new Set()): AnalysisData {
  const items: LibraryItem[] = file.items.map((item) => ({ ...item, included: !excluded.has(item.id) }));
  const creators = new Map(file.creators.map((creator) => [creator.id, creator]));
  const credits: Credit[] = file.credits.map(([item, creator, role, detail, scope, trackCount]) => ({
    itemId: file.items[item].id,
    creatorId: file.creators[creator].id,
    role: ROLES[role],
    detail,
    scope: SCOPES[scope],
    trackCount,
  }));
  const genres: GenreTag[] = file.genres.map(([item, genre, level, votes]) => ({
    itemId: file.items[item].id,
    genre,
    level: GENRE_LEVELS[level],
    votes,
  }));
  return new AnalysisData(items, creators, credits, genres);
}
