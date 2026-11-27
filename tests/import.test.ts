import { describe, expect, it } from 'vitest';
import type { Enrichment } from '../src/enrich/enricher';
import { ImportError, parseAppleLibrary } from '../src/import/appleLibrary';
import { parsePlist } from '../src/import/plist';
import { UserLibrary } from '../src/library/userLibrary';

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`;

type Value = string | number | boolean;

function dict(entries: Record<string, Value>): string {
  const value = (v: Value) => (typeof v === 'number' ? `<integer>${v}</integer>` : typeof v === 'boolean' ? `<${v}/>` : `<string>${v}</string>`);
  return `<dict>${Object.entries(entries)
    .map(([key, v]) => `<key>${key}</key>${key === 'Date Added' ? `<date>${v}</date>` : value(v)}`)
    .join('\n')}</dict>`;
}

/** A library file laid out the way the Music app writes one. */
function libraryXml(tracks: Record<string, Value>[], playlists: { entries: Record<string, Value>; items: number[] }[] = []): string {
  const trackEntries = tracks.map((track) => `<key>${track['Track ID']}</key>\n${dict(track)}`).join('\n');
  const playlistEntries = playlists
    .map(({ entries, items }) => dict(entries).replace(/<\/dict>$/, `<key>Playlist Items</key><array>${items.map((id) => dict({ 'Track ID': id })).join('')}</array></dict>`))
    .join('\n');
  return `${HEAD}<dict>
	<key>Major Version</key><integer>1</integer>
	<key>Application Version</key><string>1.5.1.24</string>
	<key>Music Folder</key><string>file:///Users/someone/Music/Music/Media.localized/</string>
	<key>Library Persistent ID</key><string>0123456789ABCDEF</string>
	<key>Tracks</key>
	<dict>
${trackEntries}
	</dict>
	<key>Playlists</key>
	<array>
${playlistEntries}
	</array>
</dict>
</plist>`;
}

const track = (id: number, name: string, artist: string, extra: Record<string, Value> = {}): Record<string, Value> => ({
  'Track ID': id,
  Name: name,
  Artist: artist,
  'Persistent ID': `PID${id}`,
  ...extra,
});

const LIBRARY_LIST = { entries: { Name: 'Library', Master: true, 'Playlist ID': 1, 'Playlist Persistent ID': 'L' } };
const MUSIC_LIST = { entries: { Name: 'Music', 'Distinguished Kind': 4, 'Playlist ID': 2, 'Playlist Persistent ID': 'M' } };

describe('property lists', () => {
  it('reads every kind of value a library file holds', () => {
    const value = parsePlist(
      `${HEAD}<dict><key>Name</key><string>Tom &amp; Jerry &#8212; &lt;live&gt; &#x6674;天</string><key>Size</key><integer>42</integer><key>Rate</key><real>0.5</real>` +
        `<key>When</key><date>2024-05-01T10:20:30Z</date><key>Yes</key><true/><key>No</key><false/><key>Blob</key><data>\nAAEC\n</data>` +
        `<key>Empty</key><string></string><key>Bare</key><string/><key>List</key><array><integer>1</integer><dict><key>a</key><integer>2</integer></dict><array/></array><key>None</key><dict/></dict></plist>`,
    );
    expect(value).toEqual({
      Name: 'Tom & Jerry — <live> 晴天',
      Size: 42,
      Rate: 0.5,
      When: '2024-05-01T10:20:30Z',
      Yes: true,
      No: false,
      Blob: '\nAAEC\n',
      Empty: '',
      Bare: '',
      List: [1, { a: 2 }, []],
      None: {},
    });
  });

  it('treats a key named like a built-in property as an ordinary key', () => {
    const value = parsePlist(`${HEAD}<dict><key>constructor</key><string>x</string><key>__proto__</key><string>y</string></dict></plist>`) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(['__proto__', 'constructor']);
    expect(value.constructor).toBe('x');
    expect(value.toString).toBeUndefined();
  });

  it('refuses what is not a property list, or only part of one', () => {
    expect(() => parsePlist('<html><body>Hello</body></html>')).toThrow();
    expect(() => parsePlist(`${HEAD}<dict><key>Tracks</key><dict><key>1</key>`)).toThrow();
    expect(() => parsePlist('')).toThrow();
  });
});

