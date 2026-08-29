# Session Handoff — 2026-08-29

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

## Branch reality — read this first
The branch that actually deploys to `cr.micheleokadoner.com` is
**`claude/mod-cr-backend-verify-unrmak`** — push there (or wherever it gets
renamed to) directly, no PR, no merge step; every push goes live within a
couple minutes via GitHub Pages' "pages build and deployment" workflow. A
session's own assigned branch (e.g. `claude/magical-albattani-s5wf03`) is very
likely *not* that branch — this session pushed to both every round, but don't
assume that's always true. Verify with a live `curl` against
`cr.micheleokadoner.com`, not by trusting the branch name you were told to
develop on. Also: the custom domain sits behind a CDN with
`cache-control: max-age=600` — right after a push, a live `curl` from this
session can return 200 with fresh content while the user's own browser (a
different edge node, or their own cache) still shows the previous version or
even a stale 404 page for up to several minutes. If the user reports a stale
version shortly after a push, check the GitHub Actions "pages build and
deployment" run for that commit before assuming something is actually broken.

## What's live right now
Check `HTMLs/` yourself before trusting this list — it's a snapshot, not
enforced:

- Browse: `catalogue_v72_sans.html`
- Entry: `catalogue_entry_v66_sans.html`
- Intake: `catalogue_intake_v67_sans.html`
- Admin dashboard: `catalogue_admin_v64_sans.html`
- Manage Works: `catalogue_admin_manage_v64_sans.html`
- Manage Materials: `catalogue_admin_materials_v28_sans.html`
- Manage Series: `catalogue_admin_series_v35_sans.html`
- Admin login: `catalogue_admin_login_v64_sans.html`
- Chronology: `catalogue_chronology_v59_sans.html`
- Bio: `mod_bio_v63_sans.html`
- Preview gate: `preview_gate_v47_sans.html`
- **New this session**: Guide to the Catalogue — `catalogue_guide_v1_sans.html`
  (no prior version; first release).

Stable URL aliases (hand-maintained, point at whichever version above is
current): `/admin`, `/works`, `/entry`, `/chronology`, root `/`.

`HTMLs/modcr-client.js` is shared and unversioned — edited in place, affects
every page that loads it. No cascade needed when it changes.

## What happened this session

1. **Series Overview panel layout** — the curatorial text column was 1/3
   width with citations crammed into the remaining 2/3; widened to an even
   50/50 split per direct request (v66→v67).

2. **"Museum Collections" quick link** added to the Browse toolbar's
   quick-links row, after "Large-Scale Works".

3. **Sub Series feature, built and then reworked twice based on live
   feedback:**
   - Schema: `series.parent_slug` (nullable, self-referencing FK) — one
     level of nesting only, broad bucket → named sub-series.
   - Manage Series (`catalogue_admin_series`) now lets you create a named
     sub-series under an existing top-level series. This went through
     several rounds of real usability fixes, in order: (a) a manual "Slug"
     text field was removed — the slug is now auto-generated from the typed
     name, shown as a live read-only preview; (b) the Add-a-Series form and
     the "All Series" list were unified into **one** All-Series/Sub-Series
     tab control instead of two separate, unlinked toggle groups — which tab
     you're on decides both what the add-form does (adds a top-level series,
     or requires+uses a Parent) and what the table shows; (c) "All Series"
     was fixed to mean literally all series (it briefly, incorrectly, only
     showed top-level ones); (d) primary buttons changed from pure black to
     a dark warm grey (`--btndark: #46433f`).
   - Browse page: a "Sub Series" dropdown sits in the main filter row next
     to the Series dropdown (**not** inside the collapsible Context panel —
     it started there, then was moved out at direct request so it works for
     *any* series with children, not just the two series that happen to
     have a hardcoded curatorial overview essay). Picking a sub-series
     filters the grid to just that body of work.
   - Three **placeholder sub-series** exist right now under Early Clay,
     created live during this session as a demo/starting point, published,
     but with **zero works assigned to them yet**: `descending-figures`
     (Descending Figures), `tattooed-dolls` (Tattooed Dolls),
     `burial-pieces` (Burial Pieces). Whoever does the next curatorial pass
     should either assign real works to these (Manage Works → edit → set
     Series to the sub-series slug) or delete them if they weren't wanted.

4. **Guide to the Catalogue** — new standalone page
   (`catalogue_guide_v1_sans.html`), reusing the site's existing header/
   subnav/footer chrome. Covers: searching/browsing, how entries are
   organized, Medium vs. Series (incl. the new Sub Series mechanic), MOD CR
   numbering (incl. the provisional 100+ block), titles, images/credits,
   dates, dimensions/collection, provenance/exhibitions/literature, and how
   to cite an entry. The previously-dead "Guide" button (Browse toolbar) and
   every page's dead "Guide to the Catalogue"/"How to Cite" footer links now
   point at it. Also fixed a stale footer link found in passing
   ("Add / Update a Work" was pointing at an admin-login version four
   revisions behind current).

