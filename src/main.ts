import './styles.css';
import { Store } from './state/store';
import { createAboutPage } from './ui/aboutScreen';
import { links, parseRoute, type App, type Page, type Route } from './ui/app';
import { createCreatorPage, createWorkPage } from './ui/detailScreens';
import { h, icon, type IconName } from './ui/dom';
import { createInsightsPage } from './ui/insightsScreen';
import { createLibraryPage } from './ui/libraryScreen';
import { createSharePage } from './ui/shareScreen';
import { createUniverseScreen } from './ui/universeScreen';

const store = new Store();

// --- history ----------------------------------------------------------------------------------------
// Each history entry is numbered, which tells a fresh navigation (start at the top) from a return
// to an earlier entry (put the page back where it was).
let entry = 0;
let newestEntry = 0;
let firstEntry = -1;
const scrollOf = new Map<number, number>();
window.addEventListener('scroll', () => scrollOf.set(entry, window.scrollY), { passive: true });

const app: App = {
  store,
  navigate(hash) {
    if (location.hash === hash) showRoute();
    else location.hash = hash;
  },
  back(fallback) {
    // Only go back when the previous entry is one of ours; a visitor who arrived straight on a
    // detail page is taken to the list it belongs to instead of out of the site.
    if (entry > firstEntry) history.back();
    else location.replace(fallback);
  },
  resetLayout() {
    universe.followLayout();
    store.resetLayout();
  },
  clearLocalData() {
    universe.followLayout();
    store.clearLocalData();
  },
};

// --- shell ------------------------------------------------------------------------------------------
const TABS: { name: string; icon: IconName; href: string; pages: Route['page'][] }[] = [
  { name: 'Universe', icon: 'universe', href: links.universe, pages: ['universe'] },
  { name: 'Library', icon: 'library', href: links.library, pages: ['library', 'work'] },
  { name: 'Insights', icon: 'insights', href: links.insights, pages: ['insights'] },
  { name: 'Share', icon: 'share', href: links.share, pages: ['share'] },
  { name: 'About', icon: 'about', href: links.about, pages: ['about'] },
];

const tabLinks = TABS.map((tab) => h('a', { class: 'nav-link', href: tab.href, title: tab.name }, icon(tab.icon), h('span', null, tab.name)));
const universe = createUniverseScreen(app);
const pageHost = h('div', { class: 'page-host', hidden: true });
const main = h('main', { class: 'main', tabindex: '-1' }, universe.element, pageHost);

document.getElementById('app')!.replaceChildren(
  h(
    'nav',
    { class: 'nav', 'aria-label': 'Main' },
    h('a', { class: 'brand', href: links.universe, 'aria-label': 'Music Universe' }, icon('universe'), h('span', null, 'Music Universe')),
    tabLinks,
    h('p', { class: 'nav-note' }, 'A demo library, with credits from MusicBrainz'),
  ),
  main,
);

// --- routing ----------------------------------------------------------------------------------------
let route: Route = { page: 'universe', focus: null };
let page: Page | null = null;

function createPage(target: Route): Page | null {
  switch (target.page) {
    case 'universe':
      return null;
    case 'library':
      return createLibraryPage(app);
    case 'insights':
      return createInsightsPage(app);
    case 'share':
      return createSharePage(app);
    case 'about':
      return createAboutPage(app);
    case 'work':
      return createWorkPage(app, target.id);
    case 'creator':
      return createCreatorPage(app, target.id);
  }
}

const TITLES: Record<Route['page'], string> = {
  universe: 'Music Universe',
  library: 'Library · Music Universe',
  insights: 'Insights · Music Universe',
  share: 'Share Studio · Music Universe',
  about: 'About · Music Universe',
  work: 'Credits · Music Universe',
  creator: 'Creator · Music Universe',
};

function showRoute(): void {
  const state = history.state as { entry?: number } | null;
  const returning = typeof state?.entry === 'number';
  if (returning) newestEntry = Math.max(newestEntry, state.entry!);
  else history.replaceState({ entry: ++newestEntry }, '');
  entry = (history.state as { entry: number }).entry;
  if (firstEntry < 0) firstEntry = entry;
  // Read before the page is swapped, because swapping it moves the window.
  const scrollTo = returning ? (scrollOf.get(entry) ?? 0) : 0;

  route = parseRoute(location.hash);
  page = createPage(route);
  universe.element.hidden = page !== null;
  pageHost.hidden = page === null;
  pageHost.replaceChildren(...(page ? [page.element] : []));
  TABS.forEach((tab, i) => {
    if (tab.pages.includes(route.page)) tabLinks[i].setAttribute('aria-current', 'page');
    else tabLinks[i].removeAttribute('aria-current');
  });
  document.title = TITLES[route.page];
  window.scrollTo(0, scrollTo);

  if (route.page === 'universe' && route.focus !== null) {
    universe.open(route.focus);
    // The request has been carried out; coming back to this entry later should not repeat it.
    history.replaceState(history.state, '', links.universe);
  }
}

window.addEventListener('hashchange', showRoute);
window.addEventListener('keydown', (event) => {
  if (route.page === 'universe' && !event.defaultPrevented && universe.onKey(event)) event.preventDefault();
});

// Pages are redrawn when the library or the filter changes, not on every step of a settling layout.
let shownGeneration = store.snapshot.generation;
store.subscribe(() => {
  if (store.snapshot.generation === shownGeneration) return;
  shownGeneration = store.snapshot.generation;
  page?.update?.();
});

showRoute();
