import type { CreditScope, Role } from '../model/types';
import type { MbArtist, MbArtistCredit, MbRelation } from './musicbrainz';

/** A credit as read from MusicBrainz, before it is tied to a library item. */
export interface RawCredit {
  artist: MbArtist;
  role: Role;
  detail: string;
  scope: CreditScope;
}

// Translates MusicBrainz relationship types into the app's roles. Only relationship types listed
// here become credits. Anything else (photography, publishing, copyright holders, ...) is ignored
// rather than guessed at.

const WRITER_TYPES = new Set(['composer', 'lyricist', 'writer', 'librettist']);

const MUSICIAN_TYPES: Record<string, string> = {
  instrument: 'instrument',
  vocal: 'vocals',
  performer: 'performer',
  'performing orchestra': 'orchestra',
  conductor: 'conductor',
  concertmaster: 'concertmaster',
  'chorus master': 'chorus master',
};

// Real credits that sit outside the four graph roles. Kept for the Credits page only.
const OTHER_TYPES: Record<string, string> = {
  engineer: 'engineer',
  mix: 'mixing',
  recording: 'recording engineer',
  mastering: 'mastering',
  programming: 'programming',
  arranger: 'arranger',
  'instrument arranger': 'instrument arranger',
  'vocal arranger': 'vocal arranger',
  orchestrator: 'orchestrator',
  remixer: 'remixer',
  editor: 'editor',
  sound: 'sound engineer',
  balance: 'balance engineer',
};

// Qualifiers MusicBrainz attaches as attributes rather than as part of the type name.
const QUALIFIERS = ['executive', 'co', 'additional', 'assistant', 'associate', 'guest', 'solo'];

// MusicBrainz placeholder artists such as [unknown] or Various Artists. Not real people.
const VARIOUS_ARTISTS = '89ad4ac3-39f7-470e-963a-56509c546377';

export function isRealArtist(artist: MbArtist): boolean {
  const name = artist.name ?? '';
  return artist.id !== VARIOUS_ARTISTS && name.trim() !== '' && !name.startsWith('[');
}

export function fromArtistCredit(credit: MbArtistCredit[] | undefined, scope: CreditScope): RawCredit[] {
  return (credit ?? [])
    .map((c) => c.artist)
    .filter(isRealArtist)
    .map((artist) => ({ artist, role: 'ARTIST', detail: '', scope }));
}

/**
 * @param scope where direct artist relationships were stated. Writers reached through a linked
 *   work are always reported as stated on the work.
 */
export function fromRelations(relations: MbRelation[] | undefined, scope: CreditScope): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const add = (credit: RawCredit) => {
    const key = [credit.artist.id, credit.role, credit.detail, credit.scope].join('\n');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(credit);
  };
  for (const relation of relations ?? []) {
    const artist = relation.artist;
    if (artist) {
      const mapped = isRealArtist(artist) ? map(relation) : null;
      if (mapped) add({ artist, ...mapped, scope });
      continue;
    }
    if (!relation.work || relation.type !== 'performance') continue;
    for (const workRelation of relation.work.relations ?? []) {
      const writer = workRelation.artist;
      const type = workRelation.type ?? '';
      if (!writer || !isRealArtist(writer) || !WRITER_TYPES.has(type)) continue;
      add({ artist: writer, role: 'SONGWRITER', detail: qualify(type, workRelation.attributes ?? []), scope: 'WORK' });
    }
  }
  return out;
}

function map(relation: MbRelation): { role: Role; detail: string } | null {
  const type = relation.type ?? '';
  const attributes = relation.attributes ?? [];
  if (type === 'producer') return { role: 'PRODUCER', detail: qualify('producer', attributes) };
  if (WRITER_TYPES.has(type)) return { role: 'SONGWRITER', detail: qualify(type, attributes) };
  if (type === 'instrument' || type === 'vocal') {
    // Attributes name the instrument or voice ("guitar", "lead vocals").
    const named = attributes.filter((attribute) => !QUALIFIERS.includes(attribute));
    return { role: 'MUSICIAN', detail: qualify(named.length === 0 ? MUSICIAN_TYPES[type] : named.join(', '), attributes) };
  }
  if (Object.hasOwn(MUSICIAN_TYPES, type)) return { role: 'MUSICIAN', detail: qualify(MUSICIAN_TYPES[type], attributes) };
  if (Object.hasOwn(OTHER_TYPES, type)) return { role: 'OTHER', detail: qualify(OTHER_TYPES[type], attributes) };
  return null;
}

/** "producer" + ["co"] -> "co-producer"; "engineer" + ["assistant"] -> "assistant engineer". */
function qualify(base: string, attributes: string[]): string {
  let out = base;
  for (const qualifier of QUALIFIERS) {
    if (attributes.includes(qualifier)) out = qualifier === 'co' ? `co-${out}` : `${qualifier} ${out}`;
  }
  return out;
}
