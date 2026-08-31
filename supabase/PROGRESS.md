# Backend build — session handoff

## Project
- Supabase project URL: `https://kuyyrygvaotsrhbyjyjw.supabase.co`
- Publishable (anon) key: `sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx`
  (safe to be public — this is the client-side key by design — access control
  is enforced by the RLS policies in `schema.sql`, not by keeping this secret)
- The `service_role` secret key was never shared with Claude and must stay
  that way — full unrestricted DB access, private only.

## Supabase auto-pause keepalive
Supabase's free tier auto-pauses a project after 7 days with zero API
activity. This site has no server of its own (static HTML on GitHub Pages,
no Vercel/Node build to hang a cron-triggered API route off of), so instead
`.github/workflows/supabase-keepalive.yml` is a GitHub Actions scheduled
workflow (`schedule: cron '0 8 * * *'`, plus `workflow_dispatch` for a manual
run) that does one read-only request a day (`select=slug&limit=1` against
the public `series` table, using the anon key above) to keep the project
active. Costs nothing — free GitHub Actions minutes, no new infra. Not
verified against the live project this session — this sandbox's egress
proxy blocks `*.supabase.co` outright (see "Not yet independently verified"
below), same known limitation, so confirm the workflow actually succeeds
from the Actions tab after it's merged.

## Status as of this session
- **`supabase/schema.sql` had a real bug found and fixed this session**: the
  28-work migration used `tag='jewelry'` for the 7 jewelry works and
  `tag='installation'` for MOD CR 8 — neither value is in the `tag` check
  constraint. Because the migration is one multi-row `INSERT`, a single
  constraint violation would have aborted the *entire* insert transactionally
  — so if the user ran the original file, `works` is almost certainly still
  empty (0 rows) even though `series` (a separate statement) landed fine.
  Fixed: jewelry rows now use their real medium (`silver`/`gold`); MOD CR 8's
  `tag` is left `NULL` (column is now nullable) with a `flag` explaining the
  taxonomy is genuinely undecided — consistent with CLAUDE.md's "flagged for
  a real decision, not guessed" note, which the original migration violated.
  The file also gained a self-healing `ALTER TABLE` block so re-running it
  fixes a table that was already created under the old, broken constraint.
- Also fixed: the public RLS read policies (`works`, `work_photos`,
  `work_annotations`) only checked whether a row's *own* series was
  published. That silently defeats the cross-categorization rule in
  CLAUDE.md (a ceramic work dated before 2000 should be visible under Early
  Clay regardless of its own series' publish state) — Postgres would filter
  the row out before any client-side JS ever saw it. All three policies now
  also allow the row through when it's a pre-2000 ceramic work and
  `early-clay` is published.
- **Not yet independently verified against the live project** — this
  session's cloud environment could not reach `*.supabase.co` (proxy
  returned 403 policy-denial on every attempt; see "Blocked this session"
  below). **First thing a new session with working network access should
  do**: paste the current `supabase/schema.sql` into the Supabase SQL
  Editor and run it (safe to re-run), then confirm with
  `GET {url}/rest/v1/works?select=cr_number,title,series,tag` (`apikey`
  header set to the key above) — expect 28 rows this time, tags included.

## What's built so far
All on branch `claude/file-contents-review-isefql` / `claude/mod-cr-backend-build-suwvdp`.
See `CLAUDE.md` for full project conventions.

**This session** wired the whole site to Supabase for real, per the phase-1
plan below — new versioned pages, old ones left untouched per the versioning
rule:
- `HTMLs/modcr-client.js` — new shared module: one Supabase client, work/series
  fetchers, auth helpers, storage upload/delete helpers. Every DB-backed page
  loads `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2` then this file,
  instead of five copies of the same hardcoded `works` array.
- `catalogue_admin_login_v2_sans.html` — real Supabase Auth (email/password)
  replacing the client-side passphrase gate. **No user has been created yet**
  — do that via Supabase Dashboard → Authentication → Users → Add user
  (single admin user, no public signup) before this login page can work.
- `catalogue_admin_v2_sans.html` — dashboard: real auth gate, stat tiles and
  a "Flagged for Review" list both computed from live `works` data instead of
  a hardcoded array. Dropped the old "pending changes / export JSON" panel —
  no longer needed now that intake writes straight to the DB.
- `catalogue_admin_manage_v2_sans.html` — list/search/filter reads `works`
  live; Delete is a real `DELETE` (with confirm), not a "mark pending."
  Material filter options are now derived from whatever tags actually exist
  in the data instead of a stale hardcoded list.
- `catalogue_intake_v2_sans.html` — full rewrite. "Save Work" does a real
  insert/update against `works` (now also collects `cr_number` and `series`,
  which the old form never captured — both are required, not-null columns).
  Photos upload to the `work-photos` bucket + `work_photos` rows (with a
  primary-photo toggle); voice annotations upload to `work-audio` +
  `work_annotations`, both gated until the work has been saved once (a
  `work_id` foreign key has to exist first). No more base64-in-JSON-export.
- `catalogue_v11_sans.html` and `catalogue_entry_v7_sans.html` — public
  pages now fetch `works` + `series` from Supabase on load instead of a
  hardcoded array; `PUBLISHED_SERIES` is gone — phase-gating reads
  `series.published` live, so toggling a phase is a database update, not a
  code deploy, as originally planned. The curatorial `SERIES` narrative
  object (carousel images, overview text, exhibition/press citations) stays
  hardcoded in `catalogue_v11_sans.html` — there's no schema for that content
  and PROGRESS.md never asked for it to move.
