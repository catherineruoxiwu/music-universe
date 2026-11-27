import type { AnalysisData } from '../model/data';
import { GRAPHED, ROLES, bit, isGraphed, ordinal, type Role } from '../model/types';
import { GraphEdge, GraphNode, UniverseGraph } from './graph';

const MIN_RADIUS = 9;
const MAX_RADIUS = 46;

/**
 * Projects credits onto a people graph.
 *
 * Projection rule: within one library item, each credited **artist** is linked to every other
 * creator credited on that item, and co-credited artists are linked to each other. Contributors
 * are not linked to one another directly (a song's producer and its session guitarist are joined
 * through the artist they both worked for). Linking every pair would turn each song into a dense
 * clique and bury the structure the map exists to show.
 *
 * Nothing is inferred: no edge from shared genre, and none between creators who appear on
 * different songs of the same album.
 */
export function buildGraph(data: AnalysisData): UniverseGraph {
  // Only confidently matched items in the analysis set may contribute evidence.
  const items = data.analysedItems.filter((item) => item.matchStatus === 'MATCHED');

  interface NodeAcc {
    items: Set<string>;
    perRole: Set<string>[];
  }
  interface EdgeAcc {
    a: string;
    b: string;
    items: Set<string>;
    roleMask: number;
  }
  const nodeAcc = new Map<string, NodeAcc>();
  const edgeAcc = new Map<string, EdgeAcc>();

  // Works that put at least one person on the map. Works without usable credits are in the
  // library and in Coverage, but the map's own totals must not claim them.
  let songs = 0;
  let albums = 0;

  for (const item of items) {
    const credits = (data.creditsByItem.get(item.id) ?? []).filter(
      (c) => isGraphed(c.role) && data.creators.has(c.creatorId),
    );
    if (credits.length === 0) continue;
    if (item.kind === 'SONG') songs++;
    else albums++;

    // creator -> roles held on this item
    const rolesOnItem = new Map<string, number>();
    for (const c of credits) rolesOnItem.set(c.creatorId, (rolesOnItem.get(c.creatorId) ?? 0) | bit(c.role));

    for (const [creator, mask] of rolesOnItem) {
      let acc = nodeAcc.get(creator);
      if (!acc) {
        acc = { items: new Set(), perRole: ROLES.map(() => new Set<string>()) };
        nodeAcc.set(creator, acc);
      }
      acc.items.add(item.id);
      for (const role of GRAPHED) if (mask & bit(role)) acc.perRole[ordinal(role)].add(item.id);
    }

    for (const [artist, artistMask] of rolesOnItem) {
      if (!(artistMask & bit('ARTIST'))) continue;
      for (const [other, otherMask] of rolesOnItem) {
        if (other === artist) continue;
        const key = artist < other ? `${artist}|${other}` : `${other}|${artist}`;
        let acc = edgeAcc.get(key);
        if (!acc) {
          acc = { a: artist, b: other, items: new Set(), roleMask: 0 };
          edgeAcc.set(key, acc);
        }
        acc.items.add(item.id);
        // The link exists because of what the *other* party did for this artist.
        acc.roleMask |= otherMask;
      }
    }
  }

  // Stable node order (by id) keeps indices, and therefore layouts, reproducible.
  const sortedIds = [...nodeAcc.keys()].sort();
  const indexOf = new Map(sortedIds.map((id, index) => [id, index]));

  const nodes = sortedIds.map((id, index) => {
    const acc = nodeAcc.get(id)!;
    const creator = data.creators.get(id)!;
    const counts = acc.perRole.map((set) => set.size);
    let mask = 0;
    for (const role of GRAPHED) if (counts[ordinal(role)] > 0) mask |= bit(role);
    // Ties resolve in the standard order: Artist, Producer, Songwriter, Musician.
    let primary: Role = 'ARTIST';
    let best = -Infinity;
    for (const role of GRAPHED) {
      const score = counts[ordinal(role)] * 10 - ordinal(role);
      if (score > best) {
        best = score;
        primary = role;
      }
    }
    const itemIds = [...acc.items];
    return new GraphNode(
      index,
      id,
      creator.name,
      creator.type,
      mask,
      counts,
      itemIds,
      itemIds.filter((itemId) => data.itemsById.get(itemId)?.kind === 'SONG').length,
      itemIds.filter((itemId) => data.itemsById.get(itemId)?.kind === 'ALBUM').length,
      primary,
      Math.min(MIN_RADIUS + 5.5 * Math.sqrt(itemIds.length - 1), MAX_RADIUS),
    );
  });

  const edges = [...edgeAcc.values()]
    .map((acc) => {
      const i = indexOf.get(acc.a)!;
      const j = indexOf.get(acc.b)!;
      return { a: Math.min(i, j), b: Math.max(i, j), acc };
    })
    .sort((x, y) => x.a - y.a || x.b - y.b)
    .map(({ a, b, acc }, index) => new GraphEdge(index, a, b, [...acc.items], acc.roleMask));

  const graph = new UniverseGraph(nodes, edges, {
    songs,
    albums,
    artists: nodes.filter((node) => node.hasRole('ARTIST')).length,
    creators: nodes.length,
    connections: edges.length,
  });
  assignCommunities(graph);
  return graph;
}

/**
 * Groups nodes into communities by weighted label propagation, so the far zoom level can show
 * neighbourhoods instead of hundreds of dots. Deterministic: fixed visiting order, ties go to the
 * lowest label.
 */
function assignCommunities(graph: UniverseGraph): void {
  const n = graph.nodes.length;
  if (n === 0) return;
  const label = graph.nodes.map((node) => node.index);
  const tally = new Map<number, number>();
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const i of graph.nodesByWeight) {
      const edges = graph.adjacency[i];
      if (edges.length === 0) continue;
      tally.clear();
      for (const e of edges) {
        const edge = graph.edges[e];
        const l = label[edge.other(i)];
        tally.set(l, (tally.get(l) ?? 0) + edge.weight);
      }
      let best = label[i];
      let bestScore = tally.get(best) ?? 0;
      for (const [l, score] of tally) {
        if (score > bestScore || (score === bestScore && l < best)) {
          best = l;
          bestScore = score;
        }
      }
      if (best !== label[i]) {
        label[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Renumber so community 0 is the largest.
  const sizes = new Map<number, number>();
  for (const l of label) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  const rank = new Map(
    [...sizes.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([l], index) => [l, index]),
  );
  for (const node of graph.nodes) node.community = rank.get(label[node.index])!;
}
