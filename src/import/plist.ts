/** A value in an XML property list. Dates and data are left as their text. */
export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

const TOKEN = /<(key|string|integer|real|date|data)>([^<]*)<\/\1>|<(true|false)\s*\/>|<(dict|array)>|<\/(dict|array)>|<(dict|array|string|data)\s*\/>/g;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Reads an XML property list, the format the Music app exports a library in. Covers what such a
 * file contains; it is not a general XML parser.
 *
 * @throws Error when the text is not a property list or is cut short.
 */
export function parsePlist(xml: string): PlistValue {
  const start = xml.indexOf('<plist');
  if (start < 0) throw new Error('Not a property list');
  const token = new RegExp(TOKEN.source, 'g');
  token.lastIndex = start;

  let root: PlistValue | undefined;
  const stack: { container: PlistValue[] | PlistDict; key: string | null }[] = [];
  const add = (value: PlistValue) => {
    const top = stack.at(-1);
    if (!top) {
      root ??= value;
    } else if (Array.isArray(top.container)) {
      top.container.push(value);
    } else if (top.key !== null) {
      top.container[top.key] = value;
      top.key = null;
    }
  };

  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    const [, type, text, flag, open, close, empty] = match;
    if (type === 'key') {
      const top = stack.at(-1);
      if (top && !Array.isArray(top.container)) top.key = decode(text);
    } else if (type === 'integer' || type === 'real') {
      add(Number(text));
    } else if (type) {
      add(decode(text));
    } else if (flag) {
      add(flag === 'true');
    } else if (open || empty === 'dict' || empty === 'array') {
      // No prototype, so that a key such as "constructor" is only ever a key.
      const container: PlistValue[] | PlistDict = (open ?? empty) === 'array' ? [] : (Object.create(null) as PlistDict);
      add(container);
      if (open) stack.push({ container, key: null });
    } else if (close) {
      stack.pop();
    } else {
      add('');
    }
  }
  if (root === undefined || stack.length > 0) throw new Error('Property list is incomplete');
  return root;
}
