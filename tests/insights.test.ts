import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/builder';
import { computeInsights } from '../src/insights/engine';
import type { AnalysisData } from '../src/model/data';
import { ordinal, type GenreTag } from '../src/model/types';
import { credit, demoData, item, library } from './fixtures';

const insightsOf = (data: AnalysisData) => computeInsights(data, buildGraph(data));

describe('coverage', () => {
  it('matches what the Android app reports for the demo library', () => {
    const { coverage } = insightsOf(demoData());
    expect(coverage).toMatchObject({ total: 111, matched: 111, creditsQueried: 111, withRoleData: 95, excluded: 0 });
    expect(coverage.itemsWithRole[ordinal('PRODUCER')]).toBe(79);
    expect(coverage.itemsWithRole[ordinal('SONGWRITER')]).toBe(87);
    expect(coverage.itemsWithRole[ordinal('MUSICIAN')]).toBe(57);
  });

  it('leaves excluded works out of every count and says how many there are', () => {
    const { coverage } = insightsOf(demoData(['s001', 's002']));
    expect(coverage.total).toBe(109);
    expect(coverage.excluded).toBe(2);
  });

  it('tells a missing credit apart from a failed or pending lookup', () => {
    const { coverage } = insightsOf(
      library(
        [
          item('credited'),
          item('bare', { credits: 'EMPTY' }),
          item('doubtful', { match: 'LOW_CONFIDENCE', credits: 'NOT_QUERIED' }),
          item('unknown', { match: 'UNMATCHED', credits: 'NOT_QUERIED' }),
          item('broken', { match: 'FAILED', credits: 'NOT_QUERIED' }),
          item('queued', { match: 'PENDING', credits: 'NOT_QUERIED' }),
        ],
        [credit('credited', 'Band', 'ARTIST'), credit('credited', 'Producer', 'PRODUCER')],
      ),
    );
    expect(coverage).toMatchObject({
      total: 6,
      matched: 2,
      creditsQueried: 2,
      withRoleData: 1,
      needsReview: 1,
      unmatched: 1,
      failed: 1,
      waiting: 1,
    });
  });
});

describe('top creators', () => {
  it('ranks by distinct works, not by number of credit lines', () => {
    const data = library(
      [item('a'), item('b')],
      [
        credit('a', 'Band', 'ARTIST'),
        credit('a', 'Busy', 'PRODUCER', 'producer'),
        credit('a', 'Busy', 'PRODUCER', 'co-producer'),
        credit('a', 'Busy', 'PRODUCER', 'executive producer'),
        credit('a', 'Steady', 'PRODUCER'),
        credit('b', 'Band', 'ARTIST'),
        credit('b', 'Steady', 'PRODUCER'),
      ],
    );
    const top = insightsOf(data).topByRole.PRODUCER;
    expect(top.map((r) => [r.name, r.count])).toEqual([
      ['Steady', 2],
      ['Busy', 1],
    ]);
  });

  it('never ranks the roles the map does not draw', () => {
    expect(insightsOf(demoData()).topByRole.OTHER).toEqual([]);
  });
});

describe('genres', () => {
  const tag = (itemId: string, genre: string, level: GenreTag['level'], votes = 1): GenreTag => ({ itemId, genre, level, votes });

  it('uses the most specific level and flags what is borrowed from the artist', () => {
    const data = library(
      [item('own'), item('borrowed'), item('untagged')],
      [credit('own', 'Band', 'ARTIST')],
      [
        tag('own', 'shoegaze', 'RECORDING'),
        tag('own', 'rock', 'ARTIST', 9),
        tag('borrowed', 'rock', 'ARTIST'),
      ],
    );
    const { genres } = insightsOf(data);
    expect(genres).toMatchObject({ total: 3, known: 2, unknown: 1, inferred: 1 });
    expect(genres.slices).toEqual([
      { label: 'rock', count: 1 },
      { label: 'shoegaze', count: 1 },
    ]);
  });

  it('accounts for every work in the demo library as known or unknown', () => {
    const { genres, decades } = insightsOf(demoData());
    expect(genres.known + genres.unknown).toBe(111);
    expect(decades.known + decades.unknown).toBe(111);
    expect(decades.slices.reduce((sum, s) => sum + s.count, 0)).toBe(decades.known);
  });
});

describe('hidden connections', () => {
  const data = library(
    [item('one'), item('two'), item('three'), item('duet')],
    [
      credit('one', 'Band A', 'ARTIST'),
      credit('one', 'Producer', 'PRODUCER'),
      credit('two', 'Band B', 'ARTIST'),
      credit('two', 'Producer', 'PRODUCER'),
      credit('three', 'Band A', 'ARTIST'),
      credit('three', 'Local', 'PRODUCER'),
      credit('duet', 'Band A', 'ARTIST'),
      credit('duet', 'Band B', 'ARTIST'),
    ],
  );
  const insights = insightsOf(data);

  it('finds someone who worked behind the scenes for two artists, with the works as evidence', () => {
    expect(insights.sharedCreators).toHaveLength(1);
    expect(insights.sharedCreators[0]).toMatchObject({
      name: 'Producer',
      role: 'PRODUCER',
      artistNames: ['Band A', 'Band B'],
      itemIds: ['one', 'two'],
    });
  });

  it('does not count someone who only worked for one artist', () => {
    expect(insights.sharedCreators.map((s) => s.name)).not.toContain('Local');
  });

  it('lists artists billed together only for the works they share billing on', () => {
    expect(insights.collaborations).toHaveLength(1);
    expect(insights.collaborations[0].itemIds).toEqual(['duet']);
  });

  it('backs every claim about the demo library with at least one work', () => {
    const demoInsights = insightsOf(demoData());
    expect(demoInsights.sharedCreators.length).toBeGreaterThan(0);
    for (const shared of demoInsights.sharedCreators) {
      expect(shared.artistNames.length).toBeGreaterThanOrEqual(2);
      expect(shared.itemIds.length).toBeGreaterThanOrEqual(2);
    }
  });
});
