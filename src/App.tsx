import { useState } from 'react';
import type { PhotoInfo, ProjectSpec, Rating, Spread } from './api';
import NewAlbum from './NewAlbum';
import Workspace from './Workspace';

export type Album = {
  name: string;
  spec: ProjectSpec;
  sizeLabel: string;
  /** Where it is saved, or null if it never has been. */
  path: string | null;
  photos: PhotoInfo[];
  spreads: Spread[];
  /** Photos whose original file could not be found when the album was opened. */
  missing: string[];
  /** Ratings set by hand. */
  ratings: Record<string, Rating>;
};

export default function App() {
  const [album, setAlbum] = useState<Album | null>(null);
  return album ? <Workspace album={album} /> : <NewAlbum onCreate={setAlbum} />;
}
