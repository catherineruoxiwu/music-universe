import { compareText } from '../graph/graph';
import { groupBy } from '../model/data';
import { GENRE_LEVELS, ROLES, isGraphed, roleName, rolePlural, type GenreLevel, type LibraryItem, type Role } from '../model/types';
import { links, type App, type Page } from './app';
import { ROLE_COLORS, creatorRow, creditsOn, initialOf, itemSubtitle, matchStatus, plural, row, scope, sectionHeader, workRow } from './describe';
import { h, icon, iconButton, setChildren, toast } from './dom';

const lower = (text: string) => text.toLowerCase();

const GENRE_LEVEL_NOTES: Record<GenreLevel, string> = {
  RECORDING: 'Tagged on this recording',
  RELEASE_GROUP: 'Tagged on the album',
  SOURCE: 'From the music library',
  ARTIST: 'Inferred from the artist, not specific to this work',
};

const METHODS: Record<string, string> = {
  isrc: 'by ISRC',
  barcode: 'by barcode',
  search: 'by title, artist and length',
  user: 'as confirmed by you',
};

function header(app: App, title: string, fallback: string): HTMLElement {
  return h('header', { class: 'page-header bar' }, iconButton('back', 'Back', () => app.back(fallback)), h('h1', null, title));
}

function missing(app: App, what: string): Page {
  return {
    element: h(
      'div',
      { class: 'page' },
      header(app, 'Not found', links.library),
      h('div', { class: 'empty-state' }, h('h2', null, `This ${what} isn’t in the library`), h('a', { class: 'button filled', href: links.library }, 'Open Library')),
    ),
  };
}

/** What a work was matched to, in a sentence that claims no more than was found. */
function describeMatch(item: LibraryItem): string {
  const method = METHODS[item.matchMethod ?? ''];
  const matchedTo = [item.matchedTitle, item.matchedArtist].filter(Boolean).join(' — ') + (method ? ` ${method}` : '');
  switch (item.matchStatus) {
    case 'PENDING':
      return 'Waiting to be looked up on MusicBrainz.';
    case 'FAILED':
      return `The lookup didn’t complete${item.lastError ? ` (${item.lastError})` : ''}. Nothing was assumed.`;
    case 'UNMATCHED':
      return 'No confident match on MusicBrainz. This work stays in the library without credits and isn’t part of the Universe.';
    case 'LOW_CONFIDENCE':
      return `Possible match: ${[item.matchedTitle, item.matchedArtist].filter(Boolean).join(' — ')} (${Math.round((item.matchConfidence ?? 0) * 100)}% confidence). It isn’t used in the Universe.`;
    case 'MATCHED':
      switch (item.creditsStatus) {
        case 'EMPTY':
          return `Matched to ${matchedTo}. MusicBrainz lists no producer, songwriter or musician credits for it yet. That doesn’t mean nobody was involved.`;
        case 'FAILED':
          return `Matched to ${matchedTo}, but reading its credits didn’t complete${item.lastError ? ` (${item.lastError})` : ''}. Nothing was assumed.`;
        case 'NOT_QUERIED':
          return 'Waiting to be looked up on MusicBrainz.';
        case 'FETCHED':
          return `Matched to ${matchedTo}.`;
      }
  }
}

/**
 * One work from the library: what it was matched to, who is credited on it and where each credit
 * comes from.
 */
