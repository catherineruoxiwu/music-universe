type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

/**
 * Creates an element. Props starting with "on" are event listeners; `true` sets a bare attribute;
 * `false`, `null` and `undefined` are skipped; anything else is set as an attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [name, v] of Object.entries(value as Record<string, string>)) element.style.setProperty(name, v);
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replaces everything inside `parent`. */
export function setChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

// Drawn by hand on a 24-unit grid with one stroke weight, so they sit together as a set.
const ICONS = {
  universe: '<circle cx="12" cy="5.5" r="2.5"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M10.8 7.7 6.7 15.3M13.2 7.7l4.1 7.6M8 17.5h8"/>',
  library: '<path d="M5 4v16M9.5 4v16"/><path d="m13.5 6.2 3.6-1 3.4 13.6-3.6 1z"/>',
  insights: '<path d="M5 20v-7M12 20V4M19 20v-11"/>',
  share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.7 6.6-3.9M8.7 13.3l6.6 3.9"/>',
  about: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="M20 12H5M11 5.5 4.5 12l6.5 6.5"/>',
  forward: '<path d="M4 12h15M13 5.5l6.5 6.5-6.5 6.5"/>',
  more: '<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.2"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

/** A button that shows only an icon; `label` is what assistive technology and the tooltip say. */
export function iconButton(name: IconName, label: string, onClick: (event: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
  return h('button', { class: `icon-button ${extraClass}`.trim(), type: 'button', 'aria-label': label, title: label, onClick }, icon(name));
}

/** A pill that is either on or off. */
export function chip(label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(selected), onClick }, label);
}

let toastTimer = 0;

/** A short confirmation at the bottom of the window that goes away by itself. */
export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const element = h('div', { class: 'toast', role: 'status' }, message);
  document.body.appendChild(element);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.remove(), 3200);
}

/** Asks before something that cannot be undone. Resolves true only on the confirming button. */
export function confirmDialog(title: string, body: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h(
      'dialog',
      { class: 'dialog' },
      h('h2', null, title),
      h('p', null, body),
      h(
        'form',
        { method: 'dialog', class: 'dialog-actions' },
        h('button', { class: 'button text', value: 'cancel' }, 'Cancel'),
        h('button', { class: 'button danger', value: 'confirm' }, confirmLabel),
      ),
    );
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

interface MenuItem {
  label: string;
  onSelect: () => void;
}

/** A small menu that drops from `anchor` and closes on a choice, an outside click or Escape. */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  document.querySelector('.menu')?.remove();
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((item) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            close();
            item.onSelect();
          },
        },
        item.label,
      ),
    ),
  );
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
  };
  const onOutside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
    anchor.focus();
  };
  document.body.appendChild(menu);

  // Dropped below the anchor and right-aligned to it, but kept inside the window.
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(box.right - width, 8), window.innerWidth - width - 8);
  const top = box.bottom + height + 8 > window.innerHeight ? box.top - height - 4 : box.bottom + 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(top, 8)}px`;
  (menu.firstElementChild as HTMLElement | null)?.focus();

  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
}
