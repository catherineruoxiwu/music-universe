import type { Insets } from '../graph/camera';
import { GraphVisibility, compareText, isDefaultFilter, linkedWorks, type GraphEdge, type GraphFilter, type GraphNode, type UniverseGraph } from '../graph/graph';
import { UniverseView, type Hover, type Selection } from '../graph/universeView';
import { GRAPHED, roleName, rolePlural, type Role } from '../model/types';
import { links, type App } from './app';
import { ROLE_COLORS, creatorRow, creditsOn, describeFilter, describeProgress, itemSubtitle, libraryPhrase, plural, workRow, works } from './describe';
import { betweenPresses, chip, h, icon, iconButton, setChildren } from './dom';

const SEARCH_LIMIT = 40;
const EDGE_MARGIN = 24;

/**
 * The map and everything that floats over it: title, search, role filters, legend, totals, and
 * the card describing whatever is selected.
 */
export function createUniverseScreen(app: App) {
  const { store } = app;
  let selection: Selection = null;
  let searching = false;

  const canvas = h('canvas', {
    class: 'universe-canvas',
    tabindex: '0',
    role: 'application',
    'aria-label':
      'Map of the people behind the music. Drag to move, scroll or pinch to zoom, select a person or a line for details. Arrow keys move the map, plus and minus zoom, zero shows everything.',
  });
  const view = new UniverseView(canvas);

  // --- header -------------------------------------------------------------------------------------
  const subtitle = h('p', { class: 'subtitle' });
  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search people',
    'aria-label': 'Search people in the universe',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const searchResults = h('div', { class: 'search-results', hidden: true });
  const search = h(
    'div',
    { class: 'search' },
    h('label', { class: 'search-field' }, icon('search'), searchInput),
    iconButton('close', 'Close search', () => closeSearch(), 'search-close'),
    searchResults,
  );
  const roleChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show roles' });
  const top = h(
    'div',
    { class: 'universe-top' },
    h(
      'div',
      { class: 'universe-heading' },
      h('div', { class: 'universe-title' }, h('h1', null, 'Music Universe'), subtitle),
      search,
      iconButton('search', 'Search people', () => openSearch(), 'search-open'),
    ),
    roleChips,
  );

  // --- footer -------------------------------------------------------------------------------------
  const legend = h('div', { class: 'legend' });
  const stats = h('div', { class: 'stats' });
  const bottom = h(
    'div',
    { class: 'universe-bottom' },
    h('div', { class: 'universe-summary' }, legend, stats),
    h(
      'div',
      { class: 'view-buttons' },
      iconButton('plus', 'Zoom in', () => view.zoomBy(1.5)),
      iconButton('minus', 'Zoom out', () => view.zoomBy(1 / 1.5)),
      iconButton('fit', 'Show everything', () => view.resetView()),
    ),
  );

  const tooltip = h('div', { class: 'tooltip', hidden: true });
  const card = h('aside', { class: 'detail-card', hidden: true, 'aria-live': 'polite' });
  const emptyTitle = h('h2');
  const emptyText = h('p');
  const emptyLink = h('a', { class: 'button filled' });
  const empty = h('div', { class: 'empty-state', hidden: true }, emptyTitle, emptyText, emptyLink);

  // The header and footer lie over the map; the card takes the right of the space between them
  // on a wide window and rises from the bottom on a narrow one.
  const element = h(
    'section',
    { class: 'universe-screen', 'aria-label': 'Universe' },
    canvas,
    h('div', { class: 'universe-overlay' }, top, h('div', { class: 'universe-middle' }, card), bottom),
    tooltip,
    empty,
  );

  // --- map events ---------------------------------------------------------------------------------
  view.listener = {
    onNodeTapped: (node) => select({ kind: 'creator', id: node.id }, false),
    onNodeDoubleTapped: (node) => view.focusNodes([node.index], covered()),
    onEdgeTapped: (edge) => {
      const graph = store.snapshot.graph;
      select({ kind: 'edge', a: graph.nodes[edge.a].id, b: graph.nodes[edge.b].id }, false);
    },
    onBlankTapped: () => select(null, false),
    onHover: showTooltip,
  };

  /** How much of each side of the map is hidden behind the header, the footer and the card. */
  function covered(): Insets {
    const map = canvas.getBoundingClientRect();
    const insets: Insets = { left: EDGE_MARGIN, top: top.offsetHeight, right: EDGE_MARGIN, bottom: bottom.offsetHeight };
    if (card.hidden) return insets;
    const box = card.getBoundingClientRect();
    // A card that spans the window sits at the bottom (phone); otherwise it is a side panel.
    if (box.width > map.width * 0.6) insets.bottom = map.bottom - box.top;
    else insets.right = map.right - box.left + EDGE_MARGIN;
    return insets;
  }

  function updateFramePadding(): void {
    view.setFramePadding({ left: EDGE_MARGIN, top: top.offsetHeight, right: EDGE_MARGIN, bottom: bottom.offsetHeight });
  }
  new ResizeObserver(updateFramePadding).observe(top);
  new ResizeObserver(updateFramePadding).observe(bottom);

  // --- selection ----------------------------------------------------------------------------------

  /**
   * @param moveIn glide to the selection and zoom in on it, as when arriving from a search or
   *   another screen. Otherwise the map moves only if the card would cover what was selected.
   */
  function select(value: Selection, moveIn: boolean): void {
    selection = value;
    view.setSelection(value);
    if (value !== null && !view.selectionVisible) {
      // Not on the map: excluded since the link was made, or hidden by the current filter.
      selection = null;
      view.setSelection(null);
    }
    renderCard();
    if (selection === null) return;
    // After the card has taken its place, so that it is known what it covers.
    requestAnimationFrame(() => {
      if (moveIn) view.focusNodes(view.focusedNodes, covered());
      else view.revealNodes(selection?.kind === 'creator' ? [store.snapshot.graph.indexOf(selection.id)] : view.focusedNodes, covered());
    });
  }

  /** What the card was last drawn for, and what it then said. */
  let cardFor = '';

  function renderCard(): void {
    card.hidden = selection === null;
    const drawn = h('div');
    drawCard(drawn);
    const drawnFor = JSON.stringify(selection);
    const sameSelection = drawnFor === cardFor;
    // Says the same as before, as it will after most lookups of other songs: keep the elements
    // that are there, with their focus and scroll position.
    if (sameSelection && drawn.textContent === card.textContent) return;
    const scrolled = sameSelection ? (card.querySelector('.card-list')?.scrollTop ?? 0) : 0;
    cardFor = drawnFor;
    card.replaceChildren(...drawn.childNodes);
    const list = card.querySelector('.card-list');
    if (list) list.scrollTop = scrolled;
  }

  function drawCard(card: HTMLElement): void {
    const { graph, data } = store.snapshot;
    if (selection === null) return;
    const close = iconButton('close', 'Close', () => select(null, false));
    const header = (title: string, lines: string[]) =>
      h('header', { class: 'card-header' }, h('div', null, h('h2', null, title), lines.map((line) => h('p', null, line))), close);
    const itemsOf = (ids: string[]) =>
      ids
        .map((id) => data.itemsById.get(id))
        .filter((item) => item !== undefined)
        .sort((a, b) => compareText(a.title.toLowerCase(), b.title.toLowerCase()));

    if (selection.kind === 'creator') {
      const id = selection.id;
      const index = graph.indexOf(id);
      const node = graph.nodes[index];
      setChildren(
        card,
        header(node.name, [node.roleLine, `${works(node.songCount, node.albumCount)} · ${describeConnections(index)}`]),
        h(
          'div',
          { class: 'card-list' },
          itemsOf(node.itemIds).map((item) =>
            workRow(item, {
              subtitle: `${item.artist} — ${creditsOn(data, item.id, id, false)}`,
              onClick: () => app.navigate(links.work(item.id)),
            }),
          ),
        ),
        h('footer', { class: 'card-footer' }, h('a', { class: 'button text', href: links.creator(id) }, 'View details')),
      );
    } else if (selection.kind === 'edge') {
      const a = graph.nodes[graph.indexOf(selection.a)];
      const b = graph.nodes[graph.indexOf(selection.b)];
      const edge = graph.edges[graph.edgeBetween(a.index, b.index)];
      setChildren(
        card,
        header(`${a.name} × ${b.name}`, [`Connected by ${plural(edge.weight, 'work')} in this library`]),
        h(
          'div',
          { class: 'card-list' },
          // The evidence: each shared work, and what each of the two did on it.
          itemsOf(edge.itemIds).map((item) =>
            workRow(item, {
              subtitle: `${a.name}: ${creditsOn(data, item.id, a.id, false)}\n${b.name}: ${creditsOn(data, item.id, b.id, false)}`,
              onClick: () => app.navigate(links.work(item.id)),
            }),
          ),
        ),
      );
    } else {
      const item = data.itemsById.get(selection.id)!;
      const people = view.focusedNodes.map((i) => graph.nodes[i]).sort((x, y) => compareText(x.name.toLowerCase(), y.name.toLowerCase()));
      setChildren(
        card,
        header(item.title, [itemSubtitle(item), `${plural(people.length, 'person', 'people')} on the map for this ${item.kind.toLowerCase()}`]),
        h(
          'div',
          { class: 'card-list' },
          people.map((node) =>
            creatorRow(node, {
              subtitle: creditsOn(data, item.id, node.id, false),
              onClick: () => select({ kind: 'creator', id: node.id }, false),
            }),
          ),
        ),
        h('footer', { class: 'card-footer' }, h('a', { class: 'button text', href: links.work(item.id) }, 'View credits')),
      );
    }
  }

  /** How many lines lead from this person: the ones the filter shows, and out of how many. */
  function describeConnections(index: number): string {
    const graph = store.snapshot.graph;
    const all = graph.degree(index);
    const visibility = GraphVisibility.compute(graph, store.filter);
    const shown = graph.adjacency[index].filter((e) => visibility.edges[e]).length;
    return shown === all ? plural(all, 'connection') : `${shown} of ${all} connections shown`;
  }

  // --- hover --------------------------------------------------------------------------------------
  function showTooltip(target: Hover, x: number, y: number): void {
    tooltip.hidden = target === null;
    if (target === null) return;
    const graph = store.snapshot.graph;
    if ('node' in target) {
      const node: GraphNode = target.node;
      setChildren(tooltip, h('strong', null, node.name), h('span', null, node.roleLine), h('span', null, works(node.songCount, node.albumCount)));
    } else {
      const edge: GraphEdge = target.edge;
      setChildren(tooltip, h('strong', null, `${graph.nodes[edge.a].name} × ${graph.nodes[edge.b].name}`), h('span', null, plural(edge.weight, 'shared work')));
    }
    // Beside the pointer, flipped to the other side near the right and bottom edges.
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const left = x + 16 + width > canvas.clientWidth ? x - 16 - width : x + 16;
    const topEdge = y + 16 + height > canvas.clientHeight ? y - 16 - height : y + 16;
    tooltip.style.transform = `translate(${Math.max(left, 4)}px, ${Math.max(topEdge, 4)}px)`;
  }

  // --- search -------------------------------------------------------------------------------------
  function openSearch(): void {
    // The class comes first: on a phone the field is not shown, and so cannot take focus, until it is set.
    element.classList.add('searching');
    searchInput.focus();
  }

  function closeSearch(): void {
    if (!searching) return;
    searching = false;
    element.classList.remove('searching');
    searchInput.value = '';
    searchResults.hidden = true;
    searchInput.blur();
  }

  /** Searches only people who are on the map; this is not a catalogue search. */
  function renderSearchResults(): void {
    const graph = store.snapshot.graph;
    const query = searchInput.value.trim().toLowerCase();
    const matches = graph.nodesByWeight
      .map((i) => graph.nodes[i])
      .filter((node) => query === '' || node.name.toLowerCase().includes(query))
      .slice(0, SEARCH_LIMIT);
    searchResults.hidden = false;
    setChildren(
      searchResults,
      matches.length === 0
        ? h('p', { class: 'search-empty' }, graph.nodes.length === 0 ? 'The universe has no people yet.' : `No one named “${searchInput.value.trim()}” in this universe.`)
        : matches.map((node) =>
            creatorRow(node, {
              trailing: works(node.songCount, node.albumCount),
              onClick: () => {
                closeSearch();
                showOnMap({ kind: 'creator', id: node.id });
              },
            }),
          ),
    );
  }

  searchInput.addEventListener('focus', () => {
    searching = true;
    element.classList.add('searching');
    renderSearchResults();
  });
  searchInput.addEventListener('input', renderSearchResults);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') (searchResults.querySelector('.row-main') as HTMLElement | null)?.click();
  });
  document.addEventListener('pointerdown', (event) => {
    if (searching && !search.contains(event.target as Node)) closeSearch();
  });

  /** Selects something that may be hidden by the current filter, clearing the filter if it is. */
  function showOnMap(target: Selection): void {
    view.setSelection(target);
    if (target !== null && !view.selectionVisible && !isDefaultFilter(store.filter)) {
      store.setFilter({ role: null, sharedOnly: false });
    }
    select(target, true);
  }

  // --- rendering ----------------------------------------------------------------------------------
  let shownGeneration = -1;
  let shownFilter = store.filter;
  let chipsFor: GraphFilter | null = null;

  function render(): void {
    const { snapshot, filter } = store;
    view.setSnapshot(snapshot);
    view.setFilter(filter);
    // While a layout settles, only positions change. Leave the controls alone then, so that a
    // press that lands on one in the meantime is not lost.
    if (snapshot.generation === shownGeneration && filter === shownFilter) return;
    // A change of filter is the user's doing and shows at once. Anything else may be the result
    // of a song looked up in the background, and waits for a press that is under way.
    if (filter !== shownFilter) renderControls();
    else betweenPresses(renderControls);
  }

  /** The line under the title: whose library this is, how far its import is, or what the filter shows. */
  function renderSubtitle(): void {
    const status = store.status;
    const importing = store.showing === 'mine' && status !== null && status.counts.remaining > 0;
    subtitle.textContent = !isDefaultFilter(store.filter)
      ? describeFilter(store.filter)
      : importing
        ? `Your library · ${describeProgress(status)}`
        : `The people behind ${libraryPhrase(store.showing)}`;

    if (importing) {
      emptyTitle.textContent = 'Looking up your songs';
      emptyText.textContent = 'People appear here as soon as the first credits are found.';
      emptyLink.textContent = 'See progress';
      emptyLink.href = links.import;
    } else {
      emptyTitle.textContent = 'Nothing to connect yet';
      emptyText.textContent = 'None of the works being analysed has credits to draw. Include more works in Library.';
      emptyLink.textContent = 'Open Library';
      emptyLink.href = links.library;
    }
  }

  function renderControls(): void {
    const { snapshot, filter } = store;
    const graph = snapshot.graph;
    shownGeneration = snapshot.generation;
    shownFilter = filter;
    const visibility = GraphVisibility.compute(graph, filter);
    const filtered = !isDefaultFilter(filter);

    renderSubtitle();

    // The chips and the legend depend on the filter alone.
    if (filter !== chipsFor) {
      chipsFor = filter;
      const roleChip = (label: string, role: Role | null) => chip(label, filter.role === role, () => store.setFilter({ ...filter, role }));
      setChildren(
        roleChips,
        roleChip('All', null),
        GRAPHED.map((role) => roleChip(rolePlural(role), role)),
        h('span', { class: 'chip-divider', 'aria-hidden': 'true' }),
        chip('Shared Only', filter.sharedOnly, () => store.setFilter({ ...filter, sharedOnly: !filter.sharedOnly })),
      );
      setChildren(
        legend,
        GRAPHED.map((role) =>
          h(
            'span',
            { class: `legend-item ${filter.role !== null && filter.role !== role ? 'muted' : ''}` },
            h('span', { class: 'dot', style: { '--dot': ROLE_COLORS[role] } }),
            roleName(role),
          ),
        ),
      );
    }

    renderTotals(graph, visibility, filtered);
  }

  function renderTotals(graph: UniverseGraph, visibility: GraphVisibility, filtered: boolean): void {
    // The three numbers under the map always describe what the current filter shows.
    const worksLabel = filtered ? 'Linked works' : graph.stats.albums === 0 ? 'Songs' : graph.stats.songs === 0 ? 'Albums' : 'Works';
    const figures: [number, string][] = [
      [filtered ? linkedWorks(graph, visibility) : graph.stats.songs + graph.stats.albums, worksLabel],
      [graph.nodes.filter((node) => visibility.nodes[node.index] && node.hasRole('ARTIST')).length, 'Artists'],
      [visibility.nodeCount, 'Creators'],
    ];
    setChildren(stats, figures.map(([value, label]) => h('div', { class: 'stat' }, h('strong', null, value), h('span', null, label))));

    const nothing = graph.nodes.length === 0;
    empty.hidden = !nothing;
    bottom.hidden = nothing;

    // The filter or an exclusion may have removed whatever the card was describing.
    if (selection !== null && !view.selectionVisible) {
      selection = null;
      view.setSelection(null);
    }
    renderCard();
    if (searching) renderSearchResults();
  }

  store.subscribe(render);
  store.subscribeProgress(renderSubtitle);
  render();

  return {
    element,
    /** Called when the map becomes the current screen. */
    open(focus: Selection): void {
      // The map may have been hidden while the window changed size.
      view.measure();
      if (focus !== null) showOnMap(focus);
    },
    /** Handles a key press while the map is the current screen. Returns true if it was used. */
    onKey(event: KeyboardEvent): boolean {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === 'Escape') {
        if (searching) closeSearch();
        else if (selection !== null) select(null, false);
        else return false;
        return true;
      }
      if (event.key === '/' && !typing) {
        openSearch();
        return true;
      }
      return false;
    },
    /** Keeps the whole map framed while the layout about to run settles. */
    followLayout(): void {
      view.followLayout();
    },
  };
}

export type UniverseScreen = ReturnType<typeof createUniverseScreen>;
