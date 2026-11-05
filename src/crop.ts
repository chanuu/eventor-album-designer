import type { Fit, Frame, PhotoInfo } from './api';

const MM_PER_INCH = 25.4;

/**
 * The part of a photo a frame shows, as fractions of the photo.
 *
 * This runs on every pointer move, so it cannot wait on a call into Rust. It must
 * stay identical to visible_area in album-core, which the exporter will use.
 */
export function visibleArea(photoAspect: number, frameAspect: number, fit: Fit) {
  const scale = Math.max(1, fit.scale);
  const wider = photoAspect > frameAspect;
  const sw = (wider ? frameAspect / photoAspect : 1) / scale;
  const sh = (wider ? 1 : photoAspect / frameAspect) / scale;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  return {
    sx: clamp(fit.cx - sw / 2, 1 - sw),
    sy: clamp(fit.cy - sh / 2, 1 - sh),
    sw,
    sh,
  };
}

/** The resolution this photo will print at in this frame. */
export function effectiveDpi(photo: PhotoInfo, frame: Frame): number {
  const area = visibleArea(
    photo.width / photo.height,
    frame.rect_mm.w / frame.rect_mm.h,
    frame.fit,
  );
  return (photo.width * area.sw) / (frame.rect_mm.w / MM_PER_INCH);
}
