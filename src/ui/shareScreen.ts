import { isDefaultFilter, type GraphFilter } from '../graph/graph';
import { POSTER_THEMES } from '../graph/theme';
import { GRAPHED, rolePlural, type Role } from '../model/types';
import { POSTER_SIZE, renderPoster, type PosterRatio, type PosterSpec } from '../share/poster';
import { links, type App, type Page } from './app';
import { chip, h, icon, setChildren, toast } from './dom';

/** Width the preview is drawn at; the export is drawn from the same spec at full size. */
const PREVIEW_WIDTH = 1080;

interface Options {
  ratio: PosterRatio;
  themeId: string;
  filter: GraphFilter;
  showNames: boolean;
  showStats: boolean;
  showNickname: boolean;
  nickname: string;
}

/** Turns the map into a poster: choose its shape, colours and what is printed, then save it. */
export function createSharePage(app: App): Page {
  const { store } = app;
  // Taken once, when the studio opens, so that what is saved is exactly what was previewed.
  const snapshot = store.snapshot;

  if (snapshot.graph.nodes.length === 0) {
    return {
      element: h(
        'div',
        { class: 'page' },
        h('header', { class: 'page-header' }, h('div', { class: 'page-title' }, h('h1', null, 'Share Studio'))),
        h(
          'div',
          { class: 'empty-state' },
          h('h2', null, 'Nothing to put on a poster yet'),
          h('p', null, 'Every work is excluded from analysis. Include some in Library first.'),
          h('a', { class: 'button filled', href: links.library }, 'Open Library'),
        ),
      ),
    };
  }

  // Starts from whatever the Universe was showing; later changes here stay in the studio.
  const options: Options = {
    ratio: 'SQUARE',
    themeId: POSTER_THEMES[0].id,
    filter: store.filter,
    showNames: true,
    showStats: true,
    showNickname: store.nickname !== '',
    nickname: store.nickname,
  };

  function spec(): PosterSpec {
    const analysed = snapshot.data.analysedItems;
    const withCredits = analysed.filter((item) => item.matchStatus === 'MATCHED' && item.creditsStatus === 'FETCHED').length;
    const name = options.nickname.trim();
    const stats = snapshot.graph.stats;
    const { filter } = options;
    return {
      snapshot,
      filter,
      theme: POSTER_THEMES.find((theme) => theme.id === options.themeId) ?? POSTER_THEMES[0],
      ratio: options.ratio,
      showNames: options.showNames,
      showStats: options.showStats,
      text: {
        title: options.showNickname && name !== '' ? `${name}’s Music Universe` : 'A Music Universe',
        subtitle:
          `${filter.role ? rolePlural(filter.role) : 'Everyone'} credited on the music in ${store.showing === 'mine' ? 'my library' : 'a demo library'}` +
          (filter.sharedOnly ? ' · shared connections only' : ''),
        worksLabel: !isDefaultFilter(filter) ? 'Linked works' : stats.albums === 0 ? 'Songs' : stats.songs === 0 ? 'Albums' : 'Works',
        coverage: `Credits found for ${withCredits} of ${analysed.length} works · Data: MusicBrainz`,
        credit: 'Music Universe',
      },
    };
  }

  const preview = h('div', { class: 'poster-preview' });
  const controls = h('div', { class: 'poster-controls' });
  const nicknameInput = h('input', {
    class: 'text-input',
    type: 'text',
    maxlength: '24',
    placeholder: 'Name to print on the poster',
    'aria-label': 'Nickname',
    value: options.nickname,
  });
  nicknameInput.addEventListener('input', () => {
    options.nickname = nicknameInput.value;
    store.nickname = nicknameInput.value.trim();
    renderPreview();
  });

  function renderPreview(): void {
    const canvas = renderPoster(spec(), PREVIEW_WIDTH);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Poster preview');
    preview.dataset.ratio = options.ratio.toLowerCase();
    setChildren(preview, canvas);
  }

  function change(next: Partial<Options>): void {
    Object.assign(options, next);
    render();
  }

  function toBlob(): Promise<Blob | null> {
    const canvas = renderPoster(spec(), POSTER_SIZE[options.ratio].width);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function fileName(): string {
    const now = new Date();
    const two = (value: number) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    return `MusicUniverse-${stamp}.png`;
  }

  async function save(): Promise<void> {
    const blob = await toBlob();
    if (blob === null) {
      toast('Couldn’t prepare the image. Try again.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const name = fileName();
    const link = h('a', { href: url, download: name, hidden: true });
    document.body.appendChild(link);
    link.click();
    link.remove();
    // The download has been handed to the browser by the time this runs.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`Saved as ${name}`);
  }

  /** The file to hand to the system share sheet, or null where the browser cannot share files. */
  const shareable = (blob: Blob) => {
    const file = new File([blob], fileName(), { type: 'image/png' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }) ? file : null;
  };
  const canShareFiles = shareable(new Blob([], { type: 'image/png' })) !== null;

  async function share(): Promise<void> {
    const blob = await toBlob();
    const file = blob === null ? null : shareable(blob);
    if (file === null) {
      toast('Couldn’t prepare the image. Try again.');
      return;
    }
    try {
      await navigator.share({ files: [file], title: 'Music Universe' });
    } catch (error) {
      // Closing the share sheet without choosing anything is not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) toast('Couldn’t share the image. Save it instead.');
    }
  }

  function render(): void {
    const { filter } = options;
    const group = (label: string, ...children: (HTMLElement | null)[]) =>
      h('div', { class: 'control-group', role: 'group', 'aria-label': label }, h('h2', null, label), h('div', { class: 'chips wrap' }, children));
    const roleChip = (label: string, role: Role | null) => chip(label, filter.role === role, () => change({ filter: { ...filter, role } }));

    nicknameInput.hidden = !options.showNickname;
    setChildren(
      controls,
      group(
        'Shape',
        chip('Square 1:1', options.ratio === 'SQUARE', () => change({ ratio: 'SQUARE' })),
        chip('Story 9:16', options.ratio === 'STORY', () => change({ ratio: 'STORY' })),
      ),
      group('Theme', ...POSTER_THEMES.map((theme) => chip(theme.name, options.themeId === theme.id, () => change({ themeId: theme.id })))),
      group(
        'Map',
        roleChip('Full', null),
        ...GRAPHED.map((role) => roleChip(rolePlural(role), role)),
        chip('Shared Only', filter.sharedOnly, () => change({ filter: { ...filter, sharedOnly: !filter.sharedOnly } })),
      ),
      group(
        'Show',
        chip('Names', options.showNames, () => change({ showNames: !options.showNames })),
        chip('Stats', options.showStats, () => change({ showStats: !options.showStats })),
        chip('Nickname', options.showNickname, () => {
          change({ showNickname: !options.showNickname });
          if (options.showNickname) nicknameInput.focus();
        }),
      ),
      nicknameInput,
      h(
        'div',
        { class: 'poster-actions' },
        h('button', { class: 'button filled', type: 'button', onClick: save }, icon('download'), 'Save image'),
        canShareFiles ? h('button', { class: 'button tonal', type: 'button', onClick: share }, icon('share'), 'Share') : null,
      ),
      h(
        'p',
        { class: 'note' },
        `Saved as a ${POSTER_SIZE[options.ratio].width} × ${POSTER_SIZE[options.ratio].height} PNG. The poster is drawn in this browser; nothing is uploaded.`,
      ),
    );
    renderPreview();
  }

  const element = h(
    'div',
    { class: 'page wide' },
    h(
      'header',
      { class: 'page-header' },
      h('div', { class: 'page-title' }, h('h1', null, 'Share Studio'), h('p', { class: 'subtitle' }, 'Turn the map into a poster')),
    ),
    h('div', { class: 'studio' }, preview, controls),
  );

  render();
  return { element };
}
