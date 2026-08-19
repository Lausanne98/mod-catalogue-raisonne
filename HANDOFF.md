# Session Handoff — 2026-08-18

Purpose of this file: a snapshot of exactly where the project stands *right now*,
for starting the next Claude Code session cleanly. This is different from
`CLAUDE.md` — that file holds durable conventions that should basically never
need re-explaining; this file is a point-in-time status report, meant to be
**regenerated at the end of each session**, not accumulated forever. Once a new
session reads this and gets oriented, it's fine to let this file go stale again
until the next handoff — it's disposable by design, unlike CLAUDE.md.

**Do not put credentials of any kind in this file** — this repo is public
(served via GitHub Pages), so anything committed here is visible to anyone.
Admin login, Supabase dashboard access, etc. should be shared out-of-band
(password manager), never written into a file that goes into git.

## What's live right now
Branch `claude/mod-cr-backend-verify-unrmak`, deploying straight to GitHub
Pages (`cr.micheleokadoner.com`) with no PR/merge step — every push goes live
within a minute or two. Current canonical version of each page (check
`HTMLs/` if these drift — this list is a snapshot, not enforced):

- Browse: `catalogue_v60_sans.html`
- Entry: `catalogue_entry_v56_sans.html`
- Intake: `catalogue_intake_v55_sans.html`
- Admin dashboard: `catalogue_admin_v55_sans.html`
- Manage Works: `catalogue_admin_manage_v55_sans.html`
- Manage Materials: `catalogue_admin_materials_v19_sans.html`
- Manage Series: `catalogue_admin_series_v21_sans.html`
- Admin login: `catalogue_admin_login_v55_sans.html`
- Chronology: `catalogue_chronology_v52_sans.html`
- Bio: `mod_bio_v57_sans.html`
- Preview gate: `preview_gate_v41_sans.html`

Stable URL aliases (hand-maintained, point at whichever version above is
current): `/admin`, `/works`, `/entry`, `/chronology`, and root `/`.

## What happened this session (long — see git log for full detail)
1. Finished/verified the DB-driven Chronology rewrite.
2. Admin nav cleanup rounds (removed "About", removed redundant "Manage"
   wording, separated Chronology from collection-item nav links).
3. Pre-demo dry run — found and fixed a dead entry-page nav dead-end and a
   missing `materials` table.
4. Built 4 stable URL aliases (`/admin`, `/works`, `/entry`, `/chronology`).
5. Added italics support + Exhibition History protocol text to intake form.
6. Added the ability to name a voice annotation after recording it.
7. **Major**: rebuilt the Entry page twice.
   - First pass: unified, DB-driven layout replacing hardcoded CR2-only
     static markup, added Provenance/Exhibitions/Literature/Annotations/
     Related Works sections, removed a redundant classification box.
   - Second pass (this most recent stretch): the user flagged that the
     no-sidebar direction from an earlier session had actually thrown away
     the *original May design brief* (a Claude-chat mockup,
     `preview_entry_v6.html` / internally `catalogue_entry_v6_sans.html`).
     Rebuilt again to restore: left `.subnav` sidebar (back-link, dynamic
     "In this entry" jump list, Series list, Print button), breadcrumb with
     series link, classification pill repositioned to match the mockup but
     sourced from `materials.label` instead of literally repeating
     `work.medium` (avoids reintroducing an earlier-fixed duplication bug).
     Added two new fields end-to-end (schema → admin → display): `collection`
     and `revisions`. Made the classification pill clickable (links to
     Browse pre-filtered by material) and added `?tag=`/`?series=` URL-param
     support to Browse so those links actually work. Fixed the content
     column to center in the space next to the fixed sidebar. Fixed two
     real date-parsing bugs in the shared `dateListSection()` helper
     (undated lines landing in the wrong CSS grid column; full ISO dates
     like `2026-05-01` getting truncated).
8. Found and fixed an unrelated live bug: the preview-access gate redirect
   in `modcr-gate.js` was pointing at a page version 16 rounds stale.
9. See `CLAUDE.md` → "Entry page layout" and "Admin/front-end field parity"
   for the actual current rules this all landed on — that's the durable
   record, this file is just how we got here.

## Schema migrations run this session (all confirmed live via anon-key query)
- `work_annotations.label`
- `works.title_source`, `works.inscriptions`
- `works.collection`, `works.revisions`

`supabase/schema.sql` is the source of truth for the full schema — every
migration in it is written as a self-healing `alter table ... add column if
not exists`, safe to re-run.

## Open / not yet done
- Real-hardware test of voice annotations with a Snowball USB mic at the
  studio — not yet confirmed by the user (last automated round-trip test,
  using a fake audio device, passed end-to-end).
- `supabase/PROGRESS.md` is stale (references a since-resolved PR #2, an old
  28-work count, and a since-fixed MOD CR 8 item) — worth retiring or
  rewriting; it's a different file from this one and wasn't kept current.
- No other known open bugs as of this commit.

## Deferred: Manage Works admin refinements (requested 2026-08-19)
User explicitly asked to hold these until the major issues (backend
verification, real content population) are resolved — do not implement yet:
- Clicking anywhere on a work's row (not just the "Edit" link) should
  navigate to that work's edit view.
- The column headers (Title, MOD CR, Date, Material) should be clickable
  to sort the table by that column.
- Sorting by Material specifically: alphabetical by material name first,
  then by year made as the secondary sort (not just alphabetical, and not
  just by year).

## How to verify "what's actually live" instead of trusting this file
```
git log --oneline -15
ls HTMLs/ | grep _sans.html | sort -t v -k2 -n   # eyeball the highest version per prefix
```
Or just open `cr.micheleokadoner.com` and check the URL it redirects to.
