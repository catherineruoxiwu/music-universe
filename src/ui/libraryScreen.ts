import { compareText } from '../graph/graph';
import type { LibraryItem } from '../model/types';
import { links, type App, type Page } from './app';
import { needsLookup } from '../enrich/enricher';
import { describeProgress, initialOf, libraryPhrase, matchStatus, plural, row, workRow, works } from './describe';
import { chip, h, icon, openMenu, setChildren, toast } from './dom';

type Tab = 'songs' | 'albums' | 'artists';
type Sort = 'title' | 'artist' | 'year' | 'recent';

const STATUSES = {
  all: { label: 'Any status', accepts: (_: LibraryItem) => true },
  matched: { label: 'Matched', accepts: (item: LibraryItem) => item.matchStatus === 'MATCHED' && item.creditsStatus === 'FETCHED' },
  noCredits: { label: 'No credits listed', accepts: (item: LibraryItem) => item.matchStatus === 'MATCHED' && item.creditsStatus === 'EMPTY' },
  review: { label: 'Needs review', accepts: (item: LibraryItem) => item.matchStatus === 'LOW_CONFIDENCE' },
  unmatched: { label: 'Not matched', accepts: (item: LibraryItem) => item.matchStatus === 'UNMATCHED' },
  failed: { label: 'Lookup failed', accepts: (item: LibraryItem) => item.matchStatus === 'FAILED' || (item.matchStatus === 'MATCHED' && item.creditsStatus === 'FAILED') },
  waiting: { label: 'Waiting', accepts: needsLookup },
  excluded: { label: 'Excluded', accepts: (item: LibraryItem) => !item.included },
} as const;
export type Status = keyof typeof STATUSES;

/** A long library is listed a part at a time; drawing thousands of rows at once makes the page crawl. */
const PAGE_SIZE = 200;

interface Query {
  tab: Tab;
  text: string;
  sort: Sort;
  status: Status;
  /** First year of the chosen decade (e.g. 2010), or null for any. */
  decade: number | null;
  /** Set when one artist has been opened from the Artists tab. */
  artist: string | null;
}

// Kept for the visit, so that coming back from a work finds the list as it was left.
const query: Query = { tab: 'songs', text: '', sort: 'title', status: 'all', decade: null, artist: null };

/** Opens the Library's songs narrowed to one status. */
export function showLibraryStatus(app: App, status: Status): void {
  Object.assign(query, { tab: 'songs', text: '', status, decade: null, artist: null });
  app.navigate(links.library);
}

const lower = (text: string) => text.toLowerCase();
const decadeOf = (item: LibraryItem) => (item.year === undefined ? null : Math.floor(item.year / 10) * 10);

