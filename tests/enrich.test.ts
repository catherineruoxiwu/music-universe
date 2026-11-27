import { describe, expect, it } from 'vitest';
import { fromArtistCredit, fromRelations } from '../src/enrich/creditMapper';
import { enrichSong, needsLookup } from '../src/enrich/enricher';
import { decide, rankRecordings, scoreRecording } from '../src/enrich/matcher';
import { HttpError, NetworkError, type MbArtist, type MbRecording, type MbRelation, type MusicBrainzApi } from '../src/enrich/musicbrainz';
import { artistSimilarity, durationSimilarity, leadArtist, lucenePhrase, normalize, stripDecorations, titleSimilarity } from '../src/enrich/textMatch';
import type { LibraryItem } from '../src/model/types';
import searchFixture from './data/mb_recording_search.json';
import recordingFixture from './data/mb_recording_turnover.json';

function song(change: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'song',
    kind: 'SONG',
    title: 'Good Luck, Babe!',
    artist: 'Chappell Roan',
    durationMs: 218_000,
    matchStatus: 'PENDING',
    creditsStatus: 'NOT_QUERIED',
    included: true,
    ...change,
  };
}

describe('text matching', () => {
  it('ignores store decorations but not version names', () => {
    expect(stripDecorations('Hello (feat. Someone)')).toBe('Hello');
    expect(stripDecorations('Hello - 2011 Remaster')).toBe('Hello');
    expect(stripDecorations('Hello (Remastered 2009)')).toBe('Hello');
    // These name a different recording, so they must survive.
    expect(stripDecorations('Hello (Live)')).toBe('Hello (Live)');
    expect(stripDecorations("Hello (Taylor's Version)")).toBe("Hello (Taylor's Version)");
  });

  it('folds case, accents and punctuation', () => {
    expect(normalize('Beyoncé')).toBe('beyonce');
    expect(normalize('Simon & Garfunkel')).toBe('simon and garfunkel');
    expect(titleSimilarity("Don't Stop", 'don’t stop')).toBe(1);
  });

  it('keeps titles that are not written in Latin letters', () => {
    expect(normalize('晴天')).toBe('晴天');
    expect(titleSimilarity('晴天', '晴天')).toBe(1);
    expect(titleSimilarity('晴天', '雨天')).toBeLessThan(0.85);
    expect(normalize('ジェイ・チョウ')).toBe(normalize('ジェイ チョウ'));
  });

  it('reads traditional and simplified Chinese as the same text', () => {
    expect(titleSimilarity('爱情转移', '愛情轉移')).toBe(1);
    expect(titleSimilarity('听妈妈的话', '聽媽媽的話')).toBe(1);
    expect(titleSimilarity('后来', '後來')).toBe(1);
    expect(artistSimilarity('周杰伦', ['周杰倫'], '周杰倫')).toBe(1);
    // Different songs stay different.
    expect(titleSimilarity('爱情转移', '富士山下')).toBe(0);
  });

  it('accepts another name MusicBrainz records for the artist, but only that name exactly', () => {
    const aliases = ['周杰伦', 'Jay Chou', 'Jay'];
    expect(artistSimilarity('Jay Chou', ['周杰倫'], '周杰倫', aliases)).toBe(1);
    expect(artistSimilarity('Jay Chow', ['周杰倫'], '周杰倫', aliases)).toBeLessThan(0.7);
    expect(artistSimilarity('Jay Chou & Fei Yu-ching', ['周杰倫', '費玉清'], '周杰倫 & 費玉清', aliases)).toBe(0.9);
    expect(artistSimilarity('Jay Chou', ['周杰倫'], '周杰倫')).toBeLessThan(0.7);
  });

  it('does not take a live version for the studio title', () => {
    expect(titleSimilarity('Hello', 'Hello (Live at Wembley)')).toBeLessThan(0.6);
  });

  it('matches a collaboration to its lead artist, but not at full strength', () => {
    const score = artistSimilarity('Drake & Future', ['Drake'], 'Drake');
    expect(score).toBeGreaterThanOrEqual(0.85);
    expect(score).toBeLessThanOrEqual(0.9);
    expect(artistSimilarity('Drake & Future', ['Drake', 'Future'], 'Drake & Future')).toBe(1);
    expect(leadArtist('Turnover')).toBeNull();
  });

  it('tapers on length and treats an unknown length as neutral', () => {
    expect(durationSimilarity(200_000, 202_000)).toBe(1);
    expect(durationSimilarity(200_000, 260_000)).toBe(0);
    expect(durationSimilarity(undefined, 200_000)).toBe(0.5);
  });

  it('escapes quotes in search phrases', () => {
    expect(lucenePhrase('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe('matcher', () => {
  const turnover = song({ title: 'Cutting My Fingers Off', artist: 'Turnover', durationMs: 196_000 });
  const candidate = (title: string, artist: string, length: number | null, video?: boolean): MbRecording => ({
    id: 'rec',
    title,
    length,
    video,
    'artist-credit': [{ name: artist, artist: { id: 'a', name: artist } }],
  });
  const statusOf = (recording: MbRecording, item = turnover) => decide(scoreRecording(item, recording)).status;

  it('accepts an exact text match', () => {
    expect(statusOf(candidate('Cutting My Fingers Off', 'Turnover', 195_984))).toBe('MATCHED');
  });

  it('never accepts the same title by a different artist', () => {
    expect(statusOf(candidate('Cutting My Fingers Off', 'Some Cover Band', 196_000))).not.toBe('MATCHED');
  });

  it('holds an alternative version for review', () => {
    expect(statusOf(candidate('Cutting My Fingers Off (instrumental)', 'Turnover', 195_000))).toBe('LOW_CONFIDENCE');
  });

  it('leaves something unrelated unmatched', () => {
    expect(statusOf(candidate('Completely Different', 'Someone Else', 90_000))).toBe('UNMATCHED');
  });

  it('ranks a music video below the audio recording', () => {
    const audio = scoreRecording(turnover, candidate('Cutting My Fingers Off', 'Turnover', 196_000));
    const video = scoreRecording(turnover, candidate('Cutting My Fingers Off', 'Turnover', 196_000, true));
    expect(video.score).toBeLessThan(audio.score);
  });

  it('accepts a recording credited under another spelling of the artist’s name', () => {
    const saved = song({ title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269_000 });
    const sleeve = (aliases?: { name: string }[]): MbRecording => ({
      id: 'rec',
      title: '晴天',
      length: 269_706,
      'artist-credit': [{ name: '周杰倫', artist: { id: 'jay', name: '周杰倫', aliases } }],
    });
    expect(statusOf(sleeve(), saved)).toBe('MATCHED');
    const romanised = { ...saved, artist: 'Jay Chou' };
    expect(statusOf(sleeve(), romanised)).not.toBe('MATCHED');
    expect(statusOf(sleeve([{ name: 'Jay Chou' }]), romanised)).toBe('MATCHED');
  });

  it('puts the right recording first in real search results', () => {
    const best = rankRecordings(turnover, (searchFixture as unknown as { recordings: MbRecording[] }).recordings)[0];
    expect(best.candidate.title).toBe('Cutting My Fingers Off');
    expect(best.candidate.length).toBe(195_984);
    expect(decide(best).status).toBe('MATCHED');
  });
});

describe('credit mapping', () => {
  const artist = (name: string): MbArtist => ({ id: name, name });

  it('maps a real recording response to the expected credits', () => {
    const recording = recordingFixture as unknown as MbRecording;
    expect(recording.title).toBe('Cutting My Fingers Off');
    expect(fromArtistCredit(recording['artist-credit'], 'RECORDING').map((c) => c.artist.name)).toEqual(['Turnover']);

    const credits = fromRelations(recording.relations, 'RECORDING');
    const summary = credits.map((c) => `${c.artist.name}|${c.role}|${c.detail}`);
    expect(summary).toContain('Will Yip|PRODUCER|producer');
    expect(summary).toContain('Will Yip|OTHER|engineer');
    expect(summary).toContain('Will Yip|OTHER|mixing');
    expect(summary).toContain('Vince Ratti|OTHER|mixing');
    expect(summary).toContain('Colin Gorman|OTHER|assistant engineer');
    // This work has no writers listed on MusicBrainz, so none may be invented.
    expect(credits.some((c) => c.role === 'SONGWRITER')).toBe(false);
  });

  it('reads writers from the linked work and scopes them to it', () => {
    const relations: MbRelation[] = [
      {
        type: 'performance',
        work: {
          id: 'w',
          relations: [
            { type: 'composer', artist: artist('Ann') },
            { type: 'lyricist', artist: artist('Bob') },
            { type: 'publishing', artist: artist('Some Publisher') },
          ],
        },
      },
    ];
    const credits = fromRelations(relations, 'RECORDING');
    expect(credits.map((c) => [c.artist.name, c.detail])).toEqual([
      ['Ann', 'composer'],
      ['Bob', 'lyricist'],
    ]);
    expect(credits.every((c) => c.role === 'SONGWRITER' && c.scope === 'WORK')).toBe(true);
  });

  it('keeps instruments and qualifiers as detail', () => {
    const relations: MbRelation[] = [
      { type: 'instrument', attributes: ['guitar'], artist: artist('Ann') },
      { type: 'vocal', attributes: ['lead vocals'], artist: artist('Bob') },
      { type: 'producer', attributes: ['co'], artist: artist('Cy') },
      { type: 'producer', attributes: ['executive'], artist: artist('Di') },
    ];
    const credits = new Map(fromRelations(relations, 'RECORDING').map((c) => [c.artist.name, [c.role, c.detail]]));
    expect(credits.get('Ann')).toEqual(['MUSICIAN', 'guitar']);
    expect(credits.get('Bob')).toEqual(['MUSICIAN', 'lead vocals']);
    expect(credits.get('Cy')).toEqual(['PRODUCER', 'co-producer']);
    expect(credits.get('Di')).toEqual(['PRODUCER', 'executive producer']);
  });

  it('produces nothing for unknown relationship types and placeholder artists', () => {
    const relations: MbRelation[] = [
      { type: 'photography', artist: artist('Ann') },
      { type: 'producer', artist: { id: 'x', name: '[unknown]' } },
      // A relationship type that happens to be the name of something every object has.
      { type: 'constructor', artist: artist('Bob') },
    ];
    expect(fromRelations(relations, 'RECORDING')).toEqual([]);
  });
});

describe('enricher', () => {
  const performer = { name: 'Chappell Roan', artist: { id: 'artist', name: 'Chappell Roan' } };
  const producer: MbRelation = { type: 'producer', artist: { id: 'producer', name: 'Daniel Nigro' } };

  function recording(id: string, options: { length?: number; releases?: number; produced?: boolean; note?: string; album?: string } = {}): MbRecording {
    return {
      id,
      title: 'Good Luck, Babe!',
      length: options.length ?? 218_000,
      'artist-credit': [performer],
      disambiguation: options.note,
      releases: Array.from({ length: options.releases ?? 0 }, (_, i) => ({ id: `${id}-release-${i}`, title: options.album })),
      relations: options.produced ? [producer] : [],
    };
  }

  /** Serves search results in whatever order the test gives, and records what it is asked. */
  class FakeApi implements MusicBrainzApi {
    readonly queries: string[] = [];
    readonly lookups: string[] = [];
    /**
     * @param knowsArtist false to behave as the real search does when the library's name for the
     *   artist is not the one on the record: a search that names the artist finds nothing.
     */
    constructor(
      private readonly found: MbRecording[],
      private readonly knowsArtist = true,
    ) {}
    async searchRecordings(query: string): Promise<MbRecording[]> {
      this.queries.push(query);
      return this.knowsArtist || !query.includes('+artist:') ? this.found : [];
    }
    async recording(mbid: string): Promise<MbRecording> {
      this.lookups.push(mbid);
      return this.found.find((r) => r.id === mbid)!;
    }
  }

  it('ranks equally good candidates the same whatever order they arrive in', () => {
    const canonical = recording('b-canonical', { releases: 33 });
    const reupload = recording('a-reupload', { releases: 1 });
    const live = recording('c-live', { length: 255_000, releases: 2 });

    const oneWay = rankRecordings(song(), [reupload, live, canonical]).map((s) => s.candidate.id);
    const otherWay = rankRecordings(song(), [live, canonical, reupload]).map((s) => s.candidate.id);

    // The copy on the most releases leads; a weaker match never outranks a tie on releases.
    expect(oneWay).toEqual(['b-canonical', 'a-reupload', 'c-live']);
    expect(otherWay).toEqual(oneWay);
  });

  it('puts the recording on the album the user saved ahead of its equals', () => {
    const saved = song({ album: 'Good Luck, Babe! - Single' });
    const compilation = recording('a-compilation', { releases: 9, album: "Now That's What I Call Music" });
    const single = recording('b-single', { releases: 1, album: 'Good Luck, Babe!' });
    expect(rankRecordings(saved, [compilation, single]).map((s) => s.candidate.id)).toEqual(['b-single', 'a-compilation']);
  });

  it('does not accept a live take as the studio song', () => {
    const status = (note?: string) => decide(scoreRecording(song(), recording('r', { note }))).status;
    expect(status('live, 2024-06-16: Bonnaroo Music Festival')).toBe('LOW_CONFIDENCE');
    expect(status('part of “2024 MegaMix” DJ‐mix')).toBe('LOW_CONFIDENCE');
    expect(status()).toBe('MATCHED');
  });

  it('does not mark a live take down when the live version is what was saved', () => {
    const savedLive = song({ title: 'Good Luck, Babe! (Live)' });
    const noted = scoreRecording(savedLive, recording('live', { note: 'live, 2024-06-16: Bonnaroo Music Festival' }));
    const plain = scoreRecording(savedLive, recording('live'));
    expect(noted.score).toBe(plain.score);
  });

  it('falls back from a bare recording to an equally matched copy that has credits', async () => {
    const api = new FakeApi([recording('bare', { releases: 5 }), recording('documented', { releases: 1, produced: true })]);

    const found = await enrichSong(api, song());

    expect(api.lookups).toEqual(['bare', 'documented']);
    expect(found.item.matchStatus).toBe('MATCHED');
    expect(found.item.creditsStatus).toBe('FETCHED');
    // The item now points at the recording its credits really came from.
    expect(found.item.recordingMbid).toBe('documented');
    expect(found.credits.some((c) => c.role === 'PRODUCER' && c.creatorId === 'producer')).toBe(true);
    expect(found.creators.map((c) => c.name).sort()).toEqual(['Chappell Roan', 'Daniel Nigro']);
    expect(needsLookup(found.item)).toBe(false);
  });

  it('never borrows credits from a weaker match', async () => {
    // Same song title, but a different cut: 37 seconds longer.
    const api = new FakeApi([recording('bare', { releases: 5 }), recording('other-version', { length: 255_000, produced: true })]);

    const found = await enrichSong(api, song());

    expect(api.lookups).toEqual(['bare']);
    expect(found.item.recordingMbid).toBe('bare');
    expect(found.item.creditsStatus).toBe('EMPTY');
    expect(found.credits.every((c) => c.role === 'ARTIST')).toBe(true);
  });

  it('spends a single lookup on a documented first choice', async () => {
    const api = new FakeApi([recording('documented', { releases: 5, produced: true }), recording('twin', { releases: 1, produced: true })]);

    const found = await enrichSong(api, song());

    expect(api.lookups).toEqual(['documented']);
    expect(found.item.creditsStatus).toBe('FETCHED');
  });

  it('searches by title and artist, with the album only as a hint', async () => {
    const api = new FakeApi([]);

    const found = await enrichSong(api, song({ title: 'Good Luck, Babe! (feat. Nobody)', album: 'Good Luck, Babe! - Single' }));

    // Nothing under that artist's name, so the title is tried on its own before giving up.
    expect(api.queries).toEqual([
      '+recording:"Good Luck, Babe!" +artist:"Chappell Roan" release:"Good Luck, Babe!"',
      '+recording:"Good Luck, Babe!" release:"Good Luck, Babe!"',
    ]);
    expect(found.item.matchStatus).toBe('UNMATCHED');
    expect(found.credits).toEqual([]);
    expect(needsLookup(found.item)).toBe(false);
  });

  it('finds a song whose artist the library names differently from the record', async () => {
    const onRecord: MbRecording = {
      id: 'daoxiang',
      title: '稻香',
      length: 223_000,
      'artist-credit': [{ name: '周杰倫', artist: { id: 'jay', name: '周杰倫', aliases: [{ name: '周杰伦' }, { name: 'Jay Chou' }] } }],
      relations: [producer],
    };
    const cover: MbRecording = { id: 'cover', title: '稻香', length: 223_000, 'artist-credit': [{ name: '郁可唯', artist: { id: 'yu', name: '郁可唯' } }] };
    const api = new FakeApi([cover, onRecord], false);

    const found = await enrichSong(api, song({ title: '稻香', artist: 'Jay Chou', album: '魔杰座', durationMs: 223_000 }));

    expect(api.queries).toEqual(['+recording:"稻香" +artist:"Jay Chou" release:"魔杰座"', '+recording:"稻香" release:"魔杰座"']);
    expect(found.item.matchStatus).toBe('MATCHED');
    expect(found.item.recordingMbid).toBe('daoxiang');
    expect(found.item.matchedArtist).toBe('周杰倫');
  });

  it('does not take a same-titled song by someone else when the title is all that was found', async () => {
    const cover: MbRecording = { id: 'cover', title: '稻香', length: 223_000, 'artist-credit': [{ name: '郁可唯', artist: { id: 'yu', name: '郁可唯' } }] };
    const api = new FakeApi([cover], false);

    const found = await enrichSong(api, song({ title: '稻香', artist: 'Jay Chou', durationMs: 223_000 }));

    // Not even offered for review: there would be one of these for every song MusicBrainz lacks.
    expect(found.item.matchStatus).toBe('UNMATCHED');
    expect(found.item.recordingMbid).toBeUndefined();
    expect(api.lookups).toEqual([]);
  });

  it('keeps a doubtful candidate without taking credits from it', async () => {
    const api = new FakeApi([recording('live', { note: 'live, 2024-06-16: Bonnaroo Music Festival', produced: true })]);

    const found = await enrichSong(api, song());

    expect(found.item.matchStatus).toBe('LOW_CONFIDENCE');
    expect(found.item.recordingMbid).toBe('live');
    expect(api.lookups).toEqual([]);
    expect(found.credits).toEqual([]);
  });

  it('reads the credits of a match the user confirmed without searching again', async () => {
    const api = new FakeApi([recording('live', { produced: true })]);
    const confirmed = song({ matchStatus: 'MATCHED', matchMethod: 'user', recordingMbid: 'live' });

    const found = await enrichSong(api, confirmed);

    expect(api.queries).toEqual([]);
    expect(api.lookups).toEqual(['live']);
    expect(found.item.matchMethod).toBe('user');
    expect(found.item.creditsStatus).toBe('FETCHED');
  });

  it('records an error answer as a failed lookup and keeps what was stored', async () => {
    const api: MusicBrainzApi = {
      searchRecordings: async () => {
        throw new HttpError(500);
      },
      recording: async () => recording('unused'),
    };

    const found = await enrichSong(api, song());

    expect(found.item.matchStatus).toBe('FAILED');
    expect(found.item.lastError).toBe('MusicBrainz returned HTTP 500');
    expect(found.replaceCredits).toBe(false);
    // A failure is an answer: the song is not asked about again until the user says so.
    expect(needsLookup(found.item)).toBe(false);
  });

  it('lets being offline through, because it says nothing about the song', async () => {
    const api: MusicBrainzApi = {
      searchRecordings: async () => {
        throw new NetworkError('offline');
      },
      recording: async () => recording('unused'),
    };
    await expect(enrichSong(api, song())).rejects.toBeInstanceOf(NetworkError);
  });
});
