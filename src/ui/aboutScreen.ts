import { links, type App, type Page } from './app';
import { plural } from './describe';
import { confirmDialog, h, setChildren, toast } from './dom';
import { deleteLibraryButton } from './importScreen';

/** What this site is, what it keeps in the browser, and where its data comes from. */
export function createAboutPage(app: App): Page {
  const { store } = app;
  const body = h('div', { class: 'page-body' });
  const element = h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-header' }, h('div', { class: 'page-title' }, h('h1', null, 'About'), h('p', { class: 'subtitle' }, 'Music Universe on the web'))),
    body,
  );

  const link = (text: string, href: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const action = (title: string, hint: string, button: HTMLElement) => h('div', { class: 'action-row' }, h('div', null, h('strong', null, title), h('small', null, hint)), button);

  function render(): void {
    const data = store.snapshot.data;
    const excluded = data.items.length - data.analysedItems.length;
    const mine = store.showing === 'mine';
    const imported = store.status;
    const reset = h(
      'button',
      {
        class: 'button danger',
        type: 'button',
        disabled: !store.hasLocalChanges,
        onClick: async () => {
          const confirmed = await confirmDialog(
            'Reset your changes?',
            'Every excluded work is included again, and the nickname and the saved layout are forgotten. The library itself is not changed. This can’t be undone.',
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
          'It opens on a small sample library whose credits were looked up on MusicBrainz ahead of time and are bundled with the page. You can also import your own from Apple Music, as a file exported by the Music app; this page then looks each song up on MusicBrainz itself. It cannot sign in to a music service.',
        ),
        h('a', { class: 'button tonal', href: links.import }, imported ? 'Your library' : 'Import your library'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Data in this browser'),
        h(
          'p',
          null,
          (mine
            ? `Your library is on show: ${plural(data.items.length, 'work')}, ${plural(data.creators.size, 'creator')} and ${plural(data.credits.length, 'credit')}, kept in this browser’s storage.`
            : `The demo library is on show: ${plural(data.items.length, 'work')}, ${plural(data.creators.size, 'creator')} and ${plural(data.credits.length, 'credit')}, loaded with the page.`) +
            (excluded > 0 ? ` You have excluded ${plural(excluded, 'work')} from analysis.` : '') +
            (imported && !mine ? ` Your imported library of ${plural(imported.counts.total, 'song')} is kept in this browser’s storage as well.` : ''),
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
        imported ? action('Delete my library', 'Removes the imported songs and their credits from this browser.', deleteLibraryButton(app)) : null,
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
        h(
          'p',
          null,
          'A library file you import is read by this page on your device and is not uploaded. To find credits, the title, artist and album of each imported song are sent from your browser to MusicBrainz, which, like any web service, also sees your IP address. Nothing else in the file leaves your device. The imported songs and what was found for them stay in this browser until you delete them.',
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
