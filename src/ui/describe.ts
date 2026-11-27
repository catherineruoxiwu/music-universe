import type { GraphFilter, GraphNode } from '../graph/graph';
import { SCREEN_STYLE } from '../graph/theme';
import type { AnalysisData } from '../model/data';
import { ROLES, rolePlural, type Credit, type LibraryItem } from '../model/types';
import type { ImportStatus, Showing } from '../state/store';
import { h, iconButton } from './dom';

// Turns stored data into the short phrases shown in lists. Kept in one place for consistency.

export const ROLE_COLORS = SCREEN_STYLE.roleColors;

export const STATUS_COLORS = { ok: '#63D6A0', pending: '#A9A1BD', warn: '#F4B76A', error: '#F2788C', none: '#6F6885' };

export function plural(count: number, one: string, many = one + 's'): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "a demo library" or "your library", for sentences that say whose music is on show. */
export const libraryPhrase = (showing: Showing): string => (showing === 'mine' ? 'your library' : 'a demo library');

/** "about 2 hours", "about 5 minutes", "under a minute" */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `about ${plural(minutes, 'minute')}`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  if (rest === 60) return `about ${plural(hours + 1, 'hour')}`;
  return `about ${plural(hours, 'hour')}` + (rest > 0 && hours < 10 ? ` ${rest} min` : '');
}

/** What the lookups of an imported library are doing, in a sentence. */
export function describeProgress(status: ImportStatus): string {
  const { counts, state } = status;
  const count = (value: number) => value.toLocaleString('en');
  const total = `${count(counts.total)} ${counts.total === 1 ? 'song' : 'songs'}`;
  if (counts.remaining === 0) return `All ${total} looked up`;
  const progress = `${count(counts.total - counts.remaining)} of ${total} looked up`;
  switch (state) {
    case 'running':
      return `${progress} · ${duration(status.etaMs)} left`;
    case 'offline':
      return `${progress} · can’t reach MusicBrainz`;
    case 'elsewhere':
      return `${progress} · continuing in another tab`;
    case 'idle':
      return `${progress} · paused`;
  }
}

export const percent = (value: number, of: number): number => (of === 0 ? 0 : Math.round((value * 100) / of));

/** "9 songs · 1 album" */
export function works(songs: number, albums: number): string {
  if (albums === 0) return plural(songs, 'song');
  if (songs === 0) return plural(albums, 'album');
  return `${plural(songs, 'song')} · ${plural(albums, 'album')}`;
}

/** "Turnover · Peripheral Vision · 2015" */
export function itemSubtitle(item: LibraryItem): string {
  return [item.artist, item.kind === 'SONG' ? item.album : undefined, item.year].filter(Boolean).join(' · ');
}

/**
 * What one creator did on one work, e.g. "Producer · Songwriter (composer, lyricist) · guitar".
 * Built only from stored credits, so it can never claim more than the source states.
 */
export function credits(list: Credit[], includeOther = true): string {
  const parts: string[] = [];
  for (const role of ROLES) {
    if (role === 'OTHER' && !includeOther) continue;
    const ofRole = list.filter((c) => c.role === role);
    if (ofRole.length === 0) continue;
    const details = [...new Set(ofRole.map((c) => c.detail).filter((d) => d.trim() !== ''))];
    const joined = details.join(', ');
    switch (role) {
      case 'ARTIST':
        parts.push('Artist');
        break;
      case 'PRODUCER':
        parts.push(details.every((d) => d === 'producer') ? 'Producer' : joined.charAt(0).toUpperCase() + joined.slice(1));
        break;
      case 'SONGWRITER':
        parts.push(details.length === 0 || joined === 'writer' ? 'Songwriter' : `Songwriter (${joined})`);
        break;
      case 'MUSICIAN':
        parts.push(details.length === 0 ? 'Musician' : joined);
        break;
      case 'OTHER':
        parts.push(joined);
        break;
    }
  }
  return parts.join(' · ');
}

export function creditsOn(data: AnalysisData, itemId: string, creatorId: string, includeOther = true): string {
  return credits((data.creditsByItem.get(itemId) ?? []).filter((c) => c.creatorId === creatorId), includeOther);
}

/** Where a credit was stated, e.g. "on this recording". */
export function scope(credit: Credit): string {
  switch (credit.scope) {
    case 'RECORDING':
      return 'on this recording';
    case 'WORK':
      return 'on the song as written';
    case 'RELEASE':
      return 'on this release';
    case 'ALBUM_TRACK':
      return `on ${plural(credit.trackCount, 'track')} of this album`;
  }
}