describe('Apple Music library import', () => {
  it('takes what identifies each song and nothing else', () => {
    const xml = libraryXml([
      track(101, 'Cutting My Fingers Off', 'Turnover', {
        Album: 'Peripheral Vision',
        'Album Artist': 'Turnover',
        Genre: 'Alternative',
        Kind: 'Apple Music AAC audio file',
        'Total Time': 195_984,
        Year: 2015,
        'Date Added': '2024-05-01T10:20:30Z',
        'Play Count': 57,
        Location: 'file:///Users/someone/Music/x.m4p',
      }),
    ]);

    const { choices, skipped } = parseAppleLibrary(xml);

    expect(choices).toHaveLength(1);
    expect(choices[0].songs).toEqual([
      {
        id: 'am-PID101',
        title: 'Cutting My Fingers Off',
        artist: 'Turnover',
        album: 'Peripheral Vision',
        durationMs: 195_984,
        year: 2015,
        genre: 'Alternative',
        addedAt: Date.UTC(2024, 4, 1, 10, 20, 30),
      },
    ]);
    expect(skipped).toEqual({ videos: 0, podcasts: 0, incomplete: 0, duplicates: 0 });
  });

  it('leaves out videos, podcasts, nameless entries and second copies, and says how many', () => {
    const xml = libraryXml([
      track(1, '晴天', '周杰倫', { Album: '葉惠美' }),
      track(2, 'A Music Video', 'Someone', { 'Music Video': true, 'Has Video': true }),
      track(3, 'A Film', 'Someone', { Movie: true }),
      track(4, 'Episode 12', 'Some Show', { Podcast: true }),
      track(5, '', 'Someone'),
      track(6, 'No Artist', ''),
      track(7, '晴天', '周杰倫', { Album: '葉惠美' }),
      track(8, 'Compilation Song', '', { 'Album Artist': 'Various Artists' }),
    ]);

    const { choices, skipped } = parseAppleLibrary(xml);

    expect(choices[0].songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰倫'],
      ['Compilation Song', 'Various Artists'],
    ]);
    expect(skipped).toEqual({ videos: 2, podcasts: 1, incomplete: 2, duplicates: 1 });
  });

  it('offers the whole library, the favourites and each playlist of the user’s own', () => {
    const xml = libraryXml(
      [
        track(1, 'One', 'A', { Favorited: true }),
        track(2, 'Two', 'B', { Loved: true }),
        track(3, 'Three', 'C'),
        // In a playlist that was added, but not in the library itself.
        track(4, 'Four', 'D', { 'Playlist Only': true }),
      ],
      [
        { ...LIBRARY_LIST, items: [1, 2, 3, 4] },
        { ...MUSIC_LIST, items: [1, 2, 3] },
        { entries: { Name: 'Folder', Folder: true, 'Playlist ID': 3, 'Playlist Persistent ID': 'F' }, items: [1, 3] },
        { entries: { Name: 'Road trip', 'Playlist ID': 4, 'Playlist Persistent ID': 'R' }, items: [3, 1, 3, 999] },
        { entries: { Name: 'Borrowed', 'Playlist ID': 5, 'Playlist Persistent ID': 'B' }, items: [4] },
        { entries: { Name: 'Empty', 'Playlist ID': 6, 'Playlist Persistent ID': 'E' }, items: [] },
      ],
    );

    const { choices } = parseAppleLibrary(xml);

    expect(choices.map((c) => [c.id, c.name, c.kind, c.songs.map((s) => s.title)])).toEqual([
      ['library', 'Whole library', 'library', ['One', 'Two', 'Three']],
      ['favourites', 'Favourites', 'favourites', ['One', 'Two']],
      ['playlist-R', 'Road trip', 'playlist', ['Three', 'One']],
      ['playlist-B', 'Borrowed', 'playlist', ['Four']],
    ]);
  });

  it('offers a playlist exported on its own once', () => {
    const xml = libraryXml([track(1, 'One', 'A'), track(2, 'Two', 'B')], [{ entries: { Name: 'Road trip', 'Playlist ID': 4, 'Playlist Persistent ID': 'R' }, items: [1, 2] }]);

    const { choices } = parseAppleLibrary(xml);

    expect(choices.map((c) => [c.name, c.songs.length])).toEqual([['All songs in this file', 2]]);
  });

  it('gives the same song the same id in a later export', () => {
    const first = parseAppleLibrary(libraryXml([track(10, 'One', 'A')]));
    const later = parseAppleLibrary(libraryXml([track(77, 'One', 'A', { 'Persistent ID': 'PID10' })]));
    expect(later.choices[0].songs[0].id).toBe(first.choices[0].songs[0].id);
  });

  it('explains what is wrong with a file it cannot use', () => {
    expect(() => parseAppleLibrary('just some text')).toThrow(ImportError);
    expect(() => parseAppleLibrary(`${HEAD}<dict><key>Something</key><string>else</string></dict></plist>`)).toThrow(/no list of songs/);
    expect(() => parseAppleLibrary(libraryXml([track(1, 'A Film', 'Someone', { Movie: true })]))).toThrow(/No songs were found/);
  });
});

