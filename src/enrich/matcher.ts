import type { LibraryItem, MatchStatus } from '../model/types';
import { creditedName, type MbRecording } from './musicbrainz';
import { artistSimilarity, durationSimilarity, titleSimilarity } from './textMatch';

export interface ScoredRecording {
  candidate: MbRecording;
  score: number;
  titleSimilarity: number;
  artistSimilarity: number;
  /** The candidate appears on the album the song was saved from. */
  onAlbum: boolean;
}

// Decides whether a MusicBrainz candidate is trustworthy enough to take credits from.
//
// The rule the product depends on: a doubtful match is kept as LOW_CONFIDENCE with no credits,
// never drawn as fact on a best guess.

/** Text-search matches at or above this score are accepted. */
export const ACCEPT = 0.82;

/** Below ACCEPT but at or above this, the candidate is kept for the user to confirm. */
export const DOUBT = 0.55;

/** However well the rest fits, a candidate whose artist resembles the library's less than this is not accepted. */
export const MIN_ARTIST = 0.7;

/** Candidates scoring within this of the best are the same song as far as the text can tell. */
export const TIE = 0.01;

const RENDITION = /\b(live|remix|dj[-‐ ]?mix|megamix|demo|acoustic|instrumental|karaoke|session|rehearsal|cover|medley|a cappella|acapella)\b/g;

function isOtherRendition(itemTitle: string, disambiguation: string | null | undefined): boolean {
  const title = itemTitle.toLowerCase();
  return [...(disambiguation ?? '').toLowerCase().matchAll(RENDITION)].some((match) => !title.includes(match[0]));
}

const ALBUM_SUFFIX = /\s+-\s+(EP|Single)\s*$/i;

/** Apple Music names singles and EPs "Title - Single" / "Title - EP"; MusicBrainz does not. */
export const albumTitle = (raw: string): string => raw.replace(ALBUM_SUFFIX, '');

export function scoreRecording(item: LibraryItem, recording: MbRecording): ScoredRecording {
  const credit = recording['artist-credit'] ?? [];
  const names = credit.map((c) => c.name ?? c.artist.name ?? '');
  const title = titleSimilarity(item.title, recording.title ?? '');
  const aliases = credit.flatMap((c) => [c.artist.name ?? '', ...(c.artist.aliases ?? []).map((alias) => alias.name ?? '')]);
  const artist = artistSimilarity(item.artist, names, creditedName(credit), aliases);
  const duration = durationSimilarity(item.durationMs, recording.length);
  let score = 0.45 * title + 0.35 * artist + 0.2 * duration;
  const album = item.album ? albumTitle(item.album) : null;
  const onAlbum = album !== null && (recording.releases ?? []).some((release) => titleSimilarity(album, release.title ?? '') >= 0.9);
  if (onAlbum) score += 0.05;
  // Music videos are separate MusicBrainz recordings and rarely carry studio credits.
  if (recording.video === true) score -= 0.2;
  // A live take or a DJ mix of the song is a different recording with its own credits. Unless the
  // library's title says that is what was saved, it must not pass as the song.
  if (isOtherRendition(item.title, recording.disambiguation)) score -= 0.2;
  return { candidate: recording, score: Math.min(Math.max(score, 0), 1), titleSimilarity: title, artistSimilarity: artist, onAlbum };
}

/**
 * Orders candidates best first, and does it the same way every time.
 *
 * MusicBrainz often holds several recordings of one song that score identically (the album cut, a
 * single, a streaming re-upload) and returns them in no fixed order. Among those, one found on
 * the library's own album goes first, then the one on the most releases: that is the entry
 * editors treat as canonical and attach credits to. The id settles what is still level, so a
 * re-import cannot flip a match.
 */
export function rankRecordings(item: LibraryItem, candidates: MbRecording[]): ScoredRecording[] {
  const scored = candidates.map((candidate) => scoreRecording(item, candidate));
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((s) => s.score));
  const tied = (s: ScoredRecording) => s.score >= best - TIE;
  const spread = (s: ScoredRecording) => (tied(s) ? (s.candidate.releases ?? []).length : s.score);
  return scored.sort(
    (a, b) =>
      Number(tied(b)) - Number(tied(a)) ||
      Number(b.onAlbum) - Number(a.onAlbum) ||
      spread(b) - spread(a) ||
      b.score - a.score ||
      (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
  );
}

export function decide(scored: ScoredRecording): { status: MatchStatus; confidence: number } {
  if (scored.score >= ACCEPT && scored.titleSimilarity >= 0.85 && scored.artistSimilarity >= MIN_ARTIST) {
    return { status: 'MATCHED', confidence: scored.score };
  }
  return { status: scored.score >= DOUBT ? 'LOW_CONFIDENCE' : 'UNMATCHED', confidence: scored.score };
}
