// MOD Catalogue Raisonné — shared Supabase client + data helpers.
// Loaded by every DB-backed page after the Supabase UMD CDN script:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="modcr-client.js"></script>
// The publishable (anon) key below is safe to ship client-side by design —
// access control is enforced by the RLS policies in supabase/schema.sql, not
// by keeping this secret. See supabase/PROGRESS.md.
const MODCR_SUPABASE_URL = 'https://kuyyrygvaotsrhbyjyjw.supabase.co';
const MODCR_SUPABASE_ANON_KEY = 'sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx';
const modcrSupabase = supabase.createClient(MODCR_SUPABASE_URL, MODCR_SUPABASE_ANON_KEY);

// ---- Works: DB row <-> the {id,cr,title,date,year,medium,tag,series,img,flag}
// shape the catalogue/entry/admin pages already render.
function modcrPhotoUrl(storagePath){
  return modcrSupabase.storage.from('work-photos').getPublicUrl(storagePath).data.publicUrl;
}
function modcrAdaptWork(row){
  const photos = row.work_photos || [];
  const primary = photos.find(p=>p.is_primary) || photos[0];
  const img = primary ? modcrPhotoUrl(primary.storage_path) : (row.legacy_image_url || '');
  return {
    id: row.cr_number,
    dbId: row.id,
    cr: `MOD CR ${row.cr_number}`,
    title: row.title,
    date: row.date_display || '',
    year: row.year,
    medium: row.medium || '',
    tag: row.tag || '',
    series: row.series,
    dimensions: row.dimensions || '',
    description: row.description || '',
    provenance: row.provenance || '',
    exhibitions: row.exhibitions || '',
    literature: row.literature || '',
    remarks: row.remarks || '',
    img,
    flag: row.flag || undefined,
  };
}

async function modcrFetchWorks(){
  // Chronological by default — cr_number is a provisional/administrative id, not
  // necessarily creation order (see CLAUDE.md "Provisional CR numbering"). Undated
  // works (year is null) sort last.
  const { data, error } = await modcrSupabase
    .from('works')
    .select('*, work_photos(storage_path,is_primary)')
    .order('year', { ascending: true, nullsFirst: false })
    .order('cr_number');
  if(error) throw error;
  return data.map(modcrAdaptWork);
}

async function modcrFetchWorkByCrNumber(crNumber){
  const { data, error } = await modcrSupabase
    .from('works')
    .select('*, work_photos(id,storage_path,is_primary,caption,sort_order), work_annotations(id,storage_path,duration_seconds)')
    .eq('cr_number', crNumber)
    .order('sort_order', { referencedTable: 'work_photos' })
    .maybeSingle();
  if(error) throw error;
  if(!data) return null;
  const work = modcrAdaptWork(data);
  work.photos = data.work_photos || [];
  work.annotations = data.work_annotations || [];
  return work;
}

async function modcrDeletePhoto(photoId, storagePath){
  await modcrSupabase.storage.from('work-photos').remove([storagePath]);
  const { error } = await modcrSupabase.from('work_photos').delete().eq('id', photoId);
  if(error) throw error;
}
async function modcrSetPrimaryPhoto(dbId, photoId){
  const { error: clearErr } = await modcrSupabase.from('work_photos').update({ is_primary: false }).eq('work_id', dbId);
  if(clearErr) throw clearErr;
  const { error } = await modcrSupabase.from('work_photos').update({ is_primary: true }).eq('id', photoId);
  if(error) throw error;
}
async function modcrUpdatePhotoCaption(photoId, caption){
  const { error } = await modcrSupabase.from('work_photos').update({ caption: caption || null }).eq('id', photoId);
  if(error) throw error;
}
async function modcrReorderPhotos(orderedPhotoIds){
  await Promise.all(orderedPhotoIds.map((id, i) =>
    modcrSupabase.from('work_photos').update({ sort_order: i }).eq('id', id)
  ));
}
async function modcrDeleteAnnotation(annotationId, storagePath){
  await modcrSupabase.storage.from('work-audio').remove([storagePath]);
  const { error } = await modcrSupabase.from('work_annotations').delete().eq('id', annotationId);
  if(error) throw error;
}

async function modcrFetchSeries(){
  const { data, error } = await modcrSupabase.from('series').select('*').order('sort_order');
  if(error) throw error;
  return data;
}

// ---- Admin write helpers (require an authenticated session — enforced by RLS) ----
async function modcrSaveWork(payload, dbId){
  if(dbId){
    const { data, error } = await modcrSupabase.from('works').update(payload).eq('id', dbId).select().single();
    if(error) throw error;
    return data;
  }
  const { data, error } = await modcrSupabase.from('works').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteWork(dbId){
  // Postgres cascade removes the work_photos/work_annotations *rows*, but the
  // actual uploaded files in Storage are a separate system it can't reach —
  // clean those up first or they're orphaned (found via live smoke test).
  const [{ data: photos }, { data: annotations }] = await Promise.all([
    modcrSupabase.from('work_photos').select('storage_path').eq('work_id', dbId),
    modcrSupabase.from('work_annotations').select('storage_path').eq('work_id', dbId),
  ]);
  if(photos && photos.length) await modcrSupabase.storage.from('work-photos').remove(photos.map(p=>p.storage_path));
  if(annotations && annotations.length) await modcrSupabase.storage.from('work-audio').remove(annotations.map(a=>a.storage_path));
  const { error } = await modcrSupabase.from('works').delete().eq('id', dbId);
  if(error) throw error;
}

async function modcrUploadPhoto(dbId, file, isPrimary){
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${dbId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await modcrSupabase.storage.from('work-photos').upload(path, file, { upsert: false });
  if(upErr) throw upErr;
  const { data, error } = await modcrSupabase.from('work_photos')
    .insert({ work_id: dbId, storage_path: path, is_primary: !!isPrimary })
    .select().single();
  if(error) throw error;
  return data;
}

async function modcrUploadAnnotation(dbId, blob, mimeType, durationSeconds){
  const ext = (mimeType || 'audio/webm').split('/')[1] || 'webm';
  const path = `${dbId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await modcrSupabase.storage.from('work-audio').upload(path, blob, {
    upsert: false, contentType: mimeType || 'audio/webm',
  });
  if(upErr) throw upErr;
  const { data, error } = await modcrSupabase.from('work_annotations')
    .insert({ work_id: dbId, storage_path: path, duration_seconds: durationSeconds || null })
    .select().single();
  if(error) throw error;
  return data;
}
function modcrAudioUrl(storagePath){
  return modcrSupabase.storage.from('work-audio').getPublicUrl(storagePath).data.publicUrl;
}

// ---- Auth ----
async function modcrRequireAuth(loginPage){
  const { data: { session } } = await modcrSupabase.auth.getSession();
  if(!session){
    window.location.href = loginPage;
    return null;
  }
  return session;
}
async function modcrLogOut(loginPage){
  await modcrSupabase.auth.signOut();
  window.location.href = loginPage;
}
