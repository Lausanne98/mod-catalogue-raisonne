# Backend status

Historical build narrative (schema bugs found/fixed, the original migration,
early smoke tests) lives in git history for this file — this doc tracks
current state only, not how we got here.

## Project
- Supabase project URL: `https://kuyyrygvaotsrhbyjyjw.supabase.co`
- Publishable (anon) key: `sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx`
  (safe to be public — this is the client-side key by design — access control
  is enforced by the RLS policies in `schema.sql`, not by keeping this secret)
- The `service_role` secret key was never shared with Claude and must stay
  that way — full unrestricted DB access, private only.

## Current state (verified live, 2026-08-19)
`supabase/schema.sql` is applied and the backend is working end-to-end —
public pages, admin pages, and intake all read/write the live DB. Every
migration in the file is a self-healing `alter table ... add column if not
exists`, safe to re-run.

Live row count is **not fully knowable via the anon key** — RLS only
surfaces published series (plus the ceramic-pre-2000 Early Clay
cross-categorization). A same-session anon query returned 21 rows visible
under current publish settings; the true total, including unpublished
series, requires dashboard/service-role access this session doesn't have.
Don't trust a specific total in this file going forward — query live
instead (see below).

## Known open items
- **MOD CR 8** ("Into the Mysterium," mixed media installation) still has no
  resolved `tag` — genuinely undecided taxonomy per CLAUDE.md, not an
  oversight. Flagged via its `flag` field for a real decision.
- Pictographs medium description still needs the real source text.
- Full image-mismatch audit of works beyond MOD CR 6 (see CLAUDE.md's
  "Pulling media from the legacy site" section) not done yet.
- Legal terms text is still a placeholder draft, needs attorney review.
- Voice annotations not yet tested on real hardware (Snowball USB mic) —
  only a fake-device round-trip has passed so far.

## How to verify current state instead of trusting this file
```
curl "https://kuyyrygvaotsrhbyjyjw.supabase.co/rest/v1/works?select=cr_number,title,series,tag,flag&order=cr_number" \
  -H "apikey: sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"
```
This only returns rows RLS allows the anon key to see (published series +
cross-categorized Early Clay). Full-table visibility, publish-state changes,
and admin user management all require the Supabase Dashboard (service-role
access), which no Claude session has.
