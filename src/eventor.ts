import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publishSpread, type ProjectSpec, type PublishLink, type Project } from './api';

/**
 * The link to Eventor: who is signed in, their jobs, publishing and client comments.
 *
 * This uses only the public anon key, the same as the studio admin. What a person may
 * see or change is decided by the database's row-level security, for the account they
 * sign in with. Photos go straight to storage on a short-lived address from the
 * `storage` function, and the app never holds a storage key.
 */

const MM_PER_INCH = 25.4;

let client: SupabaseClient | null = null;

function eventor(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) throw new Error('This copy of the app was built without an Eventor connection.');
    client = createClient(url, key);
  }
  return client;
}

/** Both of these mean the database has not been updated for this version of the app. */
const NOT_UPDATED = new Set(['42703', '42P01', 'PGRST204', 'PGRST205']);

function plainError(error: { code?: string; message: string }): Error {
  if (error.code && NOT_UPDATED.has(error.code)) {
    return new Error('Eventor has not been updated for this feature yet, so this cannot be done for now.');
  }
  return new Error(error.message);
}

export type Staff = { id: string; studio_id: string; full_name: string | null };

async function staffFor(userId: string): Promise<Staff | null> {
  const { data, error } = await eventor()
    .from('staff')
    .select('id, studio_id, full_name')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw plainError(error);
  return data as Staff | null;
}

export async function currentStaff(): Promise<Staff | null> {
  const { data } = await eventor().auth.getSession();
  return data.session ? staffFor(data.session.user.id) : null;
}

export async function signIn(email: string, password: string): Promise<Staff> {
  const { data, error } = await eventor().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  const staff = await staffFor(data.user.id);
  if (!staff) {
    // A client's portal account also signs in successfully, and has no business here.
    await eventor().auth.signOut();
    throw new Error('That is not an active studio account.');
  }
  return staff;
}

export async function signOut(): Promise<void> {
  await eventor().auth.signOut();
}

export type EventorJob = {
  id: string;
  title: string;
  clientName: string;
  albumId: string | null;
  pageCount: number;
  /** Pages this album would lose, because they are not spreads of this album file. */
  pagesToReplace: number;
};

/** To-one embeds can come back as an object or as a list. */
function one<T>(raw: T | T[] | null | undefined): T | null {
  if (!raw) return null;
  return Array.isArray(raw) ? raw[0] ?? null : raw;
}

export async function listJobs(staff: Staff, spreadIds: string[]): Promise<EventorJob[]> {
  const { data, error } = await eventor()
    .from('jobs')
    .select('id, title, clients(full_name), albums(id, album_pages(id, source_spread_id))')
    .eq('studio_id', staff.studio_id)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw plainError(error);

  const ours = new Set(spreadIds);
  type Row = {
    id: string;
    title: string;
    clients: { full_name: string } | { full_name: string }[] | null;
    albums: AlbumRow | AlbumRow[] | null;
  };
  type AlbumRow = { id: string; album_pages: { id: string; source_spread_id: string | null }[] | null };
  return ((data ?? []) as unknown as Row[]).map((row) => {
    const album = one(row.albums);
    const pages = album?.album_pages ?? [];
    return {
      id: row.id,
      title: row.title,
      clientName: one(row.clients)?.full_name ?? 'No client',
      albumId: album?.id ?? null,
      pageCount: pages.length,
      pagesToReplace: pages.filter((p) => !p.source_spread_id || !ours.has(p.source_spread_id)).length,
    };
  });
}

async function uploadAddress(albumId: string): Promise<string> {
  const { data, error } = await eventor().functions.invoke('storage', {
    body: { items: [{ kind: 'album', parentId: albumId, ext: 'jpg', contentType: 'image/jpeg' }] },
  });
  const payload = data as { error?: string; tickets?: { uploadUrl: string; publicUrl: string }[] } | null;
  if (error || payload?.error) throw new Error(payload?.error ?? error?.message ?? 'Could not prepare the upload.');
  const ticket = payload?.tickets?.[0];
  if (!ticket) throw new Error('Could not prepare the upload.');
  // Asked for one at a time, since an address only lasts minutes and rendering takes time.
  return JSON.stringify(ticket);
}

async function ensureAlbum(staff: Staff, job: EventorJob): Promise<string> {
  if (job.albumId) return job.albumId;
  const { data, error } = await eventor()
    .from('albums')
    .insert({
      job_id: job.id,
      studio_id: staff.studio_id,
      title: job.title,
      cover_title: job.title,
      closing_title: 'With love',
    })
    .select('id')
    .single();
  if (error) throw plainError(error);
  return (data as { id: string }).id;
}

