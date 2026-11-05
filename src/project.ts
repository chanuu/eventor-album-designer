import { openAlbum, suggestLayouts, type PhotoInfo, type Project, type Spread } from './api';
import type { Album } from './App';

export const ALBUM_EXTENSION = 'evalbum';
export const ALBUM_FILTERS = [{ name: 'Eventor album', extensions: [ALBUM_EXTENSION] }];

const PROJECT_VERSION = 1;

export function toProject(album: Album, photos: PhotoInfo[], spreads: Spread[]): Project {
  return {
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

  return {
    name: project.name,
    spec: project.spec,
    sizeLabel: project.size_label,
    path,
    photos: project.photos,
    spreads,
    missing,
  };
}