export function createWorkPage(app: App, id: string): Page {
  const { store } = app;
  if (!store.snapshot.data.itemsById.has(id)) return missing(app, 'work');

  const body = h('div', { class: 'page-body' });
  const kind = store.snapshot.data.itemsById.get(id)!.kind === 'SONG' ? 'Song' : 'Album';
  const element = h('div', { class: 'page' }, header(app, kind, links.library), body);

  let shown: unknown[] = [];

  function render(): void {
    const { data, graph } = store.snapshot;
    const item = data.itemsById.get(id);
    // The library on show was switched or deleted while this page was open.
    if (!item) {
      setChildren(body, h('div', { class: 'empty-state' }, h('h2', null, 'This work isn’t in the library on show'), h('a', { class: 'button filled', href: links.library }, 'Open Library')));
      return;
    }
    const credits = data.creditsByItem.get(id) ?? [];
    const status = matchStatus(item);
    const onMap = graph.nodes.some((node) => node.itemIds.includes(id));

    // While other songs are being looked up this is asked to redraw every few seconds; nothing
    // here changes unless this work did.
    const state = [item, credits.length, onMap];
    if (state.every((value, i) => value === shown[i])) return;
    shown = state;

    const include = h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: item.included });
    include.addEventListener('change', () => store.setIncluded(id, include.checked));

    const rows: HTMLElement[] = [];
    for (const role of ROLES) {
      const ofRole = credits.filter((c) => c.role === role);
      if (ofRole.length === 0) continue;
      rows.push(
        sectionHeader(role === 'OTHER' ? 'Other credits' : rolePlural(role), role === 'OTHER' ? 'Engineering, mixing, arranging and similar. Listed here, not drawn on the map.' : ''),
      );
      // One line per person within a role, listing everything they did in it.
      const people = [...groupBy(ofRole, (c) => c.creatorId).entries()]
        .map(([creatorId, group]) => ({ creatorId, group, name: data.creators.get(creatorId)?.name ?? 'Unknown' }))
        .sort((a, b) => compareText(lower(a.name), lower(b.name)));
      for (const { creatorId, group, name } of people) {
        const details = [...new Set(group.map((c) => c.detail).filter((d) => d.trim() !== '' && d !== roleName(role).toLowerCase()))];
        const scopes = [...new Set(group.map(scope))];
        rows.push(
          row({
            title: name,
            subtitle: [...details, ...scopes].join(' · '),
            badge: initialOf(name),
            badgeColor: isGraphed(role) ? ROLE_COLORS[role] : undefined,
            round: true,
            onClick: () => app.navigate(links.creator(creatorId)),
          }),
        );
      }
    }
    if (credits.length === 0 && item.matchStatus === 'MATCHED' && item.creditsStatus !== 'NOT_QUERIED') {
      rows.push(sectionHeader('Credits', 'MusicBrainz has no credits for this work yet. Unlisted doesn’t mean uninvolved.'));
    }

    const genres = data.genres.filter((g) => g.itemId === id);
    if (genres.length > 0) {
      rows.push(sectionHeader('Genres', 'Community tags, most specific first.'));
      for (const level of GENRE_LEVELS) {
        const atLevel = genres.filter((g) => g.level === level).sort((a, b) => b.votes - a.votes);
        if (atLevel.length === 0) continue;
        rows.push(row({ title: atLevel.map((g) => g.genre).join(', '), subtitle: GENRE_LEVEL_NOTES[level], badge: '♪' }));
      }
    }

    const mbid = item.recordingMbid ?? item.releaseMbid;
    setChildren(
      body,
      h(
        'div',
        { class: 'hero' },
        h('span', { class: 'badge large', 'aria-hidden': 'true' }, initialOf(item.title)),
        h('div', null, h('h2', { class: 'hero-title' }, item.title), h('p', { class: 'subtitle' }, itemSubtitle(item))),
      ),
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'status-line' }, h('span', { class: 'dot', style: { '--dot': status.color } }), h('strong', null, status.label)),
        h('p', { class: 'caption' }, describeMatch(item)),
        lookupActions(item),
        h(
          'label',
          { class: 'switch-row' },
          h('span', null, h('strong', null, 'Include in analysis'), h('small', null, 'Excluded works stay in the library but are left out of the Universe and Insights.')),
          include,
        ),
        onMap ? h('a', { class: 'button tonal', href: links.showWork(id) }, icon('target'), 'View in Universe') : null,
      ),
      h('div', { class: 'list' }, rows),
      h(
        'p',
        { class: 'note padded' },
        mbid
          ? `Credits and genres: MusicBrainz · ${mbid}`
          : 'Credits and genres come from MusicBrainz. Works that can’t be matched never get invented credits.',
      ),
    );
  }

  /** What the user can do about this work's lookup. Only an imported library is looked up from here. */
  function lookupActions(item: LibraryItem): HTMLElement | null {
    if (store.showing !== 'mine') return null;
    const button = (label: string, style: string, onClick: () => void) => h('button', { class: `button ${style}`, type: 'button', onClick }, label);
    const again = (label: string, style = 'text') =>
      button(label, style, () => {
        store.retry(id);
        toast('Looking it up again…');
      });
    switch (item.matchStatus) {
      case 'PENDING':
        return null;
      case 'LOW_CONFIDENCE':
        return h(
          'div',
          { class: 'button-row' },
          button('Yes, that’s it', 'filled', () => {
            store.confirmMatch(id);
            toast('Match confirmed. Reading its credits…');
          }),
          button('Not the same song', 'tonal', () => store.rejectMatch(id)),
          item.recordingMbid
            ? h('a', { class: 'button text', href: `https://musicbrainz.org/recording/${item.recordingMbid}`, target: '_blank', rel: 'noopener noreferrer' }, 'Check on MusicBrainz')
            : null,
        );
      case 'FAILED':
        return h('div', { class: 'button-row' }, again('Try again', 'tonal'));
      case 'UNMATCHED':
        return h('div', { class: 'button-row' }, again('Look up again'));
      case 'MATCHED':
        if (item.creditsStatus === 'NOT_QUERIED') return null;
        return h('div', { class: 'button-row' }, again(item.creditsStatus === 'FAILED' ? 'Try again' : 'Look up again', item.creditsStatus === 'FAILED' ? 'tonal' : 'text'));
    }
  }

  render();
  return { element, update: render };
}

