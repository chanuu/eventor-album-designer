import { openAlbum, suggestLayouts, type PhotoInfo, type Project, type PublishLink, type Rating, type Spread } from './api';
import type { Album } from './App';

export const ALBUM_EXTENSION = 'evalbum';
export const ALBUM_FILTERS = [{ name: 'Eventor album', extensions: [ALBUM_EXTENSION] }];

const PROJECT_VERSION = 1;
const RECENT_KEY = 'recent-albums';
const MAX_RECENT = 8;

export type RecentAlbum = { path: string; name: string };

/** A convenience only, so failing to read or write it must never get in the way. */
export function recentAlbums(): RecentAlbum[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(stored) ? (stored as RecentAlbum[]) : [];
  } catch {
    return [];
  }
}

export function rememberAlbum(path: string, name: string) {
  try {
    const others = recentAlbums().filter((item) => item.path !== path);
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ path, name }, ...others].slice(0, MAX_RECENT)));
  } catch {
    // The list simply stays as it was.
  }
}

export function toProject(
  album: Album,
  photos: PhotoInfo[],
  spreads: Spread[],
  ratings: Record<string, Rating>,
  publish: PublishLink | null,
): Project {
  return {
    ratings,
    publish,
    version: PROJECT_VERSION,
    name: album.name,
    size_label: album.sizeLabel,
    spec: album.spec,
    photos,
    spreads: spreads.map((s) => ({
      id: s.id,
      photo_ids: s.photoIds,
      option_index: s.optionIndex,
      design: s.design,
    })),
  };
}

/** Opens an album file, keeping each spread exactly as it was saved. */
export async function loadAlbum(path: string): Promise<Album> {
  const { project, missing } = await openAlbum(path);
  const byId = new Map(project.photos.map((p) => [p.id, p]));

  const spreads = await Promise.all(
    project.spreads.map(async (saved): Promise<Spread> => {
      const list = saved.photo_ids.flatMap((id) => byId.get(id) ?? []);
      // Alternatives are not saved, since packs may have changed since. The saved
      // design stays on screen until the photographer chooses another layout.
      const options = await suggestLayouts(list, project.spec);
      const at = options.findIndex((o) => o.template_id === saved.design.template_id);
      return {
        id: saved.id,
        photoIds: saved.photo_ids,
        options,
        optionIndex: Math.max(0, at),
        design: saved.design,
      };
    }),
  );

  rememberAlbum(path, project.name);
  return {
    name: project.name,
    spec: project.spec,
    sizeLabel: project.size_label,
    path,
    photos: project.photos,
    spreads,
    missing,
    ratings: project.ratings,
    publish: project.publish ?? null,
  };
}
