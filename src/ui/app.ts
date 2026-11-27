import type { Selection } from '../graph/universeView';
import type { Store } from '../state/store';

/** Where the user is. Every screen is reachable by its address, so links and Back work. */
export type Route =
  | { page: 'universe'; focus: Selection }
  | { page: 'library' }
  | { page: 'insights' }
  | { page: 'share' }
  | { page: 'about' }
  | { page: 'work'; id: string }
  | { page: 'creator'; id: string };

/** What every screen is handed. */
export interface App {
  store: Store;
  /** Goes to an address such as "#/library". */
  navigate(hash: string): void;
  /** Goes back one screen, or to `fallback` when this is the first screen of the visit. */
  back(fallback: string): void;
  /** Lays the map out from scratch. */
  resetLayout(): void;
  /** Undoes everything the visitor changed: exclusions, nickname, filter and layout. */
  clearLocalData(): void;
}

/** A screen shown in the reading column. */
export interface Page {
  element: HTMLElement;
  /** Called when the library, the graph or the filter changed while the page is showing. */
  update?(): void;
}

export const links = {
  universe: '#/',
  library: '#/library',
  insights: '#/insights',
  share: '#/share',
  about: '#/about',
  work: (id: string) => `#/work/${encodeURIComponent(id)}`,
  creator: (id: string) => `#/creator/${encodeURIComponent(id)}`,
  /** The map, moved to and spotlighting something. */
  showCreator: (id: string) => `#/?creator=${encodeURIComponent(id)}`,
  showEdge: (a: string, b: string) => `#/?edge=${encodeURIComponent(a)}~${encodeURIComponent(b)}`,
  showWork: (id: string) => `#/?work=${encodeURIComponent(id)}`,
};

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [page, id] = path.split('/').map(decodeURIComponent);
  switch (page) {
    case 'library':
    case 'insights':
    case 'share':
    case 'about':
      return { page };
    case 'work':
    case 'creator':
      if (id) return { page, id };
      break;
  }
  const params = new URLSearchParams(query);
  const [a, b] = (params.get('edge') ?? '').split('~');
  const focus: Selection = params.get('creator')
    ? { kind: 'creator', id: params.get('creator')! }
    : a && b
      ? { kind: 'edge', a, b }
      : params.get('work')
        ? { kind: 'work', id: params.get('work')! }
        : null;
  return { page: 'universe', focus };
}
