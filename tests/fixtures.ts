import demoFile from '../src/data/demo-library.json';
import { AnalysisData, loadLibrary, type LibraryFile } from '../src/model/data';
import type { Creator, Credit, CreditsStatus, GenreTag, ItemKind, LibraryItem, MatchStatus, Role } from '../src/model/types';

export const demo = demoFile as unknown as LibraryFile;

export function demoData(excluded: string[] = []): AnalysisData {
  return loadLibrary(demo, new Set(excluded));
}

export function item(
  id: string,
  options: {
    kind?: ItemKind;
    year?: number;
    included?: boolean;
    match?: MatchStatus;
    credits?: CreditsStatus;
  } = {},
): LibraryItem {
  return {
    id,
    kind: options.kind ?? 'SONG',
    title: id,
    artist: 'Artist',
    year: options.year,
    matchStatus: options.match ?? 'MATCHED',
    creditsStatus: options.credits ?? 'FETCHED',
    included: options.included ?? true,
  };
}

export function credit(itemId: string, creatorId: string, role: Role, detail = ''): Credit {
  return { itemId, creatorId, role, detail, scope: role === 'SONGWRITER' ? 'WORK' : 'RECORDING', trackCount: 0 };
}

/** Builds analysis data in which every creator mentioned in a credit exists, named after its id. */
export function library(items: LibraryItem[], credits: Credit[], genres: GenreTag[] = []): AnalysisData {
  const creators = new Map<string, Creator>();
  for (const c of credits) creators.set(c.creatorId, { id: c.creatorId, name: c.creatorId });
  return new AnalysisData(items, creators, credits, genres);
}