describe('UserLibrary', () => {
  const songs = parseAppleLibrary(libraryXml([track(1, 'One', 'A', { Genre: 'Indie Rock' }), track(2, 'Two', 'B'), track(3, 'Three', 'C')])).choices[0].songs;
  const meta = () => ({ fileName: 'Library.xml', choice: 'Whole library', importedAt: 1, paused: false });

  function found(id: string, withCredits: boolean): Enrichment {
    const item = { ...UserLibrary.fromSongs(songs, meta()).item(id)!, matchStatus: 'MATCHED' as const, creditsStatus: withCredits ? ('FETCHED' as const) : ('EMPTY' as const), recordingMbid: 'rec-' + id };
    return {
      item,
      creators: [
        { id: 'artist', name: 'A' },
        { id: 'producer', name: 'P' },
      ],
      credits: [
        { itemId: id, creatorId: 'artist', role: 'ARTIST', detail: '', scope: 'RECORDING', trackCount: 0 },
        ...(withCredits ? [{ itemId: id, creatorId: 'producer', role: 'PRODUCER' as const, detail: 'producer', scope: 'RECORDING' as const, trackCount: 0 }] : []),
      ],
      genres: [{ itemId: id, genre: 'indie rock', level: 'RECORDING', votes: 3 }],
      replaceCredits: true,
    };
  }

  it('starts with every song waiting, and its own genre kept as the library’s word', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    expect(library.counts()).toEqual({ total: 3, remaining: 3, withCredits: 0, noCredits: 0, needsReview: 0, unmatched: 0, failed: 0 });
    expect(library.next()?.id).toBe('am-PID1');
    expect(library.toData().genres).toEqual([{ itemId: 'am-PID1', genre: 'indie rock', level: 'SOURCE', votes: 1 }]);
  });

  it('stores what a lookup found without undoing the user’s exclusion', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    library.update('am-PID1', { included: false });

    library.apply(found('am-PID1', true));

    const item = library.item('am-PID1')!;
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.included).toBe(false);
    expect(library.next()?.id).toBe('am-PID2');
    const data = library.toData();
    expect(data.credits.map((c) => c.role)).toEqual(['ARTIST', 'PRODUCER']);
    expect(data.genres.map((g) => g.level).sort()).toEqual(['RECORDING', 'SOURCE']);
    expect(library.counts()).toMatchObject({ remaining: 2, withCredits: 1 });
  });

  it('hands out snapshots that later changes do not reach', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    const before = library.toData();
    library.apply(found('am-PID1', true));
    expect(before.items[0].matchStatus).toBe('PENDING');
    expect(before.credits).toEqual([]);
  });

  it('keeps the credits already stored when a later lookup fails', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    library.apply(found('am-PID1', true));

    library.apply({ item: { ...library.item('am-PID1')!, creditsStatus: 'FAILED', lastError: 'MusicBrainz returned HTTP 500' }, creators: [], credits: [], genres: [], replaceCredits: false });

    expect(library.toData().credits).toHaveLength(2);
    expect(library.counts()).toMatchObject({ failed: 1, withCredits: 0 });
  });

  it('looks up first what the user asked for', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    library.prioritise('am-PID3');
    expect(library.next()?.id).toBe('am-PID3');
    library.apply(found('am-PID3', false));
    expect(library.next()?.id).toBe('am-PID1');
    expect(library.counts()).toMatchObject({ remaining: 2, noCredits: 1 });
  });

  it('forgets a lookup completely when asked to start over', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    library.apply(found('am-PID1', true));

    library.clearLookup('am-PID1', { matchStatus: 'PENDING' });

    expect(library.item('am-PID1')).toMatchObject({ matchStatus: 'PENDING', creditsStatus: 'NOT_QUERIED' });
    expect(library.item('am-PID1')!.recordingMbid).toBeUndefined();
    const data = library.toData();
    expect(data.credits).toEqual([]);
    expect(data.genres.map((g) => g.level)).toEqual(['SOURCE']);
  });

  it('comes back from storage as it went in', () => {
    const library = UserLibrary.fromSongs(songs, meta());
    library.apply(found('am-PID1', true));
    library.apply(found('am-PID2', false));
    library.update('am-PID2', { included: false });

    const stored = JSON.parse(JSON.stringify(library.toStored()));
    const restored = UserLibrary.fromStored(stored);

    expect(restored.meta).toEqual(library.meta);
    expect(restored.items).toEqual(JSON.parse(JSON.stringify(library.items)));
    expect(restored.counts()).toEqual(library.counts());
    const [a, b] = [library.toData(), restored.toData()];
    expect(b.credits).toEqual(a.credits);
    expect(b.genres).toEqual(a.genres);
    expect([...b.creators.values()]).toEqual([...a.creators.values()]);
    // Creators nobody is credited as any more are not carried along.
    expect(stored.creators.map((c: { id: string }) => c.id)).toEqual(['artist', 'producer']);
  });
});
