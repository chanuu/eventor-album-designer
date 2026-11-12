import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { deviceIdentity, publishSpread, type ProjectSpec, type PublishLink, type Project } from './api';

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
  try {
    localStorage.removeItem(ACCESS_KEY);
  } catch {
    // Nothing was remembered, then.
  }
}

// â”€â”€â”€ Whether this studio's package includes the tool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** How long the tool keeps working with no connection since it last checked. */
export const OFFLINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_KEY = 'designer-access';
const FEATURE = 'album_designer';

export type Access =
  | { state: 'allowed'; staff: Staff | null; canCreateGallery: boolean; offline: boolean }
  | { state: 'signed-out' }
  | { state: 'not-in-package' }
  | { state: 'device-limit'; used: number; limit: number; devices: DesignerDevice[]; canRemove: boolean }
  | { state: 'offline-too-long' }
  | { state: 'problem'; message: string };

type RememberedAccess = { checkedAt: number; canCreateGallery: boolean; staff: Staff };

function remembered(): RememberedAccess | null {
  try {
    return JSON.parse(localStorage.getItem(ACCESS_KEY) ?? 'null') as RememberedAccess | null;
  } catch {
    return null;
  }
}

function fromMemory(): Access {
  const last = remembered();
  if (!last) return { state: 'signed-out' };
  if (Date.now() - last.checkedAt > OFFLINE_DAYS * DAY_MS) return { state: 'offline-too-long' };
  return { state: 'allowed', staff: last.staff, canCreateGallery: last.canCreateGallery, offline: true };
}

/** A dropped connection is not the same as being refused. */
function isConnectionProblem(error: { message?: string } | null | undefined): boolean {
  return /failed to fetch|network|load failed/i.test(error?.message ?? '');
}

/**
 * Whether this person may use the tool. The answer comes from the plan's features, which
 * are set in the platform admin, so access can be changed with no new release.
 */
export async function checkAccess(): Promise<Access> {
  const db = eventor();
  let session;
  try {
    const { data, error } = await db.auth.getSession();
    if (error) return isConnectionProblem(error) ? fromMemory() : { state: 'signed-out' };
    session = data.session;
  } catch {
    return fromMemory();
  }
  if (!session) return { state: 'signed-out' };

  try {
    const staff = await staffFor(session.user.id);
    if (!staff) return { state: 'signed-out' };

    const { data, error } = await db.rpc('my_features');
    if (error) {
      return isConnectionProblem(error) ? fromMemory() : { state: 'problem', message: error.message };
    }
    const features = new Set(((data ?? []) as { feature_key: string }[]).map((f) => f.feature_key));
    const canCreateGallery = features.has('gallery');

    if (!features.has(FEATURE)) {
      // Until Eventor has been updated this feature does not exist, so nobody can lack it.
      const { data: known, error: knownError } = await db.from('features').select('key').eq('key', FEATURE).maybeSingle();
      if (knownError) {
        return isConnectionProblem(knownError) ? fromMemory() : { state: 'problem', message: knownError.message };
      }
      if (known) {
        localStorage.removeItem(ACCESS_KEY);
        return { state: 'not-in-package' };
      }
    }

    const device = await registerDevice();
    if (device.state !== 'allowed') {
      if (device.state === 'offline') return fromMemory();
      // A computer turned away must not keep working offline on an earlier answer.
      localStorage.removeItem(ACCESS_KEY);
      return device;
    }

    try {
      localStorage.setItem(ACCESS_KEY, JSON.stringify({ checkedAt: Date.now(), canCreateGallery, staff }));
    } catch {
      // It only means no offline use until storage works again.
    }
    return { state: 'allowed', staff, canCreateGallery, offline: false };
  } catch (e) {
    if (isConnectionProblem(e instanceof Error ? e : null)) return fromMemory();
    throw e;
  }
}

// â”€â”€â”€ How many computers the plan allows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type DesignerDevice = {
  id: string;
  name: string | null;
  platform: string | null;
  last_seen: string;
};

/** The database has no device limit yet, so nothing can be over it. */
const NO_FUNCTION = new Set(['PGRST202', '42883']);

type DeviceCheck =
  | { state: 'allowed' }
  | { state: 'offline' }
  | Extract<Access, { state: 'device-limit' | 'problem' }>;

/**
 * Records this computer against the studio, or is turned away if the plan's limit is
 * already used by others. A computer already registered always gets in.
 */
