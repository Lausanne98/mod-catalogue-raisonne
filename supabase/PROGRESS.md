# Backend build — session handoff

## Project
- Supabase project URL: `https://kuyyrygvaotsrhbyjyjw.supabase.co`
- Publishable (anon) key: `sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx`
  (safe to be public — this is the client-side key by design; access control
  is enforced by the RLS policies in `schema.sql`, not by keeping this secret)
- The `service_role` secret key was never shared with Claude and must stay
  that way — full unrestricted DB access, private only.

## Status
- `supabase/schema.sql` has been written, committed, and the user ran it in
  the Supabase SQL Editor. **Not yet independently verified** — first thing
  a new session should do is confirm the tables and 28-work migration
  actually landed (GET `{url}/rest/v1/works?select=cr_number,title,series`
  with the `apikey` header set to the key above; expect 28 rows).
- Network access to `*.supabase.co` was just added to this session's cloud
  environment (env named `micheleokadoner.com`) — takes effect for NEW
  sessions only, not retroactively.

## What's built so far (this session, all on branch `claude/file-contents-review-isefql`)
See `CLAUDE.md` for full project conventions (versioning rule, taxonomy,
cross-categorization rule, legacy-site pull protocol). In short: a full
static-HTML catalogue site (browse, entry pages, terms gate) plus an admin
suite (login, dashboard, Manage Works, intake form with photo/mic capture)
that currently reads/writes a hardcoded JS array and localStorage — no real
persistence yet. GitHub Pages is live at
https://lausanne98.github.io/mod-catalogue-raisonne/ (currently serving
`main`, which does NOT have this branch's work — PR #2 is open, unmerged).

## Remaining backend work (the ~20-40 hr estimate)
1. Verify the schema migration (see Status above).
2. Real authentication: replace the placeholder client-side passphrase gate
   (`catalogue_admin_login_v1_sans.html`) with real Supabase Auth
   (email/password is simplest for a single admin user — create that one
   user via Supabase dashboard → Authentication → Users → Add user, don't
   build public signup).
3. Rewrite `catalogue_admin_manage_v1_sans.html` and
   `catalogue_intake_v1_sans.html` to read/write the `works` table via the
   Supabase JS client instead of the hardcoded array + localStorage —
   including real Edit/Delete (no more "export JSON, integrate later").
4. Wire photo uploads (intake form) to the `work-photos` Storage bucket and
   `work_photos` table instead of embedding base64 in the JSON export.
5. Wire voice annotations similarly to `work-audio` / `work_annotations`.
6. Update `catalogue_v10_sans.html` and `catalogue_entry_v6_sans.html`
   (public pages) to read from the `works`/`series` tables via the public
   REST API instead of the hardcoded array — `PUBLISHED_SERIES` phase-gating
   logic should come from `series.published` in the DB at that point, not a
   hardcoded JS array, so toggling a phase live is a database update, not a
   code deploy.
7. Decide what happens to the five duplicated hardcoded `works` arrays
   currently spread across `catalogue_v10_sans.html`,
   `catalogue_entry_v6_sans.html`, `catalogue_admin_v1_sans.html`,
   `catalogue_admin_manage_v1_sans.html`, `catalogue_intake_v1_sans.html` —
   once the DB is the source of truth, these should be deleted, not kept in
   sync by hand.
8. Test end-to-end on GitHub Pages (not just locally) before considering
   this phase done — Supabase calls need to work from that real origin.

## Known open items unrelated to backend (don't lose track)
- MOD CR 8 medium classification still unresolved.
- Pictographs medium description needs the real source text.
- Full image-mismatch audit of the other 27 works (like MOD CR 6) not done yet.
- Legal terms text is still a placeholder draft, needs attorney review.
