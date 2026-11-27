import { compareText, type GraphNode, type UniverseGraph } from '../graph/graph';
import { groupBy, type AnalysisData } from '../model/data';
import { GENRE_LEVELS, GRAPHED, ROLES, isGraphed, isInferred, ordinal, type Role } from '../model/types';

/** How much of the library the rest of the numbers rest on. All counts are library items. */
export interface Coverage {
  /** Items in the analysis set: the ones the user kept in. */
  total: number;
  matched: number;
  needsReview: number;
  unmatched: number;
  failed: number;
  waiting: number;
  /** Matched items whose credits lookup finished, whether or not it found anything. */
  creditsQueried: number;
  /** Items with at least one credit. */
  withRoleData: number;
  /** Items with at least one credit in each role, indexed by role ordinal. */
  itemsWithRole: number[];
  excluded: number;
}

/** One creator's place in a per-role ranking. `count` is distinct library items, never plays. */
export interface Ranked {
  creatorId: string;
  name: string;
  count: number;
}

export interface Slice {
  label: string;
  count: number;
}

/**
 * A multi-label breakdown. `known` + `unknown` = `total`; slices may sum to more than `known`
 * when one item carries several labels.
 */
export interface Distribution {
  slices: Slice[];
  total: number;
  known: number;
  unknown: number;
  /** Of `known`, how many rest on a fallback (artist-level genres) rather than the work itself. */
  inferred: number;
}

/** A behind-the-scenes creator who worked for several of the artists in the library. */
export interface SharedCreator {
  creatorId: string;
  name: string;
  role: Role;
  artistNames: string[];
  /** The works that justify the claim. */
  itemIds: string[];
}

/** Two artists credited together on the same work. */
export interface Collaboration {
  firstId: string;
  firstName: string;
  secondId: string;
  secondName: string;
  itemIds: string[];
}

export interface Insights {
  coverage: Coverage;
  /** Only graphed roles are filled. */
  topByRole: Record<Role, Ranked[]>;
  genres: Distribution;
  decades: Distribution;
  sharedCreators: SharedCreator[];
  collaborations: Collaboration[];
}

export const TOP_N = 8;
const MAX_GENRES = 10;
const GENRES_PER_ITEM = 3;
const MAX_HIDDEN = 12;

const lower = (text: string) => text.toLowerCase();

/**
 * Derives every statistic from the same data and graph the map is drawn from, so Insights can
 * never disagree with the Universe.
 */
export function computeInsights(data: AnalysisData, graph: UniverseGraph): Insights {
  return {
    coverage: coverage(data),
    topByRole: Object.fromEntries(ROLES.map((role) => [role, isGraphed(role) ? top(graph, role) : []])) as Record<
      Role,
      Ranked[]
    >,
    genres: genres(data),
    decades: decades(data),
    sharedCreators: sharedCreators(data, graph),
    collaborations: collaborations(data, graph),
  };
}

function coverage(data: AnalysisData): Coverage {
  const result: Coverage = {
    total: data.analysedItems.length,
    matched: 0,
    needsReview: 0,
    unmatched: 0,
    failed: 0,
    waiting: 0,
    creditsQueried: 0,
    withRoleData: 0,
    itemsWithRole: ROLES.map(() => 0),
    excluded: data.items.length - data.analysedItems.length,
  };
  for (const item of data.analysedItems) {
    switch (item.matchStatus) {
      case 'MATCHED': {
        result.matched++;
        if (item.creditsStatus === 'FETCHED') {
          result.creditsQueried++;
          result.withRoleData++;
        } else if (item.creditsStatus === 'EMPTY') {
          result.creditsQueried++;
        } else if (item.creditsStatus === 'FAILED') {
          result.failed++;
        } else {
          result.waiting++;
        }
        const held = new Set((data.creditsByItem.get(item.id) ?? []).map((c) => c.role));
        for (const role of held) result.itemsWithRole[ordinal(role)]++;
        break;
      }
      case 'LOW_CONFIDENCE':
        result.needsReview++;
        break;
      case 'UNMATCHED':
        result.unmatched++;
        break;
      case 'FAILED':
        result.failed++;
        break;
      case 'PENDING':
        result.waiting++;
        break;
    }
  }
  return result;
}

function top(graph: UniverseGraph, role: Role): Ranked[] {
  const count = (node: GraphNode) => node.roleItemCounts[ordinal(role)];
  return graph.nodes
    .filter((node) => count(node) > 0)
    .sort((a, b) => count(b) - count(a) || compareText(lower(a.name), lower(b.name)))
    .slice(0, TOP_N)
    .map((node) => ({ creatorId: node.id, name: node.name, count: count(node) }));
}

