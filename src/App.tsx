import { useState } from 'react';
import type { ProjectSpec } from './api';
import NewAlbum from './NewAlbum';
import Workspace from './Workspace';

export type Album = { name: string; spec: ProjectSpec; sizeLabel: string };

export default function App() {
  const [album, setAlbum] = useState<Album | null>(null);
  return album ? <Workspace album={album} /> : <NewAlbum onCreate={setAlbum} />;
}