function printedSize(spec: ProjectSpec) {
  const inches = (mm: number) => Number((mm / MM_PER_INCH).toFixed(2));
  return {
    // The size as studios quote it: the open book, then its height.
    trim_width: inches(spec.trim_w_mm * 2),
    trim_height: inches(spec.trim_h_mm),
    trim_is_spread: true,
    page_aspect: Number((spec.trim_w_mm / spec.trim_h_mm).toFixed(4)),
  };
}

/**
 * Publishes the album to the job's digital album.
 *
 * Every image is uploaded before any row changes, so a failure part way leaves what the
 * client sees as it was. Pages are matched to spreads by id and updated in place, which
 * keeps their comments on them. The share link and sharing settings are not touched.
 */
export async function publishAlbum(
  staff: Staff,
  job: EventorJob,
  project: Project,
  onProgress: (done: number, total: number) => void,
): Promise<PublishLink> {
  const albumId = await ensureAlbum(staff, job);
  const total = project.spreads.length;

  const uploaded: { spreadId: string; url: string }[] = [];
  for (const spread of project.spreads) {
    const ticket = JSON.parse(await uploadAddress(albumId)) as { uploadUrl: string; publicUrl: string };
    const used = new Set(spread.design.frames.map((f) => f.asset_id));
    await publishSpread(
      { ...project, spreads: [spread], photos: project.photos.filter((p) => used.has(p.id)) },
      spread.id,
      ticket.uploadUrl,
    );
    uploaded.push({ spreadId: spread.id, url: ticket.publicUrl });
    onProgress(uploaded.length, total);
  }

  const db = eventor();
  const { data: existing, error: readError } = await db
    .from('album_pages')
    .select('id, source_spread_id')
    .eq('album_id', albumId)
    .eq('studio_id', staff.studio_id);
  if (readError) throw plainError(readError);
  const pages = (existing ?? []) as { id: string; source_spread_id: string | null }[];
  const bySpread = new Map(pages.map((p) => [p.source_spread_id, p.id]));

  for (const [index, item] of uploaded.entries()) {
    const change = { image_url: item.url, sort_order: index, is_spread: true };
    const pageId = bySpread.get(item.spreadId);
    const { error } = pageId
      ? await db.from('album_pages').update(change).eq('id', pageId).eq('studio_id', staff.studio_id)
      : await db.from('album_pages').insert({
        ...change,
        album_id: albumId,
        studio_id: staff.studio_id,
        source_spread_id: item.spreadId,
      });
    if (error) throw plainError(error);
  }

  const kept = new Set(uploaded.map((u) => u.spreadId));
  const stale = pages.filter((p) => !p.source_spread_id || !kept.has(p.source_spread_id)).map((p) => p.id);
  if (stale.length) {
    const { error } = await db.from('album_pages').delete().in('id', stale).eq('studio_id', staff.studio_id);
    if (error) throw plainError(error);
  }

  // Row-level security reports a refusal as no rows changed, not as an error.
  const { data: published, error: publishError } = await db
    .from('albums')
    .update({ ...printedSize(project.spec), status: 'published', published_at: new Date().toISOString() })
    .eq('id', albumId)
    .eq('studio_id', staff.studio_id)
    .select('id');
  if (publishError) throw plainError(publishError);
  if (!published?.length) throw new Error('Your account is not allowed to publish albums.');

  return { job_id: job.id, job_title: job.title, album_id: albumId };
}

export type ClientComment = {
  id: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  clientName: string;
  /** Null when the page has since been removed from the album. */
  spreadId: string | null;
};

export async function listComments(albumId: string, staff: Staff): Promise<ClientComment[]> {
  const { data, error } = await eventor()
    .from('album_comments')
    .select('id, body, created_at, resolved_at, clients(full_name), album_pages(source_spread_id)')
    .eq('album_id', albumId)
    .eq('studio_id', staff.studio_id)
    .order('created_at', { ascending: false });
  if (error) throw plainError(error);

  type Row = {
    id: string;
    body: string;
    created_at: string;
    resolved_at: string | null;
    clients: { full_name: string } | { full_name: string }[] | null;
    album_pages: { source_spread_id: string | null } | { source_spread_id: string | null }[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    clientName: one(row.clients)?.full_name ?? 'Client',
    spreadId: one(row.album_pages)?.source_spread_id ?? null,
  }));
}

export async function setCommentResolved(staff: Staff, commentId: string, resolved: boolean): Promise<string | null> {
  const resolvedAt = resolved ? new Date().toISOString() : null;
  const { data, error } = await eventor()
    .from('album_comments')
    .update({ resolved_at: resolvedAt, resolved_by: resolved ? staff.id : null })
    .eq('id', commentId)
    .eq('studio_id', staff.studio_id)
    .select('id');
  if (error) throw plainError(error);
  if (!data?.length) throw new Error('Your account is not allowed to resolve comments.');
  return resolvedAt;
}
