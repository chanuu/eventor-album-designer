/**
 * Where on this computer each gallery's photos were uploaded from.
 *
 * A path only means something on the computer it came from, so this stays here rather than
 * going to Eventor. Losing it only means being asked for the folder again.
 */

const KEY = 'gallery-folders';

function all(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return stored && typeof stored === 'object' ? (stored as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function galleryFolder(galleryId: string): string | null {
  const folder = all()[galleryId];
  return typeof folder === 'string' && folder ? folder : null;
}

export function rememberGalleryFolder(galleryId: string, folder: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...all(), [galleryId]: folder }));
  } catch {
    // Then the folder is simply asked for next time.
  }
}
