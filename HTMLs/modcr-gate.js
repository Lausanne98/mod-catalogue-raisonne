// Shared preview-access gate, used by every visitor-facing (non-admin) page.
// The full Catalogue Raisonné isn't going public until 2027 — until then this
// is a soft "waiting room" password given out to select people, so they can
// preview the site. It only ever unlocks what the Supabase RLS `published`
// flag already allows an anonymous visitor to see (currently just Early
// Clay) — this is a friction gate for casual visitors, not the real access
// control, so a plain client-side check is intentional, not an oversight.
//
// CHANGE THIS before sharing the link with anyone:
const MODCR_PREVIEW_PASSWORD = 'earlyclay-preview';

function modcrHasPreviewAccess(){
  return localStorage.getItem('modcr_preview_access') === 'true';
}
function modcrGrantPreviewAccess(){
  localStorage.setItem('modcr_preview_access', 'true');
}
// Called at the very top of <head> on every gated page, before anything else
// loads, so an unauthorized visitor never sees a flash of real content.
function modcrRequirePreviewAccess(){
  if(modcrHasPreviewAccess()) return;
  const here = location.pathname.split('/').pop() + location.search;
  location.replace('preview_gate_v15_sans.html?return=' + encodeURIComponent(here));
}
