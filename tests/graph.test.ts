import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/builder';
import { GraphVisibility, linkedWorks, type UniverseGraph } from '../src/graph/graph';
import { credit, demoData, item, library } from './fixtures';

function names(graph: UniverseGraph): string[] {
  return graph.nodes.map((node) => node.name).sort();
}

function linked(graph: UniverseGraph, a: string, b: string): boolean {
  return graph.edgeBetween(graph.indexOf(a), graph.indexOf(b)) >= 0;
}

describe('projection of credits onto people', () => {
  const data = library(
    [item('song')],
    [
      credit('song', 'Band', 'ARTIST'),
      credit('song', 'Producer', 'PRODUCER'),
      credit('song', 'Guitarist', 'MUSICIAN', 'guitar'),
      credit('song', 'Engineer', 'OTHER', 'mixing'),
    ],
  );
  const graph = buildGraph(data);

  it('links the artist to everyone credited on the work', () => {
    expect(linked(graph, 'Band', 'Producer')).toBe(true);
    expect(linked(graph, 'Band', 'Guitarist')).toBe(true);
  });

  it('does not link contributors to each other directly', () => {
    expect(linked(graph, 'Producer', 'Guitarist')).toBe(false);
    expect(graph.edges).toHaveLength(2);
  });

  it('keeps engineering and similar credits off the map', () => {
    expect(names(graph)).toEqual(['Band', 'Guitarist', 'Producer']);
  });

  it('links artists billed together', () => {
    const duet = buildGraph(library([item('duet')], [credit('duet', 'A', 'ARTIST'), credit('duet', 'B', 'ARTIST')]));
    expect(linked(duet, 'A', 'B')).toBe(true);
    expect(duet.edges).toHaveLength(1);
  });
});

describe('what counts as evidence', () => {
  const credits = [
    credit('one', 'Band', 'ARTIST'),
    credit('one', 'Producer', 'PRODUCER'),
    credit('two', 'Band', 'ARTIST'),
    credit('two', 'Producer', 'PRODUCER'),
    credit('two', 'Writer', 'SONGWRITER'),
  ];

  it('records every work behind a connection', () => {
    const graph = buildGraph(library([item('one'), item('two')], credits));
    const edge = graph.edges[graph.edgeBetween(graph.indexOf('Band'), graph.indexOf('Producer'))];
    expect(edge.itemIds.sort()).toEqual(['one', 'two']);
    expect(edge.weight).toBe(2);
  });

  it('ignores works the user excluded', () => {
    const graph = buildGraph(library([item('one'), item('two', { included: false })], credits));
    expect(names(graph)).toEqual(['Band', 'Producer']);
    expect(graph.edges[0].itemIds).toEqual(['one']);
    expect(graph.stats.songs).toBe(1);
  });

  it('draws nothing from a match that is not trusted', () => {
    const graph = buildGraph(library([item('one'), item('two', { match: 'LOW_CONFIDENCE' })], credits));
    expect(names(graph)).toEqual(['Band', 'Producer']);
  });

  it('does not connect people who only share an album, not a work', () => {
    const graph = buildGraph(
      library(
        [item('track 1'), item('track 2')],
        [
          credit('track 1', 'Band', 'ARTIST'),
          credit('track 1', 'Producer A', 'PRODUCER'),
          credit('track 2', 'Band', 'ARTIST'),
          credit('track 2', 'Producer B', 'PRODUCER'),
        ],
      ),
    );
    expect(linked(graph, 'Producer A', 'Producer B')).toBe(false);
  });

  it('counts only works that put someone on the map', () => {
    const graph = buildGraph(
      library([item('credited'), item('bare', { credits: 'EMPTY' }), item('album', { kind: 'ALBUM' })], [
        credit('credited', 'Band', 'ARTIST'),
        credit('album', 'Band', 'ARTIST'),
      ]),
    );
    expect(graph.stats).toMatchObject({ songs: 1, albums: 1, artists: 1, creators: 1 });
  });
});

describe('one person, several roles', () => {
  const graph = buildGraph(
    library(
      [item('a'), item('b'), item('c')],
      [
        credit('a', 'Solo', 'ARTIST'),
        credit('a', 'Solo', 'PRODUCER'),
        credit('a', 'Solo', 'SONGWRITER'),
        credit('b', 'Other', 'ARTIST'),
        credit('b', 'Solo', 'PRODUCER'),
        credit('c', 'Other', 'ARTIST'),
        credit('c', 'Solo', 'PRODUCER'),
      ],
    ),
  );
  const solo = graph.nodes[graph.indexOf('Solo')];

  it('is a single node carrying every role', () => {
    expect(graph.nodes).toHaveLength(2);
    expect(solo.roles).toEqual(['ARTIST', 'PRODUCER', 'SONGWRITER']);
    expect(solo.itemCount).toBe(3);
  });

  it('takes its main role from where most of its credits are', () => {
    expect(solo.primaryRole).toBe('PRODUCER');
  });
});

describe('filters', () => {
  const graph = buildGraph(
    library(
      [item('one'), item('two'), item('three')],
      [
        credit('one', 'Band', 'ARTIST'),
        credit('one', 'Producer', 'PRODUCER'),
        credit('two', 'Band', 'ARTIST'),
        credit('two', 'Producer', 'PRODUCER'),
        credit('two', 'Writer', 'SONGWRITER'),
        credit('three', 'Loner', 'ARTIST'),
      ],
    ),
  );
  const visibleNames = (visibility: GraphVisibility) =>
    graph.nodes.filter((node) => visibility.nodes[node.index]).map((node) => node.name).sort();

  it('shows everything by default', () => {
    const visibility = GraphVisibility.compute(graph, { role: null, sharedOnly: false });
    expect(visibility.nodeCount).toBe(4);
    expect(visibility.edgeCount).toBe(2);
  });

  it('a role filter keeps that role and the artists they worked for', () => {
    const visibility = GraphVisibility.compute(graph, { role: 'PRODUCER', sharedOnly: false });
    expect(visibleNames(visibility)).toEqual(['Band', 'Producer']);
    expect(linkedWorks(graph, visibility)).toBe(2);
  });

  it('shared only keeps connections backed by two or more works', () => {
    const visibility = GraphVisibility.compute(graph, { role: null, sharedOnly: true });
    expect(visibleNames(visibility)).toEqual(['Band', 'Producer']);
    expect(visibility.edgeCount).toBe(1);
  });

  it('an unconnected artist stays visible unless shared only is on', () => {
    expect(visibleNames(GraphVisibility.compute(graph, { role: 'ARTIST', sharedOnly: false }))).toContain('Loner');
    expect(visibleNames(GraphVisibility.compute(graph, { role: 'ARTIST', sharedOnly: true }))).not.toContain('Loner');
  });
});

describe('the bundled demo library', () => {
  const data = demoData();
  const graph = buildGraph(data);

  it('produces the same totals as the Android app does from the same data', () => {
    expect(data.items).toHaveLength(111);
    expect(graph.stats).toMatchObject({ songs: 99, albums: 12, artists: 44, creators: 328 });
  });

  it('gives every connection at least one work as evidence', () => {
    for (const edge of graph.edges) expect(edge.itemIds.length).toBeGreaterThan(0);
  });

  it('builds the same graph every time', () => {
    const again = buildGraph(demoData());
    expect(again.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(again.edges.map((e) => [e.a, e.b])).toEqual(graph.edges.map((e) => [e.a, e.b]));
    expect(again.nodes.map((n) => n.community)).toEqual(graph.nodes.map((n) => n.community));
  });
});
