import { normalize } from '../enrich/textMatch';
import { parsePlist, type PlistDict, type PlistValue } from './plist';

/** One song as a music library lists it, before anything has been looked up. */
export interface ImportedSong {
  /** Stable across exports of the same library. */
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  year?: number;
  /** The library's own genre label. */
  genre?: string;
  addedAt?: number;
}

/** A part of the file that can be imported on its own: the whole library, the favourites, or one playlist. */
export interface ImportChoice {
  id: string;
  name: string;
  kind: 'library' | 'favourites' | 'playlist';
  songs: ImportedSong[];
}

export interface ParsedLibrary {
  /** Never empty. The whole library comes first when the file has one. */
  choices: ImportChoice[];
  /** Entries that are not songs, or cannot be looked up, by reason. */
  skipped: { videos: number; podcasts: number; incomplete: number; duplicates: number };
}

/** The file could be read but is not something that can be imported. The message is for the user. */
export class ImportError extends Error {}

const isDict = (value: PlistValue | undefined): value is PlistDict => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: PlistValue | undefined): string => (typeof value === 'string' ? value.trim() : '');
const positive = (value: PlistValue | undefined): number | undefined => (typeof value === 'number' && value > 0 ? value : undefined);

/**
 * Reads a library or playlist exported from the Music app (File > Library > Export Library…), or
 * from iTunes before it.
 *
 * Only what is needed to recognise each song is taken: name, artist, album, length, year, genre
 * and the date added. File locations, play counts and ratings are ignored.
 */
export function parseAppleLibrary(xml: string): ParsedLibrary {
  let root: PlistValue;
  try {
    root = parsePlist(xml);
  } catch {
    throw new ImportError('This file isn’t a library exported from the Music app. Export it with File › Library › Export Library… and choose the .xml file it saves.');
  }
  const tracks = isDict(root) ? root.Tracks : undefined;
  if (!isDict(tracks)) {
    throw new ImportError('This file has no list of songs in it. Export the library from the Music app with File › Library › Export Library… and choose the .xml file it saves.');
  }

  const skipped = { videos: 0, podcasts: 0, incomplete: 0, duplicates: 0 };
  const byTrackId = new Map<number, ImportedSong>();
  const bySignature = new Map<string, ImportedSong>();
  const library = new Set<ImportedSong>();
  const favourites: ImportedSong[] = [];

  for (const track of Object.values(tracks)) {
    if (!isDict(track)) continue;
    if (track.Podcast === true || track.Audiobook === true) {
      skipped.podcasts++;
      continue;
    }
    if (track.Movie === true || track['TV Show'] === true || track['Music Video'] === true || track['Has Video'] === true) {
      skipped.videos++;
      continue;
    }
    const title = text(track.Name);
    const artist = text(track.Artist) || text(track['Album Artist']);
    if (title === '' || artist === '') {
      skipped.incomplete++;
      continue;
    }
    const album = text(track.Album);
    const trackId = typeof track['Track ID'] === 'number' ? track['Track ID'] : -1;
    const inLibrary = track['Playlist Only'] !== true;

    // The same song saved twice (a re-download, a second copy) is one song here.
    const signature = [normalize(title), normalize(artist), normalize(album)].join('\n');
    const known = bySignature.get(signature);
    if (known) {
      byTrackId.set(trackId, known);
      if (inLibrary) {
        if (library.has(known)) skipped.duplicates++;
        else library.add(known);
      }
      continue;
    }

    const added = Date.parse(text(track['Date Added']));
    const song: ImportedSong = {
      id: 'am-' + (text(track['Persistent ID']) || String(trackId)),
      title,
      artist,
      ...(album ? { album } : {}),
      ...(positive(track['Total Time']) ? { durationMs: positive(track['Total Time']) } : {}),
      ...(positive(track.Year) ? { year: positive(track.Year) } : {}),
      ...(text(track.Genre) ? { genre: text(track.Genre) } : {}),
      ...(Number.isFinite(added) ? { addedAt: added } : {}),
    };
    bySignature.set(signature, song);
    byTrackId.set(trackId, song);
    if (inLibrary) library.add(song);
    if (inLibrary && (track.Favorited === true || track.Loved === true)) favourites.push(song);
  }

  const playlists = (isDict(root) && Array.isArray(root.Playlists) ? root.Playlists : []).filter(isDict);
  // An exported library lists itself as a playlist; a file without one is a single exported playlist.
  const wholeLibrary = playlists.some((playlist) => playlist.Master === true);
  const choices: ImportChoice[] = [];
  if (library.size > 0) {
    choices.push({ id: 'library', name: wholeLibrary ? 'Whole library' : 'All songs in this file', kind: 'library', songs: [...library] });
  }
  if (favourites.length > 0 && favourites.length < library.size) {
    choices.push({ id: 'favourites', name: 'Favourites', kind: 'favourites', songs: favourites });
  }

  for (const playlist of playlists) {
    if (!Array.isArray(playlist['Playlist Items'])) continue;
    // The built-in lists (Library, Music, Downloaded…) repeat the library; folders hold no songs of their own.
    if (playlist.Master === true || playlist.Folder === true || playlist['Distinguished Kind'] !== undefined) continue;
    const songs = new Set<ImportedSong>();
    for (const entry of playlist['Playlist Items']) {
      const song = isDict(entry) && typeof entry['Track ID'] === 'number' ? byTrackId.get(entry['Track ID']) : undefined;
      if (song) songs.add(song);
    }
    if (songs.size === 0) continue;
    // A playlist exported on its own would otherwise be offered twice.
    if (songs.size === library.size && [...songs].every((song) => library.has(song))) continue;
    choices.push({
      id: 'playlist-' + (text(playlist['Playlist Persistent ID']) || String(playlist['Playlist ID'] ?? choices.length)),
      name: text(playlist.Name) || 'Untitled playlist',
      kind: 'playlist',
      songs: [...songs],
    });
  }

  if (choices.length === 0) {
    throw new ImportError('No songs were found in this file. Videos, podcasts and entries without a title or an artist can’t be looked up.');
  }
  return { choices, skipped };
}
