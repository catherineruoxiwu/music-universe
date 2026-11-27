/**
 * The four roles the Universe shows, plus OTHER for credits that are real but outside those four
 * (engineering, mixing, arranging). OTHER is listed on detail pages and never drawn.
 *
 * The order matters: it is the order roles are listed in everywhere, and how ties are settled.
 */
export const ROLES = ['ARTIST', 'PRODUCER', 'SONGWRITER', 'MUSICIAN', 'OTHER'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that put a person on the map. */
export const GRAPHED: readonly Role[] = ['ARTIST', 'PRODUCER', 'SONGWRITER', 'MUSICIAN'];

const ORDINAL: Record<Role, number> = { ARTIST: 0, PRODUCER: 1, SONGWRITER: 2, MUSICIAN: 3, OTHER: 4 };

export const ordinal = (role: Role): number => ORDINAL[role];
export const bit = (role: Role): number => 1 << ORDINAL[role];
export const isGraphed = (role: Role): boolean => role !== 'OTHER';

/** "Artist", "Producer", … */
export const roleName = (role: Role): string => role.charAt(0) + role.slice(1).toLowerCase();

/** "Artists", "Producers", … */
export const rolePlural = (role: Role): string => (role === 'OTHER' ? 'Other credits' : roleName(role) + 's');

export type ItemKind = 'SONG' | 'ALBUM';

/** Outcome of resolving a library item to a MusicBrainz entity. */
export type MatchStatus =
  /** Not attempted yet. */
  | 'PENDING'
  /** Resolved with enough confidence to draw credits from. */
  | 'MATCHED'
  /** A candidate exists but is not trusted, so no credits are drawn from it. */
  | 'LOW_CONFIDENCE'
  /** MusicBrainz has no usable candidate. */
  | 'UNMATCHED'
  /** The lookup itself failed. */
  | 'FAILED';

export type CreditsStatus =
  | 'NOT_QUERIED'
  /** Queried, and at least one credit was found. */
  | 'FETCHED'
  /** Queried, and MusicBrainz lists nobody. This is "not annotated", not "nobody took part". */
  | 'EMPTY'
  | 'FAILED';

/** Which MusicBrainz entity a credit was actually stated on. */
export const SCOPES = ['RECORDING', 'WORK', 'RELEASE', 'ALBUM_TRACK'] as const;
export type CreditScope = (typeof SCOPES)[number];

/** Where a genre tag was attached. Earlier in the list = closer to the work itself. */
export const GENRE_LEVELS = ['RECORDING', 'RELEASE_GROUP', 'SOURCE', 'ARTIST'] as const;
export type GenreLevel = (typeof GENRE_LEVELS)[number];

/** Artist-level genres describe the artist, not this particular work. */
export const isInferred = (level: GenreLevel): boolean => level === 'ARTIST';

export interface LibraryItem {
  id: string;
  kind: ItemKind;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  matchStatus: MatchStatus;
  matchMethod?: string;
  matchConfidence?: number;
  matchedTitle?: string;
  matchedArtist?: string;
  creditsStatus: CreditsStatus;
  recordingMbid?: string;
  releaseMbid?: string;
  /** False when the user has taken this work out of the analysis. */
  included: boolean;
}

export interface Creator {
  /** MusicBrainz artist id. */
  id: string;
  name: string;
  /** MusicBrainz artist type, e.g. "Person" or "Group". */
  type?: string;
  /** MusicBrainz's note telling same-named artists apart. */
  note?: string;
}

export interface Credit {
  itemId: string;
  creatorId: string;
  role: Role;
  /** What exactly they did, e.g. "co-producer", "guitar", "lyricist". May be empty. */
  detail: string;
  scope: CreditScope;
  /** For ALBUM_TRACK credits, how many of the album's tracks carry it. */
  trackCount: number;
}

export interface GenreTag {
  itemId: string;
  genre: string;
  level: GenreLevel;
  votes: number;
}