/** The works in the library: search, sort and filter them, and choose which ones are analysed. */
export function createLibraryPage(app: App): Page {
  const { store } = app;

  const summary = h('p', { class: 'subtitle' });
  const banner = h('div', { class: 'banner' });
  /** How many rows of the current list are drawn. */
  let limit = PAGE_SIZE;
  let shownControls = '';
  let shownRows: unknown[] = [];
  let shownBanner = '';
  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search this library',
    'aria-label': 'Search this library',
    autocomplete: 'off',
    spellcheck: 'false',
    value: query.text,
  });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const controls = h('div', { class: 'list-controls' });
  const list = h('div', { class: 'list', role: 'tabpanel' });

  searchInput.addEventListener('input', () => {
    query.text = searchInput.value;
    limit = PAGE_SIZE;
    renderList();
  });

  const element = h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-header' },
      h('div', { class: 'page-title' }, h('h1', null, 'Library'), summary),
      h('label', { class: 'search-field' }, icon('search'), searchInput),
      tabs,
    ),
    banner,
    controls,
    list,
  );

  function set(change: Partial<Query>): void {
    Object.assign(query, change);
    limit = PAGE_SIZE;
    render();
  }

  /** Says whose library this is and, if one is being imported, how far along it is. */
  function renderBanner(): void {
    const status = store.status;
    const counts = status?.counts;
    const kind = !status
      ? 'demo'
      : store.showing === 'demo'
        ? 'demo-shown'
        : counts!.remaining > 0 || counts!.failed > 0 || counts!.needsReview > 0
          ? 'progress'
          : 'none';
    // Rebuilt only when it says something of a different kind; from one lookup to the next only
    // the words change, and the button beside them stays put so that it can be pressed.
    if (kind !== shownBanner) {
      shownBanner = kind;
      banner.hidden = kind === 'none';
      setChildren(
        banner,
        kind === 'demo'
          ? [h('span', null, 'This is a demo library, not yours.'), h('a', { class: 'button text', href: links.import }, 'Import your own')]
          : kind === 'demo-shown'
            ? [
                h('span', null, 'This is the demo library.'),
                h('button', { class: 'button text', type: 'button', onClick: () => app.showLibrary('mine') }, 'Show yours'),
              ]
            : kind === 'progress'
              ? [h('span', { class: 'banner-progress' }), h('a', { class: 'button text', href: links.import }, 'Details')]
              : null,
      );
    }
    if (kind === 'progress') {
      banner.querySelector('.banner-progress')!.textContent =
        counts!.remaining > 0
          ? describeProgress(status!)
          : [counts!.needsReview > 0 ? `${counts!.needsReview} to review` : null, counts!.failed > 0 ? plural(counts!.failed, 'failed lookup') : null]
              .filter(Boolean)
              .join(' · ');
    }
  }

  function select<T extends string>(label: string, value: T, options: [T, string][], onChange: (value: T) => void): HTMLElement {
    const control = h(
      'select',
      { 'aria-label': label },
      options.map(([key, text]) => h('option', { value: key, selected: key === value }, text)),
    );
    control.addEventListener('change', () => onChange(control.value as T));
    return h('span', { class: `select ${value === options[0][0] ? '' : 'active'}` }, control);
  }

  function render(): void {
    const items = store.snapshot.data.items;
    const excluded = items.filter((item) => !item.included).length;
    summary.textContent =
      `${works(items.filter((i) => i.kind === 'SONG').length, items.filter((i) => i.kind === 'ALBUM').length)} in ${libraryPhrase(store.showing)}` +
      (excluded > 0 ? ` · ${excluded} excluded from analysis` : '');
    renderBanner();

    const tab = (id: Tab, label: string) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(query.tab === id), onClick: () => set({ tab: id, artist: null }) }, label);
    setChildren(tabs, tab('songs', 'Songs'), tab('albums', 'Albums'), tab('artists', 'Artists'));

    const decades = [...new Set(items.map(decadeOf).filter((d) => d !== null))].sort((a, b) => b - a);
    const listsWorks = query.tab !== 'artists' || query.artist !== null;
    // Only the statuses that occur are offered, plus the one in use.
    const statuses = (Object.keys(STATUSES) as Status[]).filter((key) => key === 'all' || key === query.status || items.some(STATUSES[key].accepts));
    const sorts: [Sort, string][] = [['title', 'Sort: Title'], ['artist', 'Sort: Artist'], ['year', 'Sort: Newest']];
    if (query.sort === 'recent' || items.some((item) => item.addedAt !== undefined)) sorts.push(['recent', 'Sort: Recently added']);

    // The controls are rebuilt only when they would come out different, so that a menu the user
    // has open is not closed by a redraw while songs are being looked up.
    const signature = JSON.stringify([query, decades, statuses, sorts.length]);
    if (signature !== shownControls) {
      shownControls = signature;
      setChildren(
        controls,
        query.artist !== null ? chip(`← All artists`, false, () => set({ artist: null })) : null,
        listsWorks ? select<Sort>('Sort by', query.sort, sorts, (sort) => set({ sort })) : null,
        select<Status>(
          'Match status',
          query.status,
          statuses.map((key) => [key, STATUSES[key].label]),
          (status) => set({ status }),
        ),
        decades.length > 0
          ? select<string>(
              'Decade',
              String(query.decade ?? ''),
              [['', 'Any decade'], ...decades.map((d): [string, string] => [String(d), `${d}s`])],
              (decade) => set({ decade: decade === '' ? null : Number(decade) }),
            )
          : null,
      );
    }
    renderList();
  }

  function renderList(): void {
    const items = store.snapshot.data.items;
    const text = lower(query.text.trim());
    const passesFilters = (item: LibraryItem) => STATUSES[query.status].accepts(item) && (query.decade === null || decadeOf(item) === query.decade);
    const filtered = query.status !== 'all' || query.decade !== null;

    if (query.tab === 'artists' && query.artist === null) {
      const groups = new Map<string, LibraryItem[]>();
      for (const item of items.filter(passesFilters)) {
        if (text !== '' && !lower(item.artist).includes(text)) continue;
        const group = groups.get(item.artist);
        if (group) group.push(item);
        else groups.set(item.artist, [item]);
      }
      const names = [...groups.keys()].sort((a, b) => compareText(lower(a), lower(b)));
      shownRows = [];
      setChildren(
        list,
        names.length === 0
          ? nothing(text !== '' || filtered)
          : names.slice(0, limit).map((name) => {
              const of = groups.get(name)!;
              return row({
                title: name,
                subtitle: works(of.filter((i) => i.kind === 'SONG').length, of.filter((i) => i.kind === 'ALBUM').length),
                badge: initialOf(name),
                round: true,
                onClick: () => {
                  searchInput.value = '';
                  set({ artist: name, text: '' });
                },
              });
            }),
        more(names.length),
      );
      return;
    }

    const scoped = items.filter((item) =>
      query.tab === 'artists' ? item.artist === query.artist : item.kind === (query.tab === 'songs' ? 'SONG' : 'ALBUM'),
    );
    const byTitle = (a: LibraryItem, b: LibraryItem) => compareText(lower(a.title), lower(b.title));
    const order: Record<Sort, (a: LibraryItem, b: LibraryItem) => number> = {
      title: byTitle,
      artist: (a, b) => compareText(lower(a.artist), lower(b.artist)) || byTitle(a, b),
      // Unknown years sort last rather than pretending to be year zero.
      year: (a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || byTitle(a, b),
      recent: (a, b) => (b.addedAt ?? -Infinity) - (a.addedAt ?? -Infinity) || byTitle(a, b),
    };
    const matching = scoped
      .filter((item) => passesFilters(item) && (text === '' || [item.title, item.artist, item.album ?? ''].some((field) => lower(field).includes(text))))
      .sort(order[query.sort]);
    const shown = matching.slice(0, limit);
    const onMapIds = new Set<string>();
    for (const node of store.snapshot.graph.nodes) for (const id of node.itemIds) onMapIds.add(id);

    // While songs are being looked up the page is asked to redraw every few seconds. Rows are
    // left alone unless something about them changed, so a press that is under way still lands.
    const rows: unknown[] = [JSON.stringify(query), matching.length, ...shown.flatMap((item) => [item, onMapIds.has(item.id)])];
    if (rows.length === shownRows.length && rows.every((value, i) => value === shownRows[i])) return;
    shownRows = rows;

    setChildren(
      list,
      query.artist !== null ? h('div', { class: 'section-header' }, h('h2', null, query.artist), h('p', null, plural(matching.length, 'work'))) : null,
      shown.length === 0
        ? nothing(text !== '' || filtered)
        : shown.map((item) => {
            const onMap = onMapIds.has(item.id);
            return workRow(item, {
              status: { ...matchStatus(item), showLabel: false },
              onClick: () => app.navigate(links.work(item.id)),
              onMore: (anchor) =>
                openMenu(anchor, [
                  { label: 'View credits', onSelect: () => app.navigate(links.work(item.id)) },
                  ...(onMap ? [{ label: 'View in Universe', onSelect: () => app.navigate(links.showWork(item.id)) }] : []),
                  {
                    label: item.included ? 'Exclude from analysis' : 'Include in analysis',
                    onSelect: () => {
                      store.setIncluded(item.id, !item.included);
                      toast(item.included ? `“${item.title}” is no longer analysed. It stays in the library.` : `“${item.title}” is analysed again.`);
                    },
                  },
                ]),
            });
          }),
      more(matching.length),
    );
  }

  /** The button under a list that is longer than what is drawn. */
  function more(total: number): HTMLElement | null {
    if (total <= limit) return null;
    return h(
      'div',
      { class: 'list-more' },
      h('span', { class: 'caption' }, `Showing ${limit.toLocaleString('en')} of ${total.toLocaleString('en')}`),
      h(
        'button',
        {
          class: 'button tonal',
          type: 'button',
          onClick: () => {
            limit += PAGE_SIZE;
            renderList();
          },
        },
        'Show more',
      ),
    );
  }

  function nothing(narrowed: boolean): HTMLElement {
    return h(
      'div',
      { class: 'empty-state' },
      h('h2', null, 'Nothing matches'),
      h('p', null, narrowed ? 'Try a different search, or clear the filters.' : 'Nothing here yet.'),
      narrowed
        ? h(
            'button',
            {
              class: 'button text',
              type: 'button',
              onClick: () => {
                searchInput.value = '';
                set({ text: '', status: 'all', decade: null });
              },
            },
            'Clear search and filters',
          )
        : null,
    );
  }

  render();
  return { element, update: render, onProgress: renderBanner };
}
