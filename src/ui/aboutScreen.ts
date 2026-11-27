import type { App, Page } from './app';
import { plural } from './describe';
import { confirmDialog, h, setChildren, toast } from './dom';

/** What this site is, what it keeps in the browser, and where its data comes from. */
export function createAboutPage(app: App): Page {
  const { store } = app;
  const body = h('div', { class: 'page-body' });
  const element = h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-header' }, h('div', { class: 'page-title' }, h('h1', null, 'About'), h('p', { class: 'subtitle' }, 'Music Universe, web demo'))),
    body,
  );

  const link = (text: string, href: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const action = (title: string, hint: string, button: HTMLElement) => h('div', { class: 'action-row' }, h('div', null, h('strong', null, title), h('small', null, hint)), button);

  function render(): void {
    const data = store.snapshot.data;
    const excluded = data.items.length - data.analysedItems.length;
    const reset = h(
      'button',
      {
        class: 'button danger',
        type: 'button',
        disabled: !store.hasLocalChanges,
        onClick: async () => {
          const confirmed = await confirmDialog(
            'Reset your changes?',
            'Every excluded work is included again, and the nickname and the saved layout are forgotten. The demo library itself is not changed. This can’t be undone.',
            'Reset',
          );
          if (!confirmed) return;
          app.clearLocalData();
          toast('Your changes were reset');
        },
      },
      'Reset',
    );

    setChildren(
      body,
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'What this is'),
        h(
          'p',
          null,
          'Music Universe draws the people behind a music library as a map: artists, producers, songwriters and musicians, joined wherever they are credited on the same song or album. Every line can be traced back to the works that put it there.',
        ),
        h(
          'p',
          null,
          `This site is a demo. It shows one fixed sample library of ${plural(data.items.length, 'work')}, not yours: it cannot connect to a music service or import anything. The credits were looked up on MusicBrainz ahead of time and are bundled with the page.`,
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Data in this browser'),
        h(
          'p',
          null,
          `${plural(data.items.length, 'work')}, ${plural(data.creators.size, 'creator')} and ${plural(data.credits.length, 'credit')} are loaded with the page.` +
            (excluded > 0 ? ` You have excluded ${plural(excluded, 'work')} from analysis.` : ''),
        ),
        action(
          'Reset Universe layout',
          'Rearranges the map from scratch. No data is removed.',
          h(
            'button',
            {
              class: 'button tonal',
              type: 'button',
              onClick: () => {
                app.resetLayout();
                toast('Rearranging the universe…');
              },
            },
            'Rearrange',
          ),
        ),
        action('Reset my changes', 'Includes every work again and forgets the nickname and saved layout.', reset),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Privacy'),
        h(
          'p',
          null,
          'There is no account, no server of ours and no analytics. Which works you exclude, the nickname for a poster and the layout of the map are kept in this browser’s storage only, and posters are drawn on your device.',
        ),
        h('p', null, 'The page itself is served by GitHub Pages, which, like any web host, sees the request for it.'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Data sources'),
        h(
          'p',
          null,
          'Credits and genres: ',
          link('MusicBrainz', 'https://musicbrainz.org'),
          ', a community-maintained database. Its core data is released under ',
          link('CC0', 'https://creativecommons.org/publicdomain/zero/1.0/'),
          '; genres and tags are licensed ',
          link('CC BY-NC-SA 3.0', 'https://creativecommons.org/licenses/by-nc-sa/3.0/'),
          '.',
        ),
        h(
          'p',
          null,
          'Coverage is incomplete, and a missing credit is never treated as evidence that someone wasn’t involved. Nothing here is ranked by plays or preference, only counted from credits.',
        ),
        h('p', { class: 'note' }, 'Not affiliated with or endorsed by MusicBrainz, Apple or any artist or label named here.'),
      ),
    );
  }

  render();
  return { element, update: render };
}