5. **"Highlights"** — a new small admin-only classification, independent of
   Series/Medium, added in two rounds:
   - Round 1: `works.is_large_scale`, `works.is_museum_collection` (both
     `boolean not null default false`) — genuinely new admin-set flags,
     shown as a small badge on the entry page only when true, and back two
     of the Browse toolbar's quick-links.
   - Round 2, per explicit follow-up request: `works.is_public_installation`
     and `works.is_unlocated` were **also** added as explicit admin
     checkboxes, replacing what had briefly been computed logic
     (respectively: `series==='public-installations'`, and "no provenance on
     record"). **This is a real, deliberate behavior change**: any work that
     used to show the "Unlocated Work" badge automatically because its
     Provenance field was empty stopped showing it the moment this shipped,
     and will only show it again once someone explicitly checks the
     Unlocated box for that work in Work Intake. Nobody has gone through and
     re-checked those boxes yet — see Open Items.
   - All four checkboxes sit on one compact row in Work Intake (a two-row
     layout was tried first, then condensed per feedback that it gave the
     rarely-used section too much visual weight).
   - Browse quick-links: Public Installations, Large-Scale Works, Museum
     Collections, and Unlocated Works are now all wired to real filters.
     Clicking one clears the rest of the filter bar (each is a clean
     "shortcut view", not a facet meant to combine with search/tag/decade).

6. **Removed** the separate collapsed "Exhibitions" sub-panel under a
   series' Overview on Browse — it only ever showed a "being compiled"
   placeholder and duplicated the real Exhibitions column already inside
   the Overview panel itself.

7. **Onboarding reset, explicitly requested at session end**: every work's
   `published` flag was set to `false` via a single bulk `PATCH` against
   Supabase (confirmed live: 0 works published, all 54 in draft
   immediately after). **The public Browse page will show no works at all
   until someone manually reviews and republishes them one at a time from
   Manage Works.** This was deliberate — the user wants the artist to
   review everything before it's live again — but it means the site will
   look empty to any visitor right now. `series.published` flags were left
   untouched.

## Open items — in priority order

1. **Every work is currently unpublished (see item 7 above).** The site is
   live but will show an empty catalogue until works are manually reviewed
   and republished from Manage Works. This is intentional, not a bug — but
   the next session (or the artist) needs to actually do that republishing
   pass, or the public site stays empty indefinitely.
2. **Unlocated / Public Installation flags need a manual pass.** Before this
   session, "Unlocated Work" was inferred automatically from a blank
   Provenance field. That inference is gone — it's now a plain checkbox
   nobody has gone back and set for existing works. Whoever does the
   republishing pass in item 1 should also check these two boxes on works
   that genuinely qualify, or the badges (and the Browse quick-links they
   power) will under-report until that happens.
3. **The three placeholder sub-series under Early Clay have no works
   assigned** (see item 3 above) — either populate them for real or delete
   them.
4. **Mobile hamburger/back-arrow header only exists on the Work Intake
   page.** Dashboard, Manage Works, Manage Series, Manage Materials, and
   Admin Login still have the old wrapping inline-nav-list header on phone
   width. Not touched this session.
5. **The 5 flagged curatorial discrepancies** (CR13, CR14, CR19, CR20,
   CR110) still sit in Manage Works awaiting the user's/artist's judgment
   call — not code work, not touched this session.
6. **Legacy-site and 3rd-party (gallery/museum) photo migration** —
   confirmed technically feasible in an earlier session, explicitly held
   off by the user until the studio confirms the site/admin are working
   end-to-end. Two real constraints whenever this resumes: per-work
   verification (not bulk scraping — CLAUDE.md documents two real
   image-mismatch failures from doing this carelessly once), and confirming
   reproduction rights before pulling anything from a 3rd-party
   institutional site.
7. GitHub Pages "Enforce HTTPS" — flagged as missing in an earlier session;
   the user later reported it fixed. Not re-verified this session.

## How to verify "what's actually live" instead of trusting this file
```
git log --oneline -15
ls HTMLs/ | grep _sans.html | sort -t v -k2 -n   # eyeball the highest version per prefix
```
Confirm you're on the actual deploying branch first (see "Branch reality"
above) — checking version numbers on the wrong branch will mislead you.
Or just open `cr.micheleokadoner.com` and check the URL it redirects to. If
something looks stale right after a push, check the GitHub Actions "pages
build and deployment" run for that commit before concluding the deploy
failed — CDN propagation lag is more likely than a broken deploy.