/**
 * Each item contributes the genres from the most specific level that has any: the recording, then
 * its release group, then the source's own tags, and only then the artist. Artist-level genres
 * describe the artist rather than this work, so those items are counted as inferred.
 */
function genres(data: AnalysisData): Distribution {
  const byItem = groupBy(data.genres, (g) => g.itemId);
  const counts = new Map<string, number>();
  let known = 0;
  let inferred = 0;
  for (const item of data.analysedItems) {
    const all = byItem.get(item.id) ?? [];
    const level = GENRE_LEVELS.find((l) => all.some((g) => g.level === l));
    if (!level) continue;
    known++;
    if (isInferred(level)) inferred++;
    const chosen = all
      .filter((g) => g.level === level)
      .sort((a, b) => b.votes - a.votes || compareText(a.genre, b.genre))
      .slice(0, GENRES_PER_ITEM)
      .map((g) => g.genre);
    for (const genre of new Set(chosen)) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  const slices = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, MAX_GENRES)
    .map(([label, count]) => ({ label, count }));
  const total = data.analysedItems.length;
  return { slices, total, known, unknown: total - known, inferred };
}

function decades(data: AnalysisData): Distribution {
  const counts = new Map<number, number>();
  let known = 0;
  for (const item of data.analysedItems) {
    if (item.year === undefined) continue;
    known++;
    const decade = Math.floor(item.year / 10) * 10;
    counts.set(decade, (counts.get(decade) ?? 0) + 1);
  }
  const slices = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([decade, count]) => ({ label: `${decade}s`, count }));
  const total = data.analysedItems.length;
  return { slices, total, known, unknown: total - known, inferred: 0 };
}

/**
 * Creators who were not the credited artist, yet worked on items by two or more different
 * artists. Uses graph edges, so every entry is backed by the same evidence the map shows.
 */
function sharedCreators(data: AnalysisData, graph: UniverseGraph): SharedCreator[] {
  const found: SharedCreator[] = [];
  for (const node of graph.nodes) {
    const artists: string[] = [];
    const items = new Set<string>();
    for (const e of graph.adjacency[node.index]) {
      const edge = graph.edges[e];
      const other = graph.nodes[edge.other(node.index)];
      if (!other.hasRole('ARTIST')) continue;
      // Keep only works where this creator contributed without being the billed artist.
      const behind = edge.itemIds.filter((itemId) => {
        const mine = (data.creditsByItem.get(itemId) ?? []).filter((c) => c.creatorId === node.id);
        return mine.some((c) => isGraphed(c.role) && c.role !== 'ARTIST') && !mine.some((c) => c.role === 'ARTIST');
      });
      if (behind.length === 0) continue;
      artists.push(other.name);
      for (const id of behind) items.add(id);
    }
    if (artists.length < 2) continue;
    let role: Role | null = null;
    for (const candidate of GRAPHED) {
      if (candidate === 'ARTIST') continue;
      if (role === null || node.roleItemCounts[ordinal(candidate)] > node.roleItemCounts[ordinal(role)]) role = candidate;
    }
    if (role === null) continue;
    found.push({
      creatorId: node.id,
      name: node.name,
      role,
      artistNames: artists.sort((a, b) => compareText(lower(a), lower(b))),
      itemIds: [...items],
    });
  }
  return found
    .sort(
      (a, b) =>
        b.artistNames.length - a.artistNames.length ||
        b.itemIds.length - a.itemIds.length ||
        compareText(lower(a.name), lower(b.name)),
    )
    .slice(0, MAX_HIDDEN);
}

/** Pairs of artists billed together, with only the works on which both are billed as artist. */
function collaborations(data: AnalysisData, graph: UniverseGraph): Collaboration[] {
  const billed = (itemId: string, creatorId: string) =>
    (data.creditsByItem.get(itemId) ?? []).some((c) => c.creatorId === creatorId && c.role === 'ARTIST');

  const found: Collaboration[] = [];
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    const together = edge.itemIds.filter((id) => billed(id, a.id) && billed(id, b.id));
    if (together.length === 0) continue;
    found.push({ firstId: a.id, firstName: a.name, secondId: b.id, secondName: b.name, itemIds: together });
  }
  return found
    .sort((a, b) => b.itemIds.length - a.itemIds.length || compareText(lower(a.firstName), lower(b.firstName)))
    .slice(0, MAX_HIDDEN);
}