- `catalogue_chronology_v7_sans.html` and `mod_bio_v12_sans.html` — trivial
  version bumps, only to fix now-stale nav links to `catalogue_v10_sans.html`
  (same pattern as PR #2). Nothing else in either file changed.
- `index.html` updated to redirect to `catalogue_v11_sans.html`.
- The five duplicated hardcoded `works` arrays are gone from every *new*
  page. The old versions (`catalogue_v10_sans.html`,
  `catalogue_entry_v6_sans.html`, `catalogue_admin_v1_sans.html`,
  `catalogue_admin_manage_v1_sans.html`, `catalogue_intake_v1_sans.html`,
  `catalogue_admin_login_v1_sans.html`) are untouched and still self-contained
  — that's intentional per the versioning rule (never edit a version in
  place); they're simply superseded now.

## Update — network access confirmed working (this session)
Network access to `*.supabase.co` now works — the previous session's proxy
403 is gone. Verified with:
```
curl "https://kuyyrygvaotsrhbyjyjw.supabase.co/rest/v1/works?select=cr_number,title,series,tag&order=cr_number" \
  -H "apikey: sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"
```
Response: `404 {"code":"PGRST205", "message":"Could not find the table 'public.works' in the schema cache"}`
— a real API response (not a network/proxy error), confirming reachability.
It also confirms `schema.sql` has **not been run yet** against this project
(no tables exist at all yet, not even a broken `works` with 0 rows).

Also code-reviewed every DB-backed page this session
(`modcr-client.js`, both admin login/manage/intake v2 pages,
`catalogue_v11_sans.html`, `catalogue_entry_v7_sans.html`) against the schema
and CLAUDE.md rules — wiring looks correct: RLS-gated fetch/write helpers,
phase-gating via live `series.published`, and the ceramic-pre-2000 →
Early Clay cross-categorization rule are all implemented consistently in
both the manage-list filter and the public catalogue/entry pages.
No code changes were needed.

## Verification complete (this session) — backend confirmed working end-to-end
The user ran `schema.sql` in the SQL Editor and created the one admin user
(`atelier@ctmeq.com`) via Dashboard → Authentication → Users. Both steps
required dashboard/service-role access this session intentionally doesn't
have, so the user did them manually; everything below was then verified
independently against the live project:

1. **Migration**: `select cr_number, title, series, tag, flag from works
   order by cr_number;` in the SQL Editor confirmed all 28 rows landed with
   valid tags — jewelry works correctly show `silver`/`gold` (not the old
   broken `jewelry` value), MOD CR 8 shows `tag = NULL` with its flag, MOD
   CR 6 shows its icon-mismatch flag. The REST endpoint
   (`GET .../rest/v1/works?select=...`) returns 12 rows through the public
   anon key — correct, not a bug: RLS is filtering to the published
   `early-clay` series plus the cross-categorized pre-2000 ceramics, exactly
   as designed since only Early Clay is live so far.
2. **Auth**: real password sign-in verified working
   (`catalogue_admin_login_v2_sans.html` → `signInWithPassword` →
   redirects to the dashboard).
3. **Full smoke test**, driven with Playwright against the live project
   (local static server for the HTML, real Supabase backend, fake-mic
   device for the recorder, a local npm-installed copy of
   `@supabase/supabase-js` in place of the CDN script — see note below):
   sign in → Manage Works loads all 28 works, search and material-filter
   both work correctly → Intake: created a test work, uploaded a real photo
   (appeared in the grid), recorded a voice annotation with a synthetic
   mic device (uploaded and appeared in the list), deleted the test work →
   confirmed removed from Manage Works → public catalogue confirmed
   showing Early Clay live and everything else "Coming Soon," with the
   deleted test work correctly absent → entry page for MOD CR 1 confirmed
   rendering live title/data from the DB.
4. **Bug found and fixed during the smoke test**: `modcrDeleteWork` in
   `modcr-client.js` only deleted the `works` row. Postgres cascade cleans
   up the `work_photos`/`work_annotations` *rows*, but the actual uploaded
   files in the `work-photos`/`work-audio` Storage buckets are a separate
   system cascade can't reach — they were left orphaned after every delete.
   Confirmed via `storage.list()` after the first test-work deletion (files
   still present), fixed `modcrDeleteWork` to look up and remove the
   associated storage objects before deleting the row, then re-ran the full
   create → photo → annotation → delete cycle and confirmed both buckets
   come back empty afterward.

**Note on jsdelivr for local testing**: `cdn.jsdelivr.net` (where every page
loads `@supabase/supabase-js` from) is blocked by this session's org egress
policy — confirmed via `curl` (403 on CONNECT), not worked around. For the
Playwright smoke test only, the same package version was installed from the
always-allowed npm registry and served locally in place of the CDN request;
the actual page/repo files still reference the CDN as before and were not
changed. This has no bearing on production — GitHub Pages visitors load the
CDN script directly and aren't subject to this session's sandboxed policy.

**Still open, unrelated to backend correctness**:
- Test on the real GitHub Pages origin, not just locally — PR #2 (subnav/
  image self-hosting) is still open/unmerged, and this branch would need to
  land there too before GitHub Pages actually serves any of this.

## Known open items unrelated to backend (don't lose track)
- MOD CR 8 medium classification still unresolved (now correctly reflected
  as `tag = NULL` + a `flag` in the DB, not guessed).
- Pictographs medium description needs the real source text.
- Full image-mismatch audit of the other 27 works (like MOD CR 6) not done yet.
- Legal terms text is still a placeholder draft, needs attorney review.
