import type { Distribution } from '../insights/engine';
import type { AnalysisData } from '../model/data';
import { GRAPHED, ordinal, roleName, rolePlural, type Role } from '../model/types';
import { links, type App, type Page } from './app';
import { ROLE_COLORS, STATUS_COLORS, barChart, initialOf, libraryPhrase, percent, plural, row, sectionHeader, type Bar } from './describe';
import { chip, h, setChildren } from './dom';

const MAX_TITLES = 3;
const ACCENT = '#B9A3F5';

// Kept for the visit, like the Library's tab.
let topRole: Role = 'ARTIST';

/** What the credits add up to, each figure stated with what it is based on. */
export function createInsightsPage(app: App): Page {
  const { store } = app;
  const subtitle = h('p', { class: 'subtitle' });
  const body = h('div', { class: 'page-body' });
  const element = h('div', { class: 'page' }, h('header', { class: 'page-header' }, h('div', { class: 'page-title' }, h('h1', null, 'Insights'), subtitle)), body);

  /** The works behind a claim, by title, so every line can be checked against the library. */
  function titles(data: AnalysisData, itemIds: string[]): string {
    const names = itemIds.map((id) => data.itemsById.get(id)?.title).filter((title) => title !== undefined);
    const shown = names
      .slice(0, MAX_TITLES)
      .map((title) => `“${title}”`)
      .join(', ');
    return names.length > MAX_TITLES ? `${shown} and ${names.length - MAX_TITLES} more` : shown;
  }

  function distributionBars(d: Distribution, color: string, capitalise: boolean): Bar[] {
    const share = (count: number) => `${count} · ${percent(count, d.total)}%`;
    const bars: Bar[] = d.slices.map((slice) => ({
      label: capitalise ? slice.label.charAt(0).toUpperCase() + slice.label.slice(1) : slice.label,
      value: slice.count,
      max: d.total,
      valueText: share(slice.count),
      color,
    }));
    // Unknown is shown as its own bar, never folded into the others or silently dropped.
    if (d.unknown > 0) bars.push({ label: 'Unknown', value: d.unknown, max: d.total, valueText: share(d.unknown), color: STATUS_COLORS.none });
    return bars;
  }

  function render(): void {
    const insights = store.insights;
    const data = store.snapshot.data;
    const coverage = insights.coverage;

    if (coverage.total === 0) {
      subtitle.textContent = '';
      setChildren(
        body,
        h(
          'div',
          { class: 'empty-state' },
          h('h2', null, 'No insights yet'),
          h('p', null, 'Every work is excluded from analysis. Include some in Library and insights will appear here.'),
          h('a', { class: 'button filled', href: links.library }, 'Open Library'),
        ),
      );
      return;
    }
    subtitle.textContent = `Based on ${plural(coverage.total, 'work')} in ${libraryPhrase(store.showing)}`;

    // --- coverage ---------------------------------------------------------------------------------
    const share = (label: string, value: number, color: string): Bar => ({
      label,
      value,
      max: coverage.total,
      valueText: `${value} of ${coverage.total} · ${percent(value, coverage.total)}%`,
      color,
    });
    const gaps = [
      coverage.needsReview > 0 ? `${coverage.needsReview} need review` : null,
      coverage.unmatched > 0 ? `${coverage.unmatched} not matched` : null,
      coverage.failed > 0 ? `${coverage.failed} failed to look up` : null,
      coverage.waiting > 0 ? `${coverage.waiting} waiting` : null,
    ].filter(Boolean);

    // --- top by role ------------------------------------------------------------------------------
    const top = insights.topByRole[topRole];
    const topMax = Math.max(0, ...top.map((entry) => entry.count));
    const role = roleName(topRole).toLowerCase();

    // --- hidden connections -----------------------------------------------------------------------
    const hidden: HTMLElement[] = [];
    if (insights.sharedCreators.length > 0) {
      hidden.push(sectionHeader('Shared creators', 'Worked behind the scenes for two or more of the artists in this library.'));
      for (const shared of insights.sharedCreators) {
        hidden.push(
          row({
            title: shared.name,
            subtitle: `${roleName(shared.role)} for ${shared.artistNames.join(', ')}\n${titles(data, shared.itemIds)}`,
            trailing: plural(shared.itemIds.length, 'work'),
            badge: initialOf(shared.name),
            badgeColor: ROLE_COLORS[shared.role],
            round: true,
            onClick: () => app.navigate(links.showCreator(shared.creatorId)),
          }),
        );
      }
    }
    if (insights.collaborations.length > 0) {
      hidden.push(sectionHeader('Artists together', 'Billed on the same work.'));
      for (const collab of insights.collaborations) {
        hidden.push(
          row({
            title: `${collab.firstName} × ${collab.secondName}`,
            subtitle: titles(data, collab.itemIds),
            trailing: plural(collab.itemIds.length, 'work'),
            badge: initialOf(collab.firstName),
            badgeColor: ROLE_COLORS.ARTIST,
            round: true,
            onClick: () => app.navigate(links.showEdge(collab.firstId, collab.secondId)),
          }),
        );
      }
    }
    if (hidden.length === 0) hidden.push(h('p', { class: 'note' }, 'No shared creators or collaborations in the credits so far.'));

    const genres = insights.genres;
    const decades = insights.decades;
    setChildren(
      body,
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Coverage'),
        h(
          'p',
          { class: 'caption' },
          `How much of the ${plural(coverage.total, 'analysed work')} the rest of this page can speak for.` +
            (coverage.excluded > 0 ? ` ${coverage.excluded} excluded ${coverage.excluded === 1 ? 'work is' : 'works are'} left out.` : ''),
        ),
        barChart([
          share('Matched to MusicBrainz', coverage.matched, STATUS_COLORS.ok),
          share('Credits looked up', coverage.creditsQueried, ACCENT),
          share('Have creator credits', coverage.withRoleData, ACCENT),
          share('List a producer', coverage.itemsWithRole[ordinal('PRODUCER')], ROLE_COLORS.PRODUCER),
          share('List a songwriter', coverage.itemsWithRole[ordinal('SONGWRITER')], ROLE_COLORS.SONGWRITER),
          share('List a musician', coverage.itemsWithRole[ordinal('MUSICIAN')], ROLE_COLORS.MUSICIAN),
        ]),
        h(
          'p',
          { class: 'note' },
          (gaps.length > 0 ? gaps.join(' · ') + '. ' : '') + 'A missing credit means MusicBrainz has no record of it, not that the person wasn’t involved.',
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Top creators'),
        h(
          'p',
          { class: 'caption' },
          'Ranked by how many of the saved songs and albums they’re credited on, not by plays or preference. Select a name to find them in the Universe.',
        ),
        h(
          'div',
          { class: 'chips', role: 'group', 'aria-label': 'Role' },
          GRAPHED.map((r) =>
            chip(rolePlural(r), r === topRole, () => {
              topRole = r;
              render();
            }),
          ),
        ),
        barChart(
          top.map((entry) => ({
            label: entry.name,
            value: entry.count,
            max: topMax,
            valueText: String(entry.count),
            color: ROLE_COLORS[topRole],
            onClick: () => app.navigate(links.showCreator(entry.creatorId)),
          })),
        ),
        h(
          'p',
          { class: 'note' },
          top.length === 0
            ? `No ${role} credits found in this library yet.`
            : `Based on the ${coverage.itemsWithRole[ordinal(topRole)]} of ${coverage.total} works that list any ${role}.`,
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Genres'),
        h(
          'p',
          { class: 'caption' },
          `${genres.known} of ${genres.total} works have genre tags; ${genres.unknown} are unknown.` +
            (genres.inferred > 0 ? ` For ${genres.inferred} of them the tags describe the artist rather than the work itself.` : '') +
            ' A work can carry up to three genres, so shares add up to more than 100%.',
        ),
        barChart(distributionBars(genres, ROLE_COLORS.SONGWRITER, true)),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Release decades'),
        h('p', { class: 'caption' }, `${decades.known} of ${decades.total} works have a known release year; ${decades.unknown} are unknown.`),
        barChart(distributionBars(decades, ROLE_COLORS.MUSICIAN, false)),
      ),
      h(
        'section',
        { class: 'card flush' },
        h('h2', null, 'Hidden connections'),
        h(
          'p',
          { class: 'caption' },
          'People and pairings that link different artists in this library. Each line names the works behind it. Select one to see it on the map.',
        ),
        h('div', { class: 'list' }, hidden),
      ),
    );
  }

  render();
  return { element, update: render };
}
