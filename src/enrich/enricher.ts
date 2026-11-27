import type { Creator, Credit, GenreLevel, GenreTag, LibraryItem } from '../model/types';
import { fromArtistCredit, fromRelations, type RawCredit } from './creditMapper';
import { MIN_ARTIST, TIE, albumTitle, decide, rankRecordings, scoreRecording } from './matcher';
import { HttpError, creditedName, type MbGenre, type MbRecording, type MbRelease, type MusicBrainzApi } from './musicbrainz';
import { leadArtist, lucenePhrase, stripDecorations, titleSimilarity } from './textMatch';

/** What one lookup found out about one song. */
export interface Enrichment {
  item: LibraryItem;
  creators: Creator[];
  credits: Credit[];
  /** Genres from MusicBrainz. Genres the source library gave are kept alongside these. */
  genres: GenreTag[];
  /** False when the lookup failed, so whatever credits were stored before must stay. */
  replaceCredits: boolean;
}

// Long tails of single-vote community tags are noise for a per-item genre.
const MAX_GENRES_PER_LEVEL = 5;

// Each twin costs a request, and requests are rationed to one a second.
const MAX_TWINS = 2;

const yearOf = (date: string | null | undefined): number | undefined => {
  const year = Number((date ?? '').slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
};

/** Whether a song still has a lookup to make: never tried, or matched but without its credits read. */
export const needsLookup = (item: LibraryItem): boolean =>
  item.matchStatus === 'PENDING' || (item.matchStatus === 'MATCHED' && item.creditsStatus === 'NOT_QUERIED');

/**
 * Resolves one song against MusicBrainz and reads its credits and genres.
 *
 * An answer MusicBrainz gives is never an exception: the result says whether the song was
 * matched, is doubtful, is unknown or failed. Only being unable to reach MusicBrainz at all is
 * thrown, because that says nothing about the song.
 */
export async function enrichSong(api: MusicBrainzApi, item: LibraryItem): Promise<Enrichment> {
  try {
    let matched = item;
    let twins: MbRecording[] = [];
    if (item.matchStatus !== 'MATCHED' || !item.recordingMbid) {
      const match = await matchSong(api, item);
      matched = match.item;
      twins = match.twins;
      if (matched.matchStatus !== 'MATCHED') return { item: matched, creators: [], credits: [], genres: [], replaceCredits: true };
    }

    let recording = await api.recording(matched.recordingMbid!);
    let raw = recordingCredits(recording);
    // MusicBrainz frequently has the same song twice, with the credits entered on only one copy.
    // When the copy we chose is bare, look at the copies that matched exactly as well (never at a
    // weaker match) and take the first that is documented.
    if (!raw.some((credit) => credit.role !== 'ARTIST')) {
      for (const twin of twins) {
        const other = await api.recording(twin.id);
        const otherRaw = recordingCredits(other);
        if (!otherRaw.some((credit) => credit.role !== 'ARTIST')) continue;
        recording = other;
        raw = otherRaw;
        matched = { ...matched, recordingMbid: other.id, matchedTitle: other.title ?? '', matchedArtist: creditedName(other['artist-credit']) };
        break;
      }
    }

    const release = pickRelease(item, recording.releases ?? []);
    const group = release?.['release-group'];
    const genres = [
      ...genreTags(item.id, 'RECORDING', recording.genres ?? []),
      ...genreTags(item.id, 'RELEASE_GROUP', group?.genres ?? []),
      ...genreTags(item.id, 'ARTIST', (recording['artist-credit'] ?? []).flatMap((c) => c.artist.genres ?? [])),
    ];
    const year = item.year ?? yearOf(group?.['first-release-date']) ?? yearOf(recording['first-release-date']);
    return write({ ...matched, year }, raw, genres);
  } catch (error) {
    // The service answered with an error, or with something that is not what it documents.
    if (error instanceof HttpError) return failed(item, error.message);
    if (error instanceof SyntaxError || error instanceof TypeError) return failed(item, 'Unexpected response from MusicBrainz');
    throw error;
  }
}

const recordingCredits = (recording: MbRecording): RawCredit[] => [
  ...fromArtistCredit(recording['artist-credit'], 'RECORDING'),
  ...fromRelations(recording.relations, 'RECORDING'),
];

/**
 * `twins` are other candidates that matched as well as the chosen one and would have been
 * accepted in its place, best first. Empty unless the match was accepted.
 */
async function matchSong(api: MusicBrainzApi, item: LibraryItem): Promise<{ item: LibraryItem; twins: MbRecording[] }> {
  const ranked = rankRecordings(item, await searchRecordings(api, item));
  const cleared: LibraryItem = { ...item, creditsStatus: 'NOT_QUERIED', lastError: undefined };
  if (ranked.length === 0) {
    return {
      item: { ...cleared, matchStatus: 'UNMATCHED', matchConfidence: undefined, matchMethod: undefined, recordingMbid: undefined },
      twins: [],
    };
  }
  const best = ranked[0];
  const { status, confidence } = decide(best);
  const twins =
    status !== 'MATCHED'
      ? []
      : ranked
          .slice(1)
          .filter((other) => other.score >= best.score - TIE && decide(other).status === 'MATCHED')
          .slice(0, MAX_TWINS)
          .map((other) => other.candidate);
  return {
    item: {
      ...cleared,
      matchStatus: status,
      matchConfidence: confidence,
      matchMethod: 'search',
      // Kept for doubtful matches too, so exactly this candidate can be confirmed.
      recordingMbid: status === 'UNMATCHED' ? undefined : best.candidate.id,
      matchedTitle: best.candidate.title ?? '',
      matchedArtist: creditedName(best.candidate['artist-credit']),
    },
    twins,
  };
}

async function searchRecordings(api: MusicBrainzApi, item: LibraryItem): Promise<MbRecording[]> {
  const title = lucenePhrase(stripDecorations(item.title));
  // Title and artist are required; the album is optional and only lifts recordings from it to the
  // top of the results, where the limit cannot cut them off.
  const album = item.album?.trim() ? ' release:' + lucenePhrase(stripDecorations(albumTitle(item.album))) : '';
  const found = await api.searchRecordings(`+recording:${title} +artist:${lucenePhrase(item.artist)}${album}`);
  if (found.length > 0) return found;
  // "A & B" style strings rarely match an artist phrase; retry on the lead artist alone.
  const lead = leadArtist(item.artist);
  if (lead !== null) {
    const byLead = await api.searchRecordings(`+recording:${title} +artist:${lucenePhrase(lead)}${album}`);
    if (byLead.length > 0) return byLead;
  }
  // The search knows artists by the name printed on the record. A library that calls 周杰倫
  // "Jay Chou" finds nothing above, so look by title alone: the results carry each artist's other
  // names. Only candidates by the library's artist are kept; a same-titled song by someone else
  // is not a possible match worth asking the user about.
  const byTitle = await api.searchRecordings(`+recording:${title}${album}`);
  return byTitle.filter((candidate) => scoreRecording(item, candidate).artistSimilarity >= MIN_ARTIST);
}

/** The release this song most plausibly came from: the library's album if listed, else the earliest album. */
function pickRelease(item: LibraryItem, releases: MbRelease[]): MbRelease | undefined {
  const album = item.album;
  const rank = (release: MbRelease) => {
    const group = release['release-group'];
    return [
      album && titleSimilarity(album, release.title ?? '') >= 0.85 ? 1 : 0,
      release.status === 'Official' ? 1 : 0,
      group?.['primary-type'] === 'Album' && (group['secondary-types'] ?? []).length === 0 ? 1 : 0,
    ];
  };
  // Earlier is better; undated releases sort last.
  const date = (release: MbRelease) => release.date || '9999';
  return [...releases].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2] || (date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : 0);
  })[0];
}

