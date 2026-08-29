// MOD Catalogue Raisonné — shared Supabase client + data helpers.
// Loaded by every DB-backed page after the Supabase UMD CDN script:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3"></script>
// Pinned to an exact version, not a floating @2 tag — bump deliberately and
// test, rather than silently picking up whatever's newest on every page load.
//   <script src="modcr-client.js"></script>
// The publishable (anon) key below is safe to ship client-side by design —
// access control is enforced by the RLS policies in supabase/schema.sql, not
// by keeping this secret. See supabase/PROGRESS.md.
const MODCR_SUPABASE_URL = 'https://kuyyrygvaotsrhbyjyjw.supabase.co';
const MODCR_SUPABASE_ANON_KEY = 'sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx';
const modcrSupabase = supabase.createClient(MODCR_SUPABASE_URL, MODCR_SUPABASE_ANON_KEY);

// crypto.randomUUID() only exists in a secure context (HTTPS/localhost) --
// on plain HTTP it's undefined, and calling it threw an uncaught error that
// silently broke every photo/audio upload for a work that was already
// saved (the storage path here, not the separate not-yet-saved-work path
// in catalogue_intake's own script, which has its own copy of this fix).
function modcrGenId(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

// ---- Works: DB row <-> the {id,cr,title,date,year,medium,tag,series,img,flag}
// shape the catalogue/entry/admin pages already render.
function modcrPhotoUrl(storagePath){
  return modcrSupabase.storage.from('work-photos').getPublicUrl(storagePath).data.publicUrl;
}
function modcrAdaptWork(row){
  // 'process' photos (e.g. a foundry/patina shot) are documentation, not candidates
  // for the work's main/featured image — only 'work' photos can be primary.
  const photos = (row.work_photos || []).filter(p => (p.photo_type || 'work') === 'work');
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
    secondarySeries: row.secondary_series || null,
    published: !!row.published,
    dimensions: row.dimensions || '',
    titleSource: row.title_source || '',
    photoCredit: row.photo_credit || '',
    inscriptions: row.inscriptions || '',
    collection: row.collection || '',
    description: row.description || '',
    provenance: row.provenance || '',
    exhibitions: row.exhibitions || '',
    literature: row.literature || '',
    revisions: row.revisions || '',
    remarks: row.remarks || '',
    isLargeScale: !!row.is_large_scale,
    isMuseumCollection: !!row.is_museum_collection,
    isPublicInstallation: !!row.is_public_installation,
    isUnlocated: !!row.is_unlocated,
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
    .select('*, work_photos(storage_path,is_primary,photo_type)')
    .order('year', { ascending: true, nullsFirst: false })
    .order('cr_number');
  if(error) throw error;
  return data.map(modcrAdaptWork);
}

async function modcrFetchWorkByCrNumber(crNumber){
  const { data, error } = await modcrSupabase
    .from('works')
    .select('*, work_photos(id,storage_path,is_primary,caption,sort_order,photo_type), work_annotations(id,storage_path,duration_seconds,label)')
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
async function modcrSetPhotoType(photoId, photoType){
  const { error } = await modcrSupabase.from('work_photos').update({ photo_type: photoType }).eq('id', photoId);
  if(error) throw error;
}
async function modcrReorderPhotos(orderedPhotoIds){
  await Promise.all(orderedPhotoIds.map((id, i) =>
    modcrSupabase.from('work_photos').update({ sort_order: i }).eq('id', id)
  ));
}
async function modcrUpdateAnnotationLabel(annotationId, label){
  const { error } = await modcrSupabase.from('work_annotations').update({ label: label || null }).eq('id', annotationId);
  if(error) throw error;
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

// ---- Series admin (create/edit/delete a series, and manage its carousel photos) ----
async function modcrSaveSeries(payload, isNew){
  if(isNew){
    const { data, error } = await modcrSupabase.from('series').insert(payload).select().single();
    if(error) throw error;
    return data;
  }
  const { slug, ...rest } = payload;
  const { data, error } = await modcrSupabase.from('series').update(rest).eq('slug', slug).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteSeries(slug){
  // No cascade on purpose — deleting a series that works still reference should
  // fail loudly (FK violation) rather than silently orphan those works.
  const { error } = await modcrSupabase.from('series').delete().eq('slug', slug);
  if(error) throw error;
}

// ---- Materials admin (add/remove a Medium value) ----
async function modcrFetchMaterials(){
  const { data, error } = await modcrSupabase.from('materials').select('*').order('label');
  if(error) throw error;
  return data;
}
async function modcrAddMaterial(slug, label){
  const { data, error } = await modcrSupabase.from('materials').insert({ slug, label }).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteMaterial(slug){
  // No cascade on purpose — deleting a material still used by works should
  // fail loudly (FK violation) rather than silently blanking their tag.
  const { error } = await modcrSupabase.from('materials').delete().eq('slug', slug);
  if(error) throw error;
}

function modcrSeriesPhotoUrl(storagePath){
  return modcrSupabase.storage.from('series-photos').getPublicUrl(storagePath).data.publicUrl;
}
async function modcrFetchSeriesPhotos(seriesSlug){
  const { data, error } = await modcrSupabase
    .from('series_photos').select('*').eq('series', seriesSlug).order('sort_order');
  if(error) throw error;
  return data;
}
async function modcrUploadSeriesPhoto(seriesSlug, file, photoType){
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${seriesSlug}/${modcrGenId()}.${ext}`;
  const { error: upErr } = await modcrSupabase.storage.from('series-photos').upload(path, file, { upsert: false });
  if(upErr) throw upErr;
  const { data, error } = await modcrSupabase.from('series_photos')
    .insert({ series: seriesSlug, storage_path: path, photo_type: photoType || 'work' })
    .select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteSeriesPhoto(photoId, storagePath){
  await modcrSupabase.storage.from('series-photos').remove([storagePath]);
  const { error } = await modcrSupabase.from('series_photos').delete().eq('id', photoId);
  if(error) throw error;
}
async function modcrUpdateSeriesPhotoCaption(photoId, caption){
  const { error } = await modcrSupabase.from('series_photos').update({ caption: caption || null }).eq('id', photoId);
  if(error) throw error;
}
async function modcrSetSeriesPhotoType(photoId, photoType){
  const { error } = await modcrSupabase.from('series_photos').update({ photo_type: photoType }).eq('id', photoId);
  if(error) throw error;
}
async function modcrReorderSeriesPhotos(orderedPhotoIds){
  await Promise.all(orderedPhotoIds.map((id, i) =>
    modcrSupabase.from('series_photos').update({ sort_order: i }).eq('id', id)
  ));
}

// ---- Chronology admin ----
function modcrChronologyPhotoUrl(storagePath){
  return modcrSupabase.storage.from('chronology-photos').getPublicUrl(storagePath).data.publicUrl;
}
async function modcrFetchChronologyDecades(){
  const { data, error } = await modcrSupabase.from('chronology_decades').select('*').order('decade');
  if(error) throw error;
  return data;
}
async function modcrSaveChronologyDecade(decade, subtitle){
  const { data, error } = await modcrSupabase.from('chronology_decades')
    .upsert({ decade, subtitle: subtitle || null }).select().single();
  if(error) throw error;
  return data;
}
async function modcrFetchChronologyEvents(){
  const { data, error } = await modcrSupabase
    .from('chronology_events').select('*').order('year').order('sort_order');
  if(error) throw error;
  return data;
}
async function modcrSaveChronologyEvent(payload, id){
  if(id){
    const { data, error } = await modcrSupabase.from('chronology_events').update(payload).eq('id', id).select().single();
    if(error) throw error;
    return data;
  }
  const { data, error } = await modcrSupabase.from('chronology_events').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteChronologyEvent(id, storagePath){
  if(storagePath) await modcrSupabase.storage.from('chronology-photos').remove([storagePath]);
  const { error } = await modcrSupabase.from('chronology_events').delete().eq('id', id);
  if(error) throw error;
}
async function modcrUploadChronologyPhoto(eventId, file){
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${eventId}/${modcrGenId()}.${ext}`;
  const { error: upErr } = await modcrSupabase.storage.from('chronology-photos').upload(path, file, { upsert: false });
  if(upErr) throw upErr;
  return path;
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
  const path = `${dbId}/${modcrGenId()}.${ext}`;
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
  const path = `${dbId}/${modcrGenId()}.${ext}`;
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
