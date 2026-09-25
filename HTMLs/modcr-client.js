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

// supabase-js's functions.invoke() throws a generic FunctionsHttpError for
// ANY non-2xx response -- its own .message is just "Edge Function returned a
// non-2xx status code" regardless of what the function actually said (e.g.
// process-source-material's 409 "Already processing: ... wait for it to
// finish" body, which is far more useful than "non-2xx" but isn't surfaced
// unless something goes and reads it). The real body only lives on
// error.context, the raw Response, and has to be read back out manually.
async function modcrUnwrapFunctionError(error){
  if(error?.context && typeof error.context.json === 'function'){
    try{
      const body = await error.context.json();
      if(body?.error) return new Error(body.error);
    }catch(_e){ /* body wasn't JSON -- fall back to the generic message */ }
  }
  return error;
}

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
    // Admin-only, alongside flag -- see CLAUDE.md "Admin/front-end field
    // parity" -- never rendered on the public entry page.
    auctionHistory: row.auction_history || '',
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
    .select('*, work_photos(id,storage_path,is_primary,caption,sort_order,photo_type), work_annotations(id,storage_path,duration_seconds,label,text_note)')
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
  // A text annotation has no storage_path -- nothing to remove from Storage.
  if(storagePath) await modcrSupabase.storage.from('work-audio').remove([storagePath]);
  const { error } = await modcrSupabase.from('work_annotations').delete().eq('id', annotationId);
  if(error) throw error;
}
async function modcrAddTextAnnotation(dbId, text){
  const { data, error } = await modcrSupabase.from('work_annotations')
    .insert({ work_id: dbId, text_note: text })
    .select().single();
  if(error) throw error;
  return data;
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

// ---- Shared text-cleanup helpers (research_finds -> staged_works -> intake) ----
// Kept here, not duplicated per page, so title/tag parsing behaves
// identically wherever it runs: at auto-promotion time (Researcher's Desk),
// at render time (Archivist's Drafts, as a safety net for older drafts
// promoted before this existed), and at intake-fill time. Pure functions --
// neither touches the database.

// A source title routinely has the date jammed onto the end (an auction lot
// title, a museum label) -- "Brooch, c. 2000" when the date already has its
// own field. Strips a trailing date fragment so Title doesn't repeat it;
// falls back to the original title if stripping would empty it out (e.g. a
// title that's genuinely just a year).
function modcrStripRedundantDateFromTitle(title){
  if(!title) return title;
  const cleaned = title
    .replace(/[,\s]*[\(\[]?\s*c\.?\s*\d{4}s?\s*[\)\]]?\s*$/i, '')
    .replace(/,\s*$/, '')
    .trim();
  return cleaned || title;
}

// A source title from an object-first listing routinely reads "<object type>
// '<Real Name>', <edition/gallery info>" or "'<Real Name>' <object type>" --
// e.g. Chaise 'For Eve', edition David Gill Gallery, or "Coral Wave" chair.
// The quoted phrase is the work's actual name; everything else describes
// what kind of object it is, or how/where it was made, which belongs in
// Medium, not Title. Only acts when the title contains EXACTLY ONE quoted
// span (straight or curly, single or double) -- a lone apostrophe
// (possessive, e.g. "Horace's Muse") never pairs up, so it's left alone;
// zero or multiple matches also no-op, same fallback-safe pattern as
// modcrStripRedundantDateFromTitle. Returns { title, extra } -- extra is
// '' when there's nothing outside the quotes worth keeping (a title that's
// entirely wrapped in quotes just gets dequoted).
function modcrExtractQuotedTitle(rawTitle){
  if(!rawTitle) return { title: rawTitle, extra: '' };
  const pattern = /["“]([^"”]+)["”]|'([^']+)'/g;
  const matches = [...rawTitle.matchAll(pattern)];
  if(matches.length !== 1) return { title: rawTitle, extra: '' };
  const m = matches[0];
  const quoted = (m[1] ?? m[2] ?? '').trim();
  if(!quoted) return { title: rawTitle, extra: '' };
  const before = rawTitle.slice(0, m.index).trim();
  const after = rawTitle.slice(m.index + m[0].length).trim().replace(/^[,;.\s]+/, '');
  const extra = [before, after].filter(Boolean).join(', ');
  return { title: quoted, extra };
}

// Folds descriptive text pulled out of a title (see modcrExtractQuotedTitle)
// into the medium field, dropping any comma-separated fragment already
// present in the existing medium text (case-insensitive substring) so e.g.
// "18k gold 'Palmaceae' necklace" with medium "18k gold" doesn't end up
// repeating "18k gold" a second time -- only the genuinely new part
// ("necklace") gets appended.
function modcrMergeIntoMedium(existingMedium, extra){
  if(!extra) return existingMedium || null;
  const parts = extra.split(',').map(s => s.trim()).filter(Boolean);
  const existingLower = (existingMedium || '').toLowerCase();
  const newParts = parts.filter(p => !existingLower.includes(p.toLowerCase()));
  if(!newParts.length) return existingMedium || null;
  return existingMedium ? `${existingMedium}; ${newParts.join(', ')}` : newParts.join(', ');
}

// Best-effort lead material guess from a free-text medium description (e.g.
// "bronze with a baroque cultured pearl" -> bronze). Callers should only use
// the result as a fallback when nothing more confident (a human, or Khalo's
// research) has already set a tag -- never overrides one. The full
// descriptive text always stays in medium regardless of what this returns.
function modcrGuessTagFromMedium(mediumText, materialsList){
  if(!mediumText || !materialsList) return null;
  const lower = mediumText.toLowerCase();
  const candidates = materialsList
    .filter(m => lower.includes(m.slug.toLowerCase()) || lower.includes(m.label.toLowerCase()))
    .sort((a, b) => b.label.length - a.label.length);
  // organic-material is a catch-all label ("Organic Material") that's longer
  // than most specific materials it can co-occur with in a medium string
  // (e.g. "Organic material in abaca paper" also matches "Paper") -- never
  // let it win the longest-label sort; only fall back to it when nothing
  // more specific matched.
  const specific = candidates.filter(m => m.slug !== 'organic-material');
  if(specific.length) return specific[0].slug;
  return candidates[0]?.slug || null;
}

// Mirrors the research_sites seed list in supabase/schema.sql -- shared by
// Archivist's Drafts (draftSourceLabel) and the intake form's draft-prefill
// so a citation's domain reads as a real auction house name in both places
// instead of a raw URL.
const MODCR_AUCTION_HOUSE_DOMAINS = {
  'sothebys.com': "Sotheby's", 'christies.com': "Christie's", 'phillips.com': 'Phillips',
  'bonhams.com': 'Bonhams', 'ragoarts.com': 'Rago Arts and Auction Center', 'wright20.com': 'Wright',
  'doyle.com': 'DOYLE Auctioneers & Appraisers', 'toomeyco.com': 'Toomey & Co. Auctioneers',
  'freemanshindman.com': "Freeman's | Hindman", 'liveauctioneers.com': 'LiveAuctioneers',
  'invaluable.com': 'Invaluable', 'mutualart.com': 'MutualArt', 'lotsearch.net': 'LotSearch',
  'artnet.com': 'Artnet', 'cowans.com': "Cowan's Auctions, Inc.", 'cowanauctions.com': "Cowan's Auctions, Inc.",
};
function modcrGuessAuctionHouseFromUrl(url){
  if(!url) return null;
  try{
    const host = new URL(url).hostname.replace(/^www\./, '');
    return MODCR_AUCTION_HOUSE_DOMAINS[host] || null;
  }catch(e){ return null; }
}

// Pulls a "Month D, YYYY" / "D Month YYYY" / "YYYY-MM-DD" / "MM/DD/YYYY"
// date out of free-text research notes (e.g. "sold at Wright, October 4,
// 2023") -- used to populate a structured auction-record date field instead
// of leaving it blank while the same date sits buried in a citation dump.
const MODCR_MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
function modcrExtractDateFromText(text){
  if(!text) return null;
  let m = text.match(new RegExp(`\\b(${MODCR_MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'));
  if(m) return `${m[1]} ${m[2]}, ${m[3]}`;
  m = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MODCR_MONTH_NAMES})\\s+(\\d{4})\\b`, 'i'));
  if(m) return `${m[1]} ${m[2]} ${m[3]}`;
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if(m) return `${m[1]}/${m[2]}/${m[3]}`;
  return null;
}

// Pulls a remote (usually auction-house/gallery) image in via the
// fetch-remote-image Edge Function rather than a direct browser fetch() --
// confirmed by hand that none of these sources send Access-Control-Allow-
// Origin, so a same-origin-restricted browser fetch() is silently blocked
// by CORS every time even though the image loads fine as a plain <img src>.
// Edge Functions aren't subject to browser CORS, so the same request works
// server-side. Returns a File ready to drop into a pendingPhotos-style
// upload queue, or throws if the source couldn't be fetched.
async function modcrFetchRemoteImageAsFile(url, filenameBase){
  const { data, error } = await modcrSupabase.functions.invoke('fetch-remote-image', { body: { url } });
  if(error) throw error;
  if(data?.error) throw new Error(data.error);
  const contentType = data.contentType || 'image/jpeg';
  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = contentType.split('/')[1] || 'jpg';
  return new File([bytes], `${filenameBase || 'draft-source'}.${ext}`, { type: contentType });
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

// ---- Work Sources (Associate Archivist research trail) ----
async function modcrFetchWorkSources(workId){
  const { data, error } = await modcrSupabase
    .from('work_sources').select('*').eq('work_id', workId).order('created_at', { ascending: false });
  if(error) throw error;
  return data;
}
async function modcrAddWorkSource(payload){
  const { data, error } = await modcrSupabase.from('work_sources').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteWorkSource(sourceId){
  const { error } = await modcrSupabase.from('work_sources').delete().eq('id', sourceId);
  if(error) throw error;
}

// ---- Agent Settings (global engagement on/off, admin display name) ----
async function modcrFetchAgentEngagement(){
  const { data, error } = await modcrSupabase
    .from('agent_settings').select('engagement_enabled').eq('id', 'global').single();
  if(error) throw error;
  return data.engagement_enabled;
}
async function modcrSetAgentEngagement(enabled){
  const { error } = await modcrSupabase
    .from('agent_settings').update({ engagement_enabled: enabled, updated_at: new Date().toISOString() }).eq('id', 'global');
  if(error) throw error;
}
async function modcrFetchAgentSettings(){
  const { data, error } = await modcrSupabase
    .from('agent_settings').select('*').eq('id', 'global').single();
  if(error) throw error;
  return data;
}
async function modcrSetAdminDisplayName(name){
  const { error } = await modcrSupabase
    .from('agent_settings').update({ admin_display_name: name, updated_at: new Date().toISOString() }).eq('id', 'global');
  if(error) throw error;
}

// ---- IT / Infrastructure (manual version of what Timur would eventually
// maintain). Never stores a real credential -- see schema.sql. ----
async function modcrFetchITSubscriptions(){
  const { data, error } = await modcrSupabase
    .from('it_subscriptions').select('*').order('service_name');
  if(error) throw error;
  return data;
}
async function modcrAddITSubscription(payload){
  const { data, error } = await modcrSupabase.from('it_subscriptions').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrSaveITSubscription(payload, id){
  const { error } = await modcrSupabase.from('it_subscriptions').update(payload).eq('id', id);
  if(error) throw error;
}
async function modcrDeleteITSubscription(id){
  const { error } = await modcrSupabase.from('it_subscriptions').delete().eq('id', id);
  if(error) throw error;
}

// ---- Chloe's outbound monitoring: the master site list, and the New
// Finds bullpen / CR Archive (same table -- status distinguishes the two).
// research_finds accepts an anonymous insert by design (see schema.sql),
// so Chloe's skill can write without an admin login -- everything from
// here down is the admin-only review side.
async function modcrFetchResearchSites(){
  const { data, error } = await modcrSupabase
    .from('research_sites').select('*').order('category').order('name');
  if(error) throw error;
  return data;
}
async function modcrAddResearchSite(payload){
  const { data, error } = await modcrSupabase.from('research_sites').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteResearchSite(id){
  const { error } = await modcrSupabase.from('research_sites').delete().eq('id', id);
  if(error) throw error;
}
async function modcrUpdateResearchSite(id, payload){
  const { error } = await modcrSupabase.from('research_sites').update(payload).eq('id', id);
  if(error) throw error;
}
async function modcrFetchResearchFinds(){
  const { data, error } = await modcrSupabase
    .from('research_finds').select('*').order('discovered_at', { ascending: false });
  if(error) throw error;
  return data;
}
async function modcrUpdateResearchFind(id, payload){
  const { error } = await modcrSupabase.from('research_finds').update(payload).eq('id', id);
  if(error) throw error;
}
async function modcrDeleteResearchFind(id){
  const { error } = await modcrSupabase.from('research_finds').delete().eq('id', id);
  if(error) throw error;
}
async function modcrFetchITGateHash(){
  const { data, error } = await modcrSupabase
    .from('it_access_settings').select('gate_hash').eq('id', 'global').single();
  if(error) throw error;
  return data.gate_hash;
}
async function modcrSetITGateHash(hash){
  const { error } = await modcrSupabase
    .from('it_access_settings').update({ gate_hash: hash, updated_at: new Date().toISOString() }).eq('id', 'global');
  if(error) throw error;
}
async function modcrHashText(text){
  const encoded = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Staged Works (Associate Archivist candidate discoveries — the
// "New Entries" tab of Archivist's Drafts) ----
async function modcrFetchStagedWorks(){
  const { data, error } = await modcrSupabase
    .from('staged_works').select('*').order('created_at', { ascending: false });
  if(error) throw error;
  return data;
}
// Used by the intake form's from_draft prefill path -- it doesn't otherwise
// load the staged_works list, just the one row being turned into an entry.
async function modcrFetchStagedWorkById(id){
  const { data, error } = await modcrSupabase
    .from('staged_works').select('*').eq('id', id).maybeSingle();
  if(error) throw error;
  return data;
}
async function modcrCreateStagedWork(payload){
  const { data, error } = await modcrSupabase.from('staged_works').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrSaveStagedWork(payload, id){
  const { data, error } = await modcrSupabase.from('staged_works').update(payload).eq('id', id).select().single();
  if(error) throw error;
  return data;
}
async function modcrDeleteStagedWork(id){
  const { error } = await modcrSupabase.from('staged_works').delete().eq('id', id);
  if(error) throw error;
}
// Promotes a staged candidate into a real `works` row, assigning it the
// correct provisional CR number per CLAUDE.md's rule: within the 100+
// block, numbers go in chronological (by-year) order, undated last. Any
// existing 100+ work dated later than this one gets bumped up by one to
// make room -- processed highest-number-first so the unique constraint on
// cr_number is never transiently violated.
async function modcrImportStagedWork(staged, publish){
  const { data: existing, error } = await modcrSupabase
    .from('works').select('id, cr_number, year').gte('cr_number', 100).order('cr_number');
  if(error) throw error;
  const newYearSort = staged.year == null ? Infinity : staged.year;
  let insertAt = existing.findIndex(w => (w.year == null ? Infinity : w.year) > newYearSort);
  if(insertAt === -1) insertAt = existing.length;
  for(let i = existing.length - 1; i >= insertAt; i--){
    const { error: shiftErr } = await modcrSupabase
      .from('works').update({ cr_number: existing[i].cr_number + 1 }).eq('id', existing[i].id);
    if(shiftErr) throw shiftErr;
  }
  const newCrNumber = 100 + insertAt;
  const { data: newWork, error: insErr } = await modcrSupabase.from('works').insert({
    cr_number: newCrNumber,
    title: staged.title || 'Untitled',
    date_display: staged.date_display || null,
    year: staged.year,
    medium: staged.medium || null,
    tag: staged.tag || null,
    series: staged.suggested_series || null,
    published: !!publish,
    flag: `Imported from Associate Archivist staging (source: ${staged.source_url || 'unspecified'}).${staged.notes ? ' ' + staged.notes : ''}`,
  }).select().single();
  if(insErr) throw insErr;
  const { error: stagedErr } = await modcrSupabase.from('staged_works')
    .update({ status: 'imported', imported_work_id: newWork.id }).eq('id', staged.id);
  if(stagedErr) throw stagedErr;
  return newWork;
}

// ---- Work Revisions (Associate Archivist proposed changes to an existing
// work — the "Revisions" tab of Archivist's Drafts). A confirmed finding
// never writes to the work's field directly; it proposes a revision here,
// and only modcrApproveRevision actually applies it, on a human's say-so. ----
async function modcrFetchWorkRevisions(status){
  let q = modcrSupabase.from('work_revisions')
    .select('*, works(cr_number, title, published), work_sources(url, finding, source_type)')
    .order('created_at', { ascending: false });
  if(status) q = q.eq('status', status);
  const { data, error } = await q;
  if(error) throw error;
  return data;
}
async function modcrProposeRevision(payload){
  const { data, error } = await modcrSupabase.from('work_revisions').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function modcrApproveRevision(id){
  const { data: rev, error: fetchErr } = await modcrSupabase
    .from('work_revisions').select('*').eq('id', id).single();
  if(fetchErr) throw fetchErr;
  const { data: work, error: workErr } = await modcrSupabase
    .from('works').select(rev.field).eq('id', rev.work_id).single();
  if(workErr) throw workErr;
  const current = work[rev.field];
  const newValue = current ? current + '\n' + rev.proposed_text : rev.proposed_text;
  const { error: updErr } = await modcrSupabase
    .from('works').update({ [rev.field]: newValue }).eq('id', rev.work_id);
  if(updErr) throw updErr;
  const { error: revErr } = await modcrSupabase
    .from('work_revisions').update({ status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', id);
  if(revErr) throw revErr;
}
async function modcrRejectRevision(id){
  const { error } = await modcrSupabase
    .from('work_revisions').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', id);
  if(error) throw error;
}

// ---- Public Submissions (Call for Works form) — write-only from the
// public side; no fetch/read helper here on purpose, since only an
// authenticated admin session can ever select from this table. ----
async function modcrSubmitPublicWork(payload){
  const { error } = await modcrSupabase.from('public_submissions').insert(payload);
  if(error) throw error;
}
async function modcrUploadPublicSubmissionPhoto(blob, filename){
  const path = `${Date.now()}-${modcrGenId()}-${filename}`;
  const { error } = await modcrSupabase.storage.from('public-submissions').upload(path, blob, { upsert: false });
  if(error) throw error;
  return path;
}

// ---- Source Materials (raw intake: catalog PDFs & legacy photography,
// pending triage/mining) — private bucket, so display needs a signed URL
// rather than the public-URL helper pattern used by work-photos etc. ----
async function modcrFetchSourceMaterials(){
  const { data, error } = await modcrSupabase
    .from('source_materials').select('*').order('uploaded_at', { ascending: false });
  if(error) throw error;
  return data;
}
async function modcrSourceMaterialUrl(storagePath){
  const { data, error } = await modcrSupabase.storage
    .from('source-materials').createSignedUrl(storagePath, 3600);
  if(error) throw error;
  return data.signedUrl;
}
async function modcrUploadSourceMaterial(blob, filename, kind, relatedWorkId, notes){
  const path = `${Date.now()}-${modcrGenId()}-${filename}`;
  const { error: upErr } = await modcrSupabase.storage.from('source-materials').upload(path, blob, { upsert: false });
  if(upErr) throw upErr;
  const { data, error } = await modcrSupabase.from('source_materials')
    .insert({ kind, filename, storage_path: path, related_work_id: relatedWorkId || null, notes: notes || null })
    .select().single();
  if(error) throw error;
  return data;
}

// pdf.js's worker needs a script URL of its own -- only set this up on a
// page that actually loaded pdf.js (Researcher's Desk, Sources) via its own
// <script src=".../pdf.min.js"> tag before this file; every other page that
// loads modcr-client.js never defines the pdfjsLib global at all, so this
// stays a no-op there rather than throwing on load.
if(typeof pdfjsLib !== 'undefined'){
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';
}

// Strips a source PDF into one full-page JPEG + that page's extracted text
// per page, entirely in the browser -- the raw PDF itself is never uploaded
// to Supabase (per CLAUDE.md's "Source PDFs don't live in Supabase long
// term" rule) and never leaves this tab. Companion to
// scripts/catalog_pdf_extractor.py, which does the equivalent job locally
// with PyMuPDF for someone with the file on their own machine and wants true
// per-embedded-image extraction; this is the same idea made self-serve from
// the browser, at the cost of a simpler approach -- it renders each page as
// one flat image rather than trying to pull out individual embedded photo
// objects, so a busy page with several works on it still needs a human (or
// Khalo, via attach_staged_work_photo's crop option) to crop down to just
// one work afterward. Matches that script's filename/notes convention
// (`{label}-p{N}-{n}.jpg`, `notes` carrying the page's own extracted text)
// so a page extracted either way reads identically to Mode B.
//
// Pages are rendered and encoded one at a time, each canvas discarded before
// the next page starts, so memory stays proportional to one page's pixels
// regardless of how many pages the document has. The one unavoidable cost:
// pdf.js needs the whole file's bytes resident to parse its structure, so a
// very large PDF (hundreds of MB) does sit fully in this tab's memory for
// the duration of extraction -- transient and local, never uploaded, but
// real memory pressure on the machine doing the upload.
async function modcrExtractPdfPages(file, baseLabel, onProgress){
  // 1568px, not this project's usual 2200px catalog-photo convention --
  // deliberately: Khalo's Mode B sends every page of a batch to Claude in
  // one request, and Anthropic enforces a stricter per-image size cap
  // specifically for a request carrying many images at once (2000px on the
  // longer side) than for a single image alone. A batch rendered at 2200px
  // fails outright on its very first API call. An Edge Function can't fix
  // this up server-side either -- a real batch confirmed that a pure-JS
  // resize of dozens of images in one invocation blows Supabase's per-call
  // CPU budget and gets silently killed before a single tool call happens.
  // Rendering safely-sized pages from the start, here, is the only place
  // this can be fixed without extra server-side work at all. 1568px is
  // Anthropic's own documented sweet spot (a larger image just gets
  // downsampled internally anyway, at extra token cost for no extra detail),
  // leaving comfortable headroom under the 2000px many-image cap.
  const MAX_PX = 1568;
  const JPEG_QUALITY = 0.88;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const results = [];
  try{
    for(let pageNum = 1; pageNum <= pdf.numPages; pageNum++){
      if(onProgress) onProgress(pageNum, pdf.numPages);
      const page = await pdf.getPage(pageNum);
      try{
        const textContent = await page.getTextContent();
        const text = textContent.items.map(it => it.str || '').join(' ').replace(/\s+/g, ' ').trim();

        const baseViewport = page.getViewport({ scale: 1 });
        const renderScale = MAX_PX / Math.max(baseViewport.width, baseViewport.height);
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));

        const n = results.length + 1;
        const filename = `${baseLabel}-p${pageNum}-${n}.jpg`;
        const notes = `FULL PAGE (browser-side extraction renders each page whole, not individual embedded images -- may still need manual cropping before use as a work photo). From catalog: ${baseLabel}, page ${pageNum}.\n\nPage text:\n${text}`;
        results.push({ blob, filename, notes });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await pdf.destroy();
  }
  return results;
}
async function modcrUpdateSourceMaterial(id, patch){
  const { error } = await modcrSupabase.from('source_materials').update(patch).eq('id', id);
  if(error) throw error;
}
async function modcrDeleteSourceMaterial(id, storagePath){
  // kind:'url' rows have no storage object (nothing was ever uploaded) --
  // only attempt the storage removal when there's actually a path.
  if(storagePath) await modcrSupabase.storage.from('source-materials').remove([storagePath]);
  const { error } = await modcrSupabase.from('source_materials').delete().eq('id', id);
  if(error) throw error;
}
// A pasted link (an auction lot, gallery, or press page) instead of an
// uploaded file -- nothing goes to Storage; process-source-material fetches
// the live page itself at processing time.
async function modcrAddUrlSourceMaterial(url){
  const { data, error } = await modcrSupabase.from('source_materials')
    .insert({ kind: 'url', filename: url, url, storage_path: null })
    .select().single();
  if(error) throw error;
  return data;
}

// ---- Archive Index (metadata-only record of a photographer's raw archive
// on an external drive at the studio — populated by scripts/archive_indexer.py
// run locally, never uploaded through the browser). Read-only from here;
// this file has no write path for it on purpose. ----
async function modcrFetchArchiveIndex(){
  const { data, error } = await modcrSupabase
    .from('archive_index').select('*').order('archive_label').order('relative_path');
  if(error) throw error;
  return data;
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
  // Text annotations have no storage_path -- filter those out before asking
  // Storage to remove them (a null in the list would just be a wasted no-op
  // entry, but there's no reason to send it).
  const annotationPaths = (annotations || []).map(a=>a.storage_path).filter(Boolean);
  if(annotationPaths.length) await modcrSupabase.storage.from('work-audio').remove(annotationPaths);
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

// ---- Per-page admin background (self-serve upload) ----
// Each admin page owns one row here by its own slug. Replaces hand-coding a
// background image into a page's CSS -- which meant an image had to be
// handed off to a Claude session through chat every time it changed, a path
// that turned out to sometimes silently degrade the file (a low-resolution
// preview instead of the original). Uploading straight from the browser
// avoids that entirely.
const MODCR_BG_BUCKET = 'admin-backgrounds';
function modcrBackgroundUrl(storagePath){
  return modcrSupabase.storage.from(MODCR_BG_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}
async function modcrFetchPageBackground(pageSlug){
  const { data, error } = await modcrSupabase
    .from('admin_backgrounds').select('*').eq('page_slug', pageSlug).maybeSingle();
  if(error) throw error;
  return data;
}
async function modcrUploadPageBackground(pageSlug, file){
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${pageSlug}.${ext}`;
  const { error: upErr } = await modcrSupabase.storage.from(MODCR_BG_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if(upErr) throw upErr;
  const { data, error } = await modcrSupabase.from('admin_backgrounds')
    .upsert({ page_slug: pageSlug, storage_path: path, updated_at: new Date().toISOString() })
    .select().single();
  if(error) throw error;
  return data;
}
function modcrApplyPageBackground(row){
  if(!row) return;
  // Cache-bust with the row's own updated_at so every viewer picks up a
  // replacement immediately, not just whoever uploaded it.
  const url = modcrBackgroundUrl(row.storage_path) + '?v=' + new Date(row.updated_at).getTime();
  document.body.style.backgroundImage = `url('${url}')`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundRepeat = 'no-repeat';
  document.body.style.backgroundAttachment = 'fixed';
}
// Small floating admin-only control added to each admin page's own markup
// via one call. Falls back to whatever background that page's own CSS
// already declares until a row exists for its slug.
function modcrInitBackgroundTab(pageSlug){
  const tab = document.createElement('div');
  tab.className = 'modcr-bg-tab';
  tab.innerHTML = `
    <button type="button" class="modcr-bg-tab-btn">Background</button>
    <input type="file" accept="image/*" class="modcr-bg-tab-input" style="display:none;">
  `;
  const style = document.createElement('style');
  style.textContent = `
    .modcr-bg-tab { position: fixed; right: 14px; bottom: 14px; z-index: 9999; }
    .modcr-bg-tab-btn {
      font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
      background: rgba(28,28,28,.72); color: #fff; border: none; padding: 8px 12px; cursor: pointer;
    }
    .modcr-bg-tab-btn:hover { background: rgba(28,28,28,.9); }
    .modcr-bg-tab-btn:disabled { opacity: .6; cursor: wait; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(tab);
  const btn = tab.querySelector('.modcr-bg-tab-btn');
  const input = tab.querySelector('.modcr-bg-tab-input');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if(!file) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try{
      const row = await modcrUploadPageBackground(pageSlug, file);
      modcrApplyPageBackground(row);
      btn.textContent = 'Updated';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }catch(e){
      alert("Couldn't update the background: " + e.message);
      btn.textContent = original;
    }finally{
      btn.disabled = false;
      input.value = '';
    }
  });
  modcrFetchPageBackground(pageSlug).then(row => { if(row) modcrApplyPageBackground(row); }).catch(()=>{});
}

// ---- Citation index / live research (Intake auto-prime + search buttons) ----
// Fuzzy title match against the work_citations index (see supabase/schema.sql
// -- match_work_citations, pg_trgm-backed) so a new entry, however it began
// (typed manually, or opened from a Researcher's/Archivist's draft), can be
// auto-primed with every citation Khalo's research passes have already
// logged for that title, even a passing mention that wasn't itself enough to
// stage or match a work on its own.
async function modcrFetchCitationMatches(title){
  if(!title || !title.trim()) return [];
  const { data, error } = await modcrSupabase.rpc('match_work_citations', { p_title: title.trim() });
  if(error) throw error;
  return data ?? [];
}
// Live web-search pass scoped to one work (research-work Edge Function) --
// never writes to the database itself; the caller drops the result into the
// relevant form fields as editable draft text for human review.
async function modcrResearchWork(title, medium, dateDisplay){
  const { data, error } = await modcrSupabase.functions.invoke('research-work', {
    body: { title, medium: medium || undefined, date_display: dateDisplay || undefined },
  });
  if(error) throw await modcrUnwrapFunctionError(error);
  return data;
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
