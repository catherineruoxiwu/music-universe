import { TYPICAL_MS } from '../enrich/runner';
import { ImportError, parseAppleLibrary, type ParsedLibrary } from '../import/appleLibrary';
import { links, type App, type Page } from './app';
import { STATUS_COLORS, describeProgress, duration, plural } from './describe';
import { chip, confirmDialog, h, icon, setChildren, toast } from './dom';
import { showLibraryStatus, type Status } from './libraryScreen';

const count = (value: number) => value.toLocaleString('en');
const songs = (value: number) => `${count(value)} ${value === 1 ? 'song' : 'songs'}`;

/** A button that removes the imported library from this browser, after asking. */
export function deleteLibraryButton(app: App): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'button danger',
      type: 'button',
      onClick: async () => {
        const confirmed = await confirmDialog(
          'Delete your library?',
          'The imported songs and everything looked up for them are removed from this browser. The file on your computer is not touched. This can’t be undone.',
          'Delete',
        );
        if (!confirmed) return;
        app.deleteLibrary();
        toast('Your library was deleted from this browser');
      },
    },
    'Delete',
  );
}

/** Importing a library of one's own, and watching over the lookups that fill it in. */
export function createImportPage(app: App): Page {
  const { store } = app;
  const body = h('div', { class: 'page-body' });
  const element = h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-header' },
      h('div', { class: 'page-title' }, h('h1', null, 'Your library'), h('p', { class: 'subtitle' }, 'See the people behind your own music')),
    ),
    body,
  );

  /** A file that has been read and is waiting for the user to say what to import from it. */
  let chosen: { fileName: string; library: ParsedLibrary; choiceId: string } | null = null;
  /** The user asked to pick another file although a library is already imported. */
  let replacing = false;
  let problem: string | null = null;
  let reading = false;
  let refreshStatus: (() => void) | null = null;

  // --- choosing a file ------------------------------------------------------------------------------

  async function read(file: File): Promise<void> {
    reading = true;
    problem = null;
    render();
    try {
      const library = parseAppleLibrary(await file.text());
      chosen = { fileName: file.name, library, choiceId: library.choices[0].id };
    } catch (error) {
      chosen = null;
      problem = error instanceof ImportError ? error.message : 'This file couldn’t be read. Choose the .xml file the Music app saved.';
    }
    reading = false;
    render();
  }

  function fileCard(): HTMLElement {
    const input = h('input', { type: 'file', accept: '.xml,text/xml,application/xml', class: 'visually-hidden', tabindex: '-1' });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void read(file);
    });
    const drop = h(
      'div',
      { class: 'drop-zone' },
      h('button', { class: 'button filled', type: 'button', disabled: reading, onClick: () => input.click() }, reading ? 'Reading…' : 'Choose file…'),
      h('span', { class: 'caption' }, 'or drop it here'),
      input,
    );
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      const file = event.dataTransfer?.files[0];
      if (file) void read(file);
    });

    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Import from Apple Music'),
      h(
        'ol',
        { class: 'steps' },
        h('li', null, 'On a Mac, open the ', h('strong', null, 'Music'), ' app.'),
        h('li', null, 'Choose ', h('strong', null, 'File › Library › Export Library…'), ' and save the file. It is called Library.xml unless you rename it.'),
        h('li', null, 'Choose that file here.'),
      ),
      drop,
      problem ? h('p', { class: 'problem', role: 'alert' }, problem) : null,
      h(
        'p',
        { class: 'note' },
        'For a single playlist, select it in Music and use File › Library › Export Playlist… with the format set to XML. Files exported by iTunes on Windows work too.',
      ),
      h(
        'p',
        { class: 'note' },
        'The file is read by this page, on your device, and is not uploaded anywhere. To find the credits, the title, artist and album of each song are sent from your browser to MusicBrainz, a public music database.',
      ),
      store.status ? h('button', { class: 'button text', type: 'button', onClick: () => stopReplacing() }, 'Cancel') : null,
    );
  }

  function stopReplacing(): void {
    replacing = false;
    chosen = null;
    problem = null;
    render();
  }

  // --- confirming what to import ---------------------------------------------------------------------

  function previewCard(): HTMLElement {
    const { fileName, library, choiceId } = chosen!;
    const choice = library.choices.find((c) => c.id === choiceId) ?? library.choices[0];
    const existing = store.status;

    const select = h(
      'select',
      { 'aria-label': 'What to import' },
      library.choices.map((c) => h('option', { value: c.id, selected: c.id === choice.id }, `${c.kind === 'playlist' ? 'Playlist: ' : ''}${c.name} (${songs(c.songs.length)})`)),
    );
    select.addEventListener('change', () => {
      chosen!.choiceId = select.value;
      render();
    });

    const { videos, podcasts, incomplete, duplicates } = library.skipped;
    const leftOut = [
      videos > 0 ? plural(videos, 'video') : null,
      podcasts > 0 ? plural(podcasts, 'podcast or audiobook', 'podcasts and audiobooks') : null,
      incomplete > 0 ? `${incomplete} without a title or an artist` : null,
      duplicates > 0 ? plural(duplicates, 'duplicate') : null,
    ].filter(Boolean);

    return h(
      'section',
      { class: 'card' },
      h('h2', null, fileName),
      library.choices.length > 1
        ? h('label', { class: 'field' }, h('span', null, 'What to import'), h('span', { class: 'select wide' }, select))
        : h('p', null, `${songs(choice.songs.length)} found.`),
      leftOut.length > 0 ? h('p', { class: 'caption' }, `Left out of the file’s entries: ${leftOut.join(', ')}.`) : null,
      h(
        'p',
        { class: 'caption' },
        `Looking up ${songs(choice.songs.length)} usually takes ${duration(choice.songs.length * TYPICAL_MS)}, because MusicBrainz allows one request a second. ` +
          'Keep this tab open while it runs. You can pause it, and it carries on from where it stopped if the page is closed.' +
          (library.choices.length > 1 && choice.songs.length > 1_500 ? ' A playlist is a quicker way to try it out.' : ''),
      ),
      existing
        ? h('p', { class: 'problem' }, `This replaces the library imported before (${songs(existing.counts.total)}) and everything looked up for it.`)
        : null,
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            class: 'button filled',
            type: 'button',
            onClick: () => {
              app.importLibrary(choice.songs, { fileName, choice: choice.name });
              chosen = null;
              replacing = false;
              render();
              toast(`Imported ${songs(choice.songs.length)}. Looking up credits…`);
            },
          },
          `Import ${songs(choice.songs.length)}`,
        ),
        h(
          'button',
          {
            class: 'button text',
            type: 'button',
            onClick: () => {
              chosen = null;
              render();
            },
          },
          'Choose another file',
        ),
      ),
    );
  }

  // --- the imported library -------------------------------------------------------------------------

  /** Built once and then updated in place, so that a press on a button is never lost to a redraw. */
  function statusCards(): HTMLElement[] {
    const title = h('h2');
    const source = h('p', { class: 'caption' });
    const fill = h('span', { class: 'bar-fill' });
    const track = h('div', { class: 'bar-track progress', role: 'progressbar', 'aria-label': 'Songs looked up', 'aria-valuemin': '0' }, fill);
    const summary = h('p', { class: 'progress-summary' });
    const detail = h('p', { class: 'caption', 'aria-live': 'off' });
    const warning = h('p', { class: 'problem', role: 'alert', hidden: true });
    const toggle = h('button', { class: 'button tonal', type: 'button' });
    const reload = h('button', { class: 'button tonal', type: 'button', hidden: true, onClick: () => location.reload() }, 'Reload this tab');
    const results = h('div', { class: 'list' });
    const retryFailed = h('button', { class: 'button tonal', type: 'button', hidden: true, onClick: () => store.retryFailed() });
    const actions = h('div', { class: 'button-row' }, toggle, reload, retryFailed);
    const resultsTitle = h('h2');
    const mine = chip('Your library', false, () => app.showLibrary('mine'));
    const demo = chip('Demo library', false, () => app.showLibrary('demo'));

    toggle.addEventListener('click', () => {
      const status = store.status;
      if (!status) return;
      if (status.state === 'running') store.pause();
      else store.resume();
    });

    const resultRow = (label: string, hint: string, color: string, filter: Status) => {
      const value = h('span', { class: 'row-trailing' });
      const rowElement = h(
        'button',
        { class: 'row-main', type: 'button', onClick: () => showLibraryStatus(app, filter) },
        h('span', { class: 'dot', style: { '--dot': color } }),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, label), h('span', { class: 'row-subtitle' }, hint)),
        value,
      );
      const wrapper = h('div', { class: 'row' }, rowElement);
      results.appendChild(wrapper);
      return (n: number) => {
        value.textContent = count(n);
        wrapper.hidden = n === 0;
      };
    };
    const setWithCredits = resultRow('Matched, with credits', 'These are what the Universe is drawn from.', STATUS_COLORS.ok, 'matched');
    const setNoCredits = resultRow('Matched, no credits listed', 'MusicBrainz knows the song but nobody has entered who made it.', STATUS_COLORS.warn, 'noCredits');
    const setReview = resultRow('Needs review', 'A possible match was found. Open one to confirm or reject it.', STATUS_COLORS.warn, 'review');
    const setUnmatched = resultRow('Not matched', 'Nothing on MusicBrainz was close enough to trust.', STATUS_COLORS.none, 'unmatched');
    const setFailed = resultRow('Lookup failed', 'MusicBrainz answered with an error. These can be tried again.', STATUS_COLORS.error, 'failed');
    const setWaiting = resultRow('Waiting', 'Not looked up yet.', STATUS_COLORS.pending, 'waiting');

    refreshStatus = () => {
      const status = store.status;
      if (!status) return;
      const { counts, meta, state } = status;
      const done = counts.total - counts.remaining;
      const finished = counts.remaining === 0;

      title.textContent = meta.choice;
      source.textContent = `${songs(counts.total)} from ${meta.fileName}, imported ${new Date(meta.importedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
      fill.style.width = `${counts.total === 0 ? 0 : (done * 100) / counts.total}%`;
      track.setAttribute('aria-valuemax', String(counts.total));
      track.setAttribute('aria-valuenow', String(done));
      summary.textContent = describeProgress(status);

      detail.textContent = finished
        ? 'Songs that were matched with credits are on the map. The rest stay in the library and are never given invented credits.'
        : state === 'running'
          ? status.current
            ? `Looking up “${status.current}”. Keep this tab open; the map fills in as it goes.`
            : 'Starting…'
          : state === 'offline'
            ? 'MusicBrainz can’t be reached right now. Trying again every minute, and as soon as this device is back online.'
            : state === 'elsewhere'
              ? 'Another tab of this site is looking these songs up. This tab shows the library as it was when it was opened, and changes made here aren’t saved. Reload it once the other tab is closed.'
              : 'Nothing is being looked up. It carries on from here when you resume.';

      warning.hidden = !status.saveFailed;
      warning.textContent = 'This browser wouldn’t store the library: its storage is full or blocked for this site. The lookups continue, but they will be lost when the page is closed.';

      toggle.hidden = finished || state === 'elsewhere';
      toggle.textContent = state === 'running' ? 'Pause' : state === 'offline' ? 'Try now' : 'Resume';
      reload.hidden = state !== 'elsewhere';

      setWithCredits(counts.withCredits);
      setNoCredits(counts.noCredits);
      setReview(counts.needsReview);
      setUnmatched(counts.unmatched);
      setFailed(counts.failed);
      setWaiting(counts.remaining);
      retryFailed.hidden = counts.failed === 0;
      retryFailed.textContent = `Retry ${plural(counts.failed, 'failed lookup')}`;
      actions.hidden = toggle.hidden && reload.hidden && retryFailed.hidden;
      resultsTitle.textContent = finished ? 'Results' : 'Results so far';

      mine.setAttribute('aria-pressed', String(store.showing === 'mine'));
      demo.setAttribute('aria-pressed', String(store.showing === 'demo'));
    };
    refreshStatus();

    const action = (name: string, hint: string, button: HTMLElement) => h('div', { class: 'action-row' }, h('div', null, h('strong', null, name), h('small', null, hint)), button);

    return [
      h('section', { class: 'card' }, title, source, track, summary, detail, warning, actions),
      h('section', { class: 'card flush' }, resultsTitle, results),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Showing'),
        h('p', { class: 'caption' }, 'Universe, Library, Insights and Share all show the library chosen here. The lookups go on either way.'),
        h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'Library to show' }, mine, demo),
        h('a', { class: 'button tonal', href: links.universe }, icon('universe'), 'Open Universe'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Manage'),
        action(
          'Import another file',
          'Replaces this library, for example with a fresh export or a different playlist.',
          h(
            'button',
            {
              class: 'button tonal',
              type: 'button',
              onClick: () => {
                replacing = true;
                render();
                window.scrollTo(0, 0);
              },
            },
            'Choose file…',
          ),
        ),
        action('Delete my library', 'Removes the imported songs and their credits from this browser.', deleteLibraryButton(app)),
      ),
    ];
  }

  function render(): void {
    refreshStatus = null;
    if (chosen) setChildren(body, previewCard());
    else if (!store.status || replacing) setChildren(body, fileCard());
    else setChildren(body, statusCards());
  }

  render();
  return {
    element,
    onProgress() {
      // The library was imported, replaced or deleted (possibly from another page's action): start over.
      if (refreshStatus && store.status) refreshStatus();
      else if (!chosen && !replacing && !reading) render();
    },
  };
}
