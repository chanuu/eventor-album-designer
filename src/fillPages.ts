/** The most of a photo that may be lost to fill a whole spread with it. */
const MOST_CROP = 0.5;

/** Whether one photo can fill both pages without losing too much of it. */
export function fillsSpread(photoAspect: number, spreadAspect: number): boolean {
  return 1 - Math.min(photoAspect, spreadAspect) / Math.max(photoAspect, spreadAspect) <= MOST_CROP;
}

/**
 * Leaves no page of an album blank. A photo alone on a spread stays alone only if it can
 * fill both pages. Any other gets a companion from the spread beside it, so the photos
 * stay in order and, where a neighbour can spare one, so does the number of spreads.
 */
export function fillPages<T>(spreads: T[][], fits: (photo: T) => boolean): T[][] {
  const made = spreads.filter((s) => s.length > 0).map((s) => [...s]);
  for (let i = 0; i < made.length; i += 1) {
    if (made[i].length !== 1 || fits(made[i][0])) continue;
    const before = made[i - 1];
    const after = made[i + 1];
    const spare = (s?: T[]) => (s && s.length >= 3 ? s.length : 0);
    if (spare(before) || spare(after)) {
      if (spare(after) >= spare(before)) made[i].push(after.shift()!);
      else made[i].unshift(before.pop()!);
    } else if (after && (!before || after.length <= before.length)) {
      after.unshift(...made[i]);
      made.splice(i, 1);
      i -= 1;
    } else if (before) {
      before.push(...made[i]);
      made.splice(i, 1);
      i -= 1;
    }
  }
  return made;
}
