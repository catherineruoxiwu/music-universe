import { GRAPHED, bit, roleName, type Role } from '../model/types';

/** One person or group. A creator is a single node no matter how many roles they hold. */
export class GraphNode {
  community = 0;

  /** The graphed roles this creator holds, in the standard order. */
  readonly roles: Role[];
  /** "Producer · Songwriter" */
  readonly roleLine: string;
  /** The name as drawn on the map, shortened if very long. */
  readonly label: string;

  constructor(
    readonly index: number,
    readonly id: string,
    readonly name: string,
    /** MusicBrainz artist type, e.g. "Person" or "Group". */
    readonly type: string | undefined,
    /** Bit set of every graphed role this creator holds anywhere in the library. */
    readonly roleMask: number,
    /** Distinct library items per role, indexed by role ordinal. */
    readonly roleItemCounts: number[],
    /** Distinct library items this creator is credited on, in any graphed role. */
    readonly itemIds: string[],
    readonly songCount: number,
    readonly albumCount: number,
    readonly primaryRole: Role,
    /** World-space radius; grows with the number of items so prominent creators read as larger. */
    readonly radius: number,
  ) {
    this.roles = GRAPHED.filter((role) => (roleMask & bit(role)) !== 0);
    this.roleLine = this.roles.map(roleName).join(' · ');
    this.label = name.length <= MAX_LABEL ? name : name.slice(0, MAX_LABEL - 1).trimEnd() + '…';
  }

  get itemCount(): number {
    return this.itemIds.length;
  }

  hasRole(role: Role): boolean {
    return (this.roleMask & bit(role)) !== 0;
  }
}

const MAX_LABEL = 26;

/**
 * Two creators credited on the same library item(s). `itemIds` is the evidence: every edge can be
 * traced back to the works that justify it, and an edge with no such work is never created.
 */
export class GraphEdge {
  constructor(
    readonly index: number,
    readonly a: number,
    readonly b: number,
    readonly itemIds: string[],
    /** Roles through which the two are linked; drives the role filter. */
    readonly roleMask: number,
  ) {}

  get weight(): number {
    return this.itemIds.length;
  }

  other(node: number): number {
    return node === this.a ? this.b : this.a;
  }
}

/** Totals for the whole graph. `songs` and `albums` count only works with credits on the map. */
export interface GraphStats {
  songs: number;
  albums: number;
  artists: number;
  creators: number;
  connections: number;
}

export class UniverseGraph {
  /** Edge indices touching each node. */
  readonly adjacency: number[][];
  /** Node indices, most-credited first. Label placement and far-zoom rendering use this order. */
  readonly nodesByWeight: number[];
  private readonly indexById: Map<string, number>;

  constructor(
    readonly nodes: GraphNode[],
    readonly edges: GraphEdge[],
    readonly stats: GraphStats,
  ) {
    this.adjacency = nodes.map(() => []);
    for (const e of edges) {
      this.adjacency[e.a].push(e.index);
      this.adjacency[e.b].push(e.index);
    }
    this.nodesByWeight = nodes
      .map((node) => node.index)
      .sort(
        (x, y) =>
          nodes[y].itemCount - nodes[x].itemCount ||
          this.adjacency[y].length - this.adjacency[x].length ||
          compareText(nodes[x].name, nodes[y].name),
      );
    this.indexById = new Map(nodes.map((node) => [node.id, node.index]));
  }

  indexOf(creatorId: string): number {
    return this.indexById.get(creatorId) ?? -1;
  }

  degree(node: number): number {
    return this.adjacency[node].length;
  }

  /** The edge joining two nodes, or -1. */
  edgeBetween(a: number, b: number): number {
    if (a < 0 || b < 0) return -1;
    for (const e of this.adjacency[a]) if (this.edges[e].other(a) === b) return e;
    return -1;
  }

  static readonly EMPTY = new UniverseGraph([], [], { songs: 0, albums: 0, artists: 0, creators: 0, connections: 0 });
}

/** Plain code-unit ordering: the same on every machine, unlike locale-aware comparison. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What the user asked to see. Changing this never moves a node; it only hides some. */
export interface GraphFilter {
  /** Null shows every role. */
  role: Role | null;
  /** Keep only connections backed by two or more library items. */
  sharedOnly: boolean;
}

export const NO_FILTER: GraphFilter = { role: null, sharedOnly: false };

export const isDefaultFilter = (filter: GraphFilter): boolean => filter.role === null && !filter.sharedOnly;

export class GraphVisibility {
  readonly nodeCount: number;
  readonly edgeCount: number;

  private constructor(
    readonly nodes: boolean[],
    readonly edges: boolean[],
  ) {
    this.nodeCount = nodes.filter(Boolean).length;
    this.edgeCount = edges.filter(Boolean).length;
  }

  static compute(graph: UniverseGraph, filter: GraphFilter): GraphVisibility {
    const edgeVisible = graph.edges.map(() => false);
    const nodeVisible = graph.nodes.map(() => false);
    for (const e of graph.edges) {
      const roleOk = filter.role === null || (e.roleMask & bit(filter.role)) !== 0;
      const sharedOk = !filter.sharedOnly || e.weight >= 2;
      if (roleOk && sharedOk) {
        edgeVisible[e.index] = true;
        nodeVisible[e.a] = true;
        nodeVisible[e.b] = true;
      }
    }
    // Without "shared only", creators holding the chosen role stay visible even when
    // unconnected: they are still part of the library.
    if (!filter.sharedOnly) {
      for (const n of graph.nodes) {
        if (filter.role === null || n.hasRole(filter.role)) nodeVisible[n.index] = true;
      }
    }
    return new GraphVisibility(nodeVisible, edgeVisible);
  }
}

/** The works behind the connections a filter shows. */
export function linkedWorks(graph: UniverseGraph, visibility: GraphVisibility): number {
  const ids = new Set<string>();
  for (const e of graph.edges) if (visibility.edges[e.index]) for (const id of e.itemIds) ids.add(id);
  return ids.size;
}