/** The one-word state of a work's match, and the colour of its dot. */
export function matchStatus(item: LibraryItem): { label: string; color: string } {
  if (!item.included) return { label: 'Excluded', color: STATUS_COLORS.pending };
  switch (item.matchStatus) {
    case 'PENDING':
      return { label: 'Waiting', color: STATUS_COLORS.pending };
    case 'LOW_CONFIDENCE':
      return { label: 'Needs review', color: STATUS_COLORS.warn };
    case 'UNMATCHED':
      return { label: 'Not matched', color: STATUS_COLORS.none };
    case 'FAILED':
      return { label: 'Lookup failed', color: STATUS_COLORS.error };
    case 'MATCHED':
      switch (item.creditsStatus) {
        case 'NOT_QUERIED':
          return { label: 'Waiting', color: STATUS_COLORS.pending };
        case 'FETCHED':
          return { label: 'Matched', color: STATUS_COLORS.ok };
        case 'EMPTY':
          return { label: 'No credits listed', color: STATUS_COLORS.warn };
        case 'FAILED':
          return { label: 'Lookup failed', color: STATUS_COLORS.error };
      }
  }
}

/** "Showing Producers · Shared Only" */
export function describeFilter(filter: GraphFilter): string {
  return 'Showing ' + [filter.role ? rolePlural(filter.role) : null, filter.sharedOnly ? 'Shared Only' : null].filter(Boolean).join(' · ');
}

/** The first letter (or digit) of a name, for the badge beside it. */
export function initialOf(text: string): string {
  const first = [...text.trim()].find((ch) => /[\p{L}\p{N}]/u.test(ch));
  return first ? first.toUpperCase() : '♪';
}

interface RowOptions {
  title: string;
  subtitle?: string;
  trailing?: string;
  badge: string;
  /** Fill of the badge. Omitted for works, which get a neutral tile. */
  badgeColor?: string;
  /** Round badges are people; square ones are works. */
  round?: boolean;
  dimmed?: boolean;
  status?: { label: string; color: string; showLabel: boolean };
  onClick?: () => void;
  /** Called with the "more" button when it is pressed. */
  onMore?: (anchor: HTMLElement) => void;
}

/** One line of a list: a badge, a title over a subtitle, and optionally a status and a menu. */
export function row(options: RowOptions): HTMLElement {
  const body = [
    h(
      'span',
      {
        class: `badge ${options.round ? 'round' : ''}`,
        style: options.badgeColor ? { '--badge': options.badgeColor } : undefined,
        'aria-hidden': 'true',
      },
      options.badge,
    ),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, options.title), options.subtitle ? h('span', { class: 'row-subtitle' }, options.subtitle) : null),
    options.trailing ? h('span', { class: 'row-trailing' }, options.trailing) : null,
    options.status
      ? h(
          'span',
          { class: 'row-status', title: options.status.label },
          h('span', { class: 'dot', style: { '--dot': options.status.color } }),
          options.status.showLabel ? options.status.label : h('span', { class: 'visually-hidden' }, options.status.label),
        )
      : null,
  ];
  const main = options.onClick
    ? h('button', { class: 'row-main', type: 'button', onClick: options.onClick }, body)
    : h('div', { class: 'row-main' }, body);
  const element = h('div', { class: `row ${options.dimmed ? 'dimmed' : ''}` }, main);
  if (options.onMore) {
    const onMore = options.onMore;
    const more = iconButton('more', `More actions for ${options.title}`, () => onMore(more), 'row-more');
    more.setAttribute('aria-haspopup', 'menu');
    element.appendChild(more);
  }
  return element;
}

export function workRow(item: LibraryItem, extra: Partial<RowOptions> = {}): HTMLElement {
  return row({ title: item.title, subtitle: itemSubtitle(item), badge: initialOf(item.title), dimmed: !item.included, ...extra });
}

export function creatorRow(node: GraphNode, extra: Partial<RowOptions> = {}): HTMLElement {
  return row({
    title: node.name,
    subtitle: node.roleLine,
    badge: initialOf(node.name),
    badgeColor: ROLE_COLORS[node.primaryRole],
    round: true,
    ...extra,
  });
}

/** A heading inside a list, with an optional explanatory line. */
export function sectionHeader(title: string, note = ''): HTMLElement {
  return h('div', { class: 'section-header' }, h('h2', null, title), note ? h('p', null, note) : null);
}

export interface Bar {
  label: string;
  value: number;
  max: number;
  valueText: string;
  color: string;
  onClick?: () => void;
}

/** Horizontal bars, one per line: label on the left, figure on the right, bar underneath. */
export function barChart(bars: Bar[]): HTMLElement {
  return h(
    'div',
    { class: 'bars' },
    bars.map((bar) => {
      const content = [
        h('span', { class: 'bar-label' }, bar.label),
        h('span', { class: 'bar-value' }, bar.valueText),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${bar.max === 0 ? 0 : (bar.value * 100) / bar.max}%`, background: bar.color } })),
      ];
      return bar.onClick ? h('button', { class: 'bar', type: 'button', onClick: bar.onClick }, content) : h('div', { class: 'bar' }, content);
    }),
  );
}
