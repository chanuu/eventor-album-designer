import { invoke } from '@tauri-apps/api/core';

/** Shapes shared with the Rust side. Rust owns the rules; this only displays them. */

export type Binding = 'layflat' | 'magazine';

export type ProjectSpec = {
  trim_w_mm: number;
  trim_h_mm: number;
  bleed_mm: number;
  safe_mm: number;
  target_dpi: number;
  binding: Binding;
  margin_mm: number;
  gap_mm: number;
  paper: string;
};

export type Fit = { scale: number; cx: number; cy: number; rot_deg: number };

export type Adjustments = {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  saturation: number;
  black_and_white: boolean;
};

export type Frame = {
  id: string;
  rect_mm: { x: number; y: number; w: number; h: number };
  corner_radius_mm: number;
  asset_id: string | null;
  fit: Fit;
  adjust: Adjustments;
  z: number;
};

export type SpreadDesign = {
  v: number;
  template_id: string | null;
  size_mm: { w: number; h: number };
  background: { type: 'color'; value: string };
  frames: Frame[];
};

export type LayoutOption = {
  template_id: string;
  name: string;
  tags: string[];
  crop_loss: number;
  design: SpreadDesign;
};

export type PhotoInfo = {
  id: string;
  path: string;
  file_name: string;
  width: number;
  height: number;
  orientation: number;
};

/** A spread in the editor. `options` are worked out again when an album is opened. */
export type Spread = {
  id: string;
  photoIds: string[];
  options: LayoutOption[];
  optionIndex: number;
  design: SpreadDesign;
};

/** The album file's form of a spread. */
export type SavedSpread = {
  id: string;
  photo_ids: string[];
  option_index: number;
  design: SpreadDesign;
};

export type Project = {
  version: number;
  name: string;
  size_label: string;
  spec: ProjectSpec;
  photos: PhotoInfo[];
  spreads: SavedSpread[];
};

export type ScanResult = {
  photos: PhotoInfo[];
  skipped: { file_name: string; reason: string }[];
};

export type PrintOptions = {
  sizes_in: [number, number][];
  bleed_mm: number[];
  dpi: number[];
  margins_in: [string, number][];
  gaps_in: [string, number][];
  paper: string[];
  dpi_warn: number;
  dpi_too_low: number;
};

export type NewAlbumSettings = {
  open_width_in: number;
  height_in: number;
  binding: Binding;
  margin_in: number;
  gap_in: number;
  bleed_mm: number;
  target_dpi: number;
  paper: string;
};

export const printOptions = () => invoke<PrintOptions>('print_options');

export const makeSpec = (settings: NewAlbumSettings) =>
  invoke<ProjectSpec>('make_spec', { settings });

export const importFolder = (path: string) => invoke<ScanResult>('import_folder', { path });

export const suggestLayouts = (photos: PhotoInfo[], spec: ProjectSpec) =>
  invoke<LayoutOption[]>('suggest_layouts', {
    photos: photos.map((p) => ({ asset_id: p.id, aspect: p.width / p.height })),
    spec,
  });

export const saveAlbum = (path: string, project: Project) =>
  invoke<void>('save_album', { path, project });

export const openAlbum = (path: string) =>
  invoke<{ project: Project; missing: string[] }>('open_album', { path });

export const relinkPhotos = (folder: string, ids: string[]) =>
  invoke<PhotoInfo[]>('relink_photos', { folder, ids });

export type ExportIssue = {
  severity: 'blocker' | 'warning';
  spread: number | null;
  message: string;
};

export type ExportResult = { folder: string; files: string[] };

export const checkForExport = (project: Project) =>
  invoke<ExportIssue[]>('check_for_export', { project });

export const exportPrintFiles = (
  project: Project,
  folder: string,
  formats: { jpeg: boolean; pdf: boolean },
) => invoke<ExportResult>('export_print_files', { project, folder, formats });

/** Grid size and frame size. They match the two preview sizes Rust keeps. */
export const GRID_PREVIEW = 512;
export const EDIT_PREVIEW = 2048;

/** WebView2 serves custom schemes from http://<scheme>.localhost. */
const PREVIEW_ORIGIN = navigator.userAgent.includes('Windows')
  ? 'http://album.localhost'
  : 'album://localhost';

export function previewUrl(photoId: string, width: number, adjust?: Adjustments): string {
  const base = `${PREVIEW_ORIGIN}/preview/${photoId}?w=${width}`;
  if (!adjust) return base;
  const values = [
    adjust.exposure,
    adjust.contrast,
    adjust.highlights,
    adjust.shadows,
    adjust.temperature,
    adjust.tint,
    adjust.saturation,
    adjust.black_and_white ? 1 : 0,
  ];
  return values.every((v) => v === 0) ? base : `${base}&fx=${values.join(',')}`;
}