/** One person or group, described only through the works in the library. */
export function createCreatorPage(app: App, id: string): Page {
  const { store } = app;
  if (!store.snapshot.data.creators.has(id)) return missing(app, 'person');

  const body = h('div', { class: 'page-body' });
  const element = h('div', { class: 'page' }, header(app, 'Creator', links.universe), body);

  function render(): void {
    const { data, graph } = store.snapshot;
    const creator = data.creators.get(id);
    // The library on show was switched or deleted while this page was open.
    if (!creator) {
      setChildren(body, h('div', { class: 'empty-state' }, h('h2', null, 'This person isn’t in the library on show'), h('a', { class: 'button filled', href: links.universe }, 'Open Universe')));
      return;
    }
    const index = graph.indexOf(id);
    const node = index >= 0 ? graph.nodes[index] : null;
    const credits = data.creditsByCreator.get(id) ?? [];

    // Roles come from this person's credits in the library, never from a fixed label on them.
    const roles = ROLES.filter((role: Role) => credits.some((c) => c.role === role));
    const works = [...new Set(credits.map((c) => c.itemId))]
      .map((itemId) => data.itemsById.get(itemId)!)
      .sort((a, b) => compareText(lower(a.title), lower(b.title)));
    const stat = (value: number, label: string) => h('div', { class: 'stat' }, h('strong', null, value), h('span', null, label));

    // The map counts only artist, producer, songwriter and musician credits on included works,
    // so say so when this fuller list is longer than the number shown there.
    const offMap = works.length - (node?.itemCount ?? 0);
    const rows: HTMLElement[] = [
      sectionHeader(
        'In this library',
        'Only works saved in the library are listed.' +
          (offMap > 0 ? ` ${plural(offMap, 'work')} of these ${offMap === 1 ? 'is' : 'are'} not counted on the map: excluded, or credited only for engineering and similar.` : ''),
      ),
      ...works.map((item) =>
        workRow(item, {
          subtitle: `${item.artist} — ${creditsOn(data, item.id, id)}`,
          onClick: () => app.navigate(links.work(item.id)),
        }),
      ),
    ];
    if (node && graph.adjacency[index].length > 0) {
      rows.push(sectionHeader('Connected to', 'Linked through works in this library.'));
      const edges = graph.adjacency[index]
        .map((e) => graph.edges[e])
        .sort((a, b) => b.weight - a.weight || compareText(graph.nodes[a.other(index)].name, graph.nodes[b.other(index)].name));
      for (const edge of edges) {
        const other = graph.nodes[edge.other(index)];
        rows.push(creatorRow(other, { trailing: plural(edge.weight, 'shared work'), onClick: () => app.navigate(links.creator(other.id)) }));
      }
    }

    setChildren(
      body,
      h(
        'div',
        { class: 'hero' },
        h('span', { class: 'badge large round', style: { '--badge': ROLE_COLORS[node?.primaryRole ?? 'OTHER'] }, 'aria-hidden': 'true' }, initialOf(creator.name)),
        h(
          'div',
          null,
          h('h2', { class: 'hero-title' }, creator.name),
          h('p', { class: 'subtitle' }, roles.map((role) => (role === 'OTHER' ? 'Other credits' : roleName(role))).join(' · ')),
          [creator.type, creator.note].filter(Boolean).map((line) => h('p', { class: 'subtitle' }, line)),
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'stats' },
          stat(works.filter((item) => item.kind === 'SONG').length, 'Songs'),
          stat(works.filter((item) => item.kind === 'ALBUM').length, 'Albums'),
          stat(node ? graph.degree(index) : 0, 'Connections'),
        ),
        // Someone credited only for engineering, or only on excluded works, has no node to show.
        node ? h('a', { class: 'button tonal', href: links.showCreator(id) }, icon('target'), 'View in Universe') : null,
      ),
      h('div', { class: 'list' }, rows),
    );
  }

  render();
  return { element, update: render };
}
