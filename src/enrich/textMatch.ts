import { SIMPLIFIED, TRADITIONAL } from './hanTable';

// Text comparison used to decide whether a MusicBrainz candidate is the same work as a library item.

// Decorations a store adds to a title that MusicBrainz usually keeps out of it. Deliberately
// narrow: "(Taylor's Version)", "(Live)" or "(Acoustic)" name different recordings and stay.
const FEATURING = /\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi;
const REMASTER_PAREN = /\s*[(\[][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi;
const REMASTER_DASH = /\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?\s*$/i;
const DIACRITICS = /[\u0300-\u036f]+/g;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const ARTIST_SPLIT = /\s*(?:,|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\band\b)\s*/i;

export function stripDecorations(title: string): string {
  return title.replace(FEATURING, '').replace(REMASTER_PAREN, '').replace(REMASTER_DASH, '').trim();
}

const HAN = /[\u3400-\u9fff]/;
let simplifiedOf: Map<string, string> | null = null;

/**
 * Writes Chinese in simplified characters. A streaming service shows 周杰伦 where MusicBrainz,
 * following the record sleeve, has 周杰倫; they are the same name and must compare as equal.
 */
function simplifyHan(text: string): string {
  if (!HAN.test(text)) return text;
  simplifiedOf ??= new Map([...TRADITIONAL].map((character, i) => [character, SIMPLIFIED[i]]));
  let result = '';
  for (const character of text) result += simplifiedOf.get(character) ?? character;
  return result;
}

/** Lowercased, accent-free, punctuation collapsed to single spaces, Chinese in simplified characters. */
export function normalize(text: string): string {
  return simplifyHan(text.normalize('NFKD').replace(DIACRITICS, '').toLowerCase().replaceAll('&', ' and ').replace(NON_WORD, ' ').trim());
}

export const normalizeTitle = (title: string): string => normalize(stripDecorations(title));

/** 1 for identical normalized strings, falling towards 0 with edit distance. */
export function similarity(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export const titleSimilarity = (a: string, b: string): number => similarity(normalizeTitle(a), normalizeTitle(b));

/**
 * How well a library artist string matches a MusicBrainz artist credit. Stores write
 * collaborations many ways ("A & B", "A, B", "A feat. B"), so the best of the whole-string
 * comparison and the lead-artist comparison is used.
 *
 * @param aliases other names MusicBrainz records for the credited artists, such as "Jay Chou" for
 *   周杰倫. An alias counts only when it is the library's name exactly: it is already a variant,
 *   and something merely close to a variant is not evidence.
 */
export function artistSimilarity(libraryArtist: string, creditNames: string[], creditJoined: string, aliases: string[] = []): number {
  const library = normalize(libraryArtist);
  if (library === '' || creditNames.length === 0) return 0;
  const credits = creditNames.map(normalize);
  const known = new Set(aliases.map(normalize));
  let best = known.has(library) ? 1 : similarity(library, normalize(creditJoined));
  for (const credit of credits) best = Math.max(best, similarity(library, credit));
  const lead = leadArtist(libraryArtist);
  if (lead !== null) {
    const leadName = normalize(lead);
    // A lead-only match is weaker evidence than a full match, so it is capped.
    for (const credit of credits) best = Math.max(best, Math.min(0.9, similarity(leadName, credit)));
    if (known.has(leadName)) best = Math.max(best, 0.9);
  }
  return best;
}

/** The first named artist of a multi-artist string, or null if there is only one. */
export function leadArtist(artist: string): string | null {
  const parts = artist
    .split(ARTIST_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length > 1 ? parts[0] : null;
}

/** 1 within 3 s, tapering to 0 beyond 15 s. Unknown durations are neutral. */
export function durationSimilarity(aMs: number | null | undefined, bMs: number | null | undefined): number {
  if (aMs == null || bMs == null) return 0.5;
  const difference = Math.abs(aMs - bMs);
  if (difference <= 3_000) return 1;
  if (difference <= 7_000) return 0.7;
  if (difference <= 15_000) return 0.3;
  return 0;
}

/** Escapes a value for use inside a quoted Lucene phrase. */
export const lucenePhrase = (text: string): string => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