async function registerDevice(): Promise<DeviceCheck> {
  const db = eventor();
  const me = await deviceIdentity();
  const { data, error } = await db.rpc('register_designer_device', {
    p_device_id: me.id,
    p_name: me.name,
    p_platform: me.platform,
  });
  if (error) {
    if (error.code && NO_FUNCTION.has(error.code)) return { state: 'allowed' };
    return isConnectionProblem(error) ? { state: 'offline' } : { state: 'problem', message: error.message };
  }
  const answer = data as { allowed: boolean; used: number; limit: number | null };
  if (answer.allowed || answer.limit === null) return { state: 'allowed' };

  const [devices, canRemove] = await Promise.all([
    db
      .from('designer_devices')
      .select('id, name, platform, last_seen')
      .is('removed_at', null)
      .order('last_seen', { ascending: false }),
    db.rpc('has_permission', { p_key: 'settings.manage' }),
  ]);
  if (devices.error) return { state: 'problem', message: devices.error.message };
  return {
    state: 'device-limit',
    used: answer.used,
    limit: answer.limit,
    devices: (devices.data ?? []) as DesignerDevice[],
    canRemove: canRemove.data === true,
  };
}

/** Frees a computer's place so another can be used. Needs "Manage studio settings". */
export async function removeDevice(id: string): Promise<void> {
  const { error } = await eventor().rpc('remove_designer_device', { p_id: id });
  if (error) throw plainError(error);
}

// â”€â”€â”€ Jobs, galleries and what the customer selected â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type JobGallery = {
  id: string;
  title: string;
  status: string;
  selection_submitted_at: string | null;
};

export type JobName = { id: string; title: string; clientName: string; galleries: JobGallery[] };

export async function listJobNames(staff: Staff): Promise<JobName[]> {
  const { data, error } = await eventor()
    .from('jobs')
    .select('id, title, clients(full_name), galleries(id, title, status, selection_submitted_at)')
    .eq('studio_id', staff.studio_id)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw plainError(error);
  type Row = {
    id: string;
    title: string;
    clients: { full_name: string } | { full_name: string }[] | null;
    galleries: JobGallery[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    clientName: one(row.clients)?.full_name ?? 'No client',
    galleries: row.galleries ?? [],
  }));
}

export type SelectedPhoto = { file_name: string; source_hash: string | null };

/** Everything selected in a gallery. The server sends at most a thousand rows at a time. */
export async function selectedPhotos(galleryId: string): Promise<SelectedPhoto[]> {
  const PAGE = 1000;
  const all: SelectedPhoto[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await eventor()
      .from('gallery_photos')
      .select('file_name, source_hash')
      .eq('gallery_id', galleryId)
      .eq('is_selected', true)
      .eq('is_active', true)
      .order('sort_order')
      .range(from, from + PAGE - 1);
    if (error) throw plainError(error);
    const rows = (data ?? []) as SelectedPhoto[];
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

/** Hidden until every photo is up, so a customer never sees half a gallery. */
export async function startGallery(jobId: string, title: string, deadline: string): Promise<string> {
  const { data, error } = await eventor()
    .from('galleries')
    .insert({
      job_id: jobId,
      title,
      status: 'hidden',
      selection_deadline: deadline ? new Date(deadline).toISOString() : null,
    })
    .select('id')
    .single();
  if (error) {
    throw error.message.includes('row-level security')
      ? new Error('Your package or role does not allow creating galleries.')
      : plainError(error);
  }
  return (data as { id: string }).id;
}

type Ticket = { uploadUrl: string; publicUrl: string };

export async function galleryUploadAddresses(
  galleryId: string,
  count: number,
): Promise<{ full: Ticket; thumb: Ticket }[]> {
  const item = { kind: 'gallery', parentId: galleryId, ext: 'jpg', contentType: 'image/jpeg' };
  const { data, error } = await eventor().functions.invoke('storage', {
    body: { items: Array.from({ length: count * 2 }, () => item) },
  });
  const payload = data as { error?: string; tickets?: Ticket[] } | null;
  if (error || payload?.error) throw new Error(payload?.error ?? error?.message ?? 'Could not prepare the upload.');
  const tickets = payload?.tickets ?? [];
  if (tickets.length !== count * 2) throw new Error('Could not prepare the upload.');
  return Array.from({ length: count }, (_, i) => ({ full: tickets[i * 2], thumb: tickets[i * 2 + 1] }));
}

export type GalleryPhotoRow = { url: string; thumbUrl: string; fileName: string; hash: string; order: number };

export async function recordGalleryPhotos(staff: Staff, galleryId: string, photos: GalleryPhotoRow[]): Promise<void> {
  const { error } = await eventor().from('gallery_photos').insert(photos.map((p) => ({
    studio_id: staff.studio_id,
    gallery_id: galleryId,
    storage_path: p.url,
    thumb_path: p.thumbUrl,
    file_name: p.fileName.slice(0, 200),
    sort_order: p.order,
    source_hash: p.hash,
  })));
  if (error) throw plainError(error);
}

export async function openGalleryForSelection(galleryId: string): Promise<void> {
  const { data, error } = await eventor()
    .from('galleries')
    .update({ status: 'proofing' })
    .eq('id', galleryId)
    .select('id');
  if (error) throw plainError(error);
  if (!data?.length) throw new Error('Your account is not allowed to open this gallery.');
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
