import { compareText } from '../graph/graph';
import type { LibraryItem } from '../model/types';
import { links, type App, type Page } from './app';
import { initialOf, matchStatus, plural, row, workRow, works } from './describe';
import { chip, h, icon, openMenu, setChildren, toast } from './dom';

type Tab = 'songs' | 'albums' | 'artists';
type Sort = 'title' | 'artist' | 'year';

const STATUSES = {
  all: { label: 'Any status', accepts: (_: LibraryItem) => true },
  matched: { label: 'Matched', accepts: (item: LibraryItem) => item.matchStatus === 'MATCHED' && item.creditsStatus === 'FETCHED' },
  noCredits: { label: 'No credits listed', accepts: (item: LibraryItem) => item.matchStatus === 'MATCHED' && item.creditsStatus === 'EMPTY' },
  excluded: { label: 'Excluded', accepts: (item: LibraryItem) => !item.included },
} as const;
type Status = keyof typeof STATUSES;

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

const lower = (text: string) => text.toLowerCase();
const decadeOf = (item: LibraryItem) => (item.year === undefined ? null : Math.floor(item.year / 10) * 10);

/** The works in the library: search, sort and filter them, and choose which ones are analysed. */
export function createLibraryPage(app: App): Page {
  const { store } = app;

  const summary = h('p', { class: 'subtitle' });
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
    controls,
    list,
  );

  function set(change: Partial<Query>): void {
    Object.assign(query, change);
    render();
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
      `${works(items.filter((i) => i.kind === 'SONG').length, items.filter((i) => i.kind === 'ALBUM').length)} in a demo library` +
      (excluded > 0 ? ` · ${excluded} excluded from analysis` : '');

    const tab = (id: Tab, label: string) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(query.tab === id), onClick: () => set({ tab: id, artist: null }) }, label);
    setChildren(tabs, tab('songs', 'Songs'), tab('albums', 'Albums'), tab('artists', 'Artists'));

    const decades = [...new Set(items.map(decadeOf).filter((d) => d !== null))].sort((a, b) => b - a);
    const listsWorks = query.tab !== 'artists' || query.artist !== null;
    setChildren(
      controls,
      query.artist !== null ? chip(`← All artists`, false, () => set({ artist: null })) : null,
      listsWorks
        ? select<Sort>('Sort by', query.sort, [['title', 'Sort: Title'], ['artist', 'Sort: Artist'], ['year', 'Sort: Newest']], (sort) => set({ sort }))
        : null,
      select<Status>(
        'Match status',
        query.status,
        (Object.keys(STATUSES) as Status[]).map((key) => [key, STATUSES[key].label]),
        (status) => set({ status }),
      ),
      select<string>(
        'Decade',
        String(query.decade ?? ''),
        [['', 'Any decade'], ...decades.map((d): [string, string] => [String(d), `${d}s`])],
        (decade) => set({ decade: decade === '' ? null : Number(decade) }),
      ),
    );
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
        groups.set(item.artist, [...(groups.get(item.artist) ?? []), item]);
      }
      const names = [...groups.keys()].sort((a, b) => compareText(lower(a), lower(b)));
      setChildren(
        list,
        names.length === 0
          ? nothing(text !== '' || filtered)
          : names.map((name) => {
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
    };
    const shown = scoped
      .filter((item) => passesFilters(item) && (text === '' || [item.title, item.artist, item.album ?? ''].some((field) => lower(field).includes(text))))
      .sort(order[query.sort]);

    setChildren(
      list,
      query.artist !== null ? h('div', { class: 'section-header' }, h('h2', null, query.artist), h('p', null, plural(shown.length, 'work'))) : null,
      shown.length === 0
        ? nothing(text !== '' || filtered)
        : shown.map((item) => {
            const onMap = store.snapshot.graph.nodes.some((node) => node.itemIds.includes(item.id));
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
  return { element, update: render };
}