function write(item: LibraryItem, raw: RawCredit[], genres: GenreTag[]): Enrichment {
  const creators = new Map<string, Creator>();
  const credits = new Map<string, Credit>();
  for (const credit of raw) {
    const artist = credit.artist;
    if (!creators.has(artist.id)) {
      creators.set(artist.id, {
        id: artist.id,
        name: artist.name ?? '',
        ...(artist.type ? { type: artist.type } : {}),
        ...(artist.disambiguation?.trim() ? { note: artist.disambiguation } : {}),
      });
    }
    const key = [artist.id, credit.role, credit.detail, credit.scope].join('\n');
    if (!credits.has(key)) {
      credits.set(key, { itemId: item.id, creatorId: artist.id, role: credit.role, detail: credit.detail, scope: credit.scope, trackCount: 0 });
    }
  }
  // "Has role data" means more than the performer credit every recording carries.
  const hasCredits = [...credits.values()].some((credit) => credit.role !== 'ARTIST');
  return {
    item: { ...item, creditsStatus: hasCredits ? 'FETCHED' : 'EMPTY', lastError: undefined },
    creators: [...creators.values()],
    credits: [...credits.values()],
    genres,
    replaceCredits: true,
  };
}

function genreTags(itemId: string, level: GenreLevel, genres: MbGenre[]): GenreTag[] {
  const votes = new Map<string, number>();
  for (const genre of genres) {
    const name = (genre.name ?? '').trim().toLowerCase();
    if (name !== '') votes.set(name, (votes.get(name) ?? 0) + (genre.count ?? 1));
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GENRES_PER_LEVEL)
    .map(([genre, count]) => ({ itemId, genre, level, votes: count }));
}

function failed(item: LibraryItem, message: string): Enrichment {
  const alreadyMatched = item.matchStatus === 'MATCHED';
  return {
    item: {
      ...item,
      matchStatus: alreadyMatched ? 'MATCHED' : 'FAILED',
      creditsStatus: alreadyMatched ? 'FAILED' : item.creditsStatus,
      lastError: message,
    },
    creators: [],
    credits: [],
    genres: [],
    replaceCredits: false,
  };
}
