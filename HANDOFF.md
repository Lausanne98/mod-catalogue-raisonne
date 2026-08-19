# Session Handoff — 2026-08-19 (evening)

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
couple minutes. A session's own assigned branch (e.g.
`claude/magical-albattani-s5wf03`) is very likely *not* that branch — check
before assuming a push will actually deploy. This confusion cost real time
today: verify with a live `curl` against `cr.micheleokadoner.com`, not by
trusting the branch name you were told to develop on.

## What's live right now
Check `HTMLs/` yourself before trusting this list — it's a snapshot, not
enforced:

- Browse: `catalogue_v66_sans.html`
- Entry: `catalogue_entry_v63_sans.html`
- Intake: `catalogue_intake_v63_sans.html`
- Admin dashboard: `catalogue_admin_v63_sans.html`
- Manage Works: `catalogue_admin_manage_v63_sans.html`
- Manage Materials: `catalogue_admin_materials_v27_sans.html`
- Manage Series: `catalogue_admin_series_v29_sans.html`
- Admin login: `catalogue_admin_login_v63_sans.html`
- Chronology: `catalogue_chronology_v58_sans.html`
- Bio: `mod_bio_v63_sans.html`
- Preview gate: `preview_gate_v47_sans.html`

Stable URL aliases (hand-maintained, point at whichever version above is
current): `/admin`, `/works`, `/entry`, `/chronology`, root `/`.

`HTMLs/modcr-client.js` is shared and unversioned — edited in place, affects
every page that loads it. No cascade needed when it changes.

## What happened this session
1. **Recovered from a repo/branch mismatch at session start.** The assigned
   branch was ~3 weeks stale (main); the real current work lived on
   `claude/mod-cr-backend-verify-unrmak`. Reconciled by resetting the
   assigned branch to match it, with the user's explicit sign-off.
2. **Populated MOD CR 2's DB record** with the full May-17-reference content
   (dimensions, inscriptions, description, provenance, exhibitions,
   literature, remarks, revisions) as a live proof the entry page correctly
   renders every section once real data exists — it did.
3. **Fixed a real bug**: the entry page's main-image logic never checked
   `work.legacy_image_url`, only `work_photos` — so every work whose only
   image came from the original site migration (most of the catalogue,
   since `work_photos` still has ~zero real rows) showed "Image pending"
   despite having a real, usable photo. Fixed (entry v57→v58); also added a
   read-only legacy-image preview in the intake photo editor, since it was
   otherwise invisible there too.
4. **Fixed a real security/data bug**: `isPublished()` on Browse and Entry
   checked series-publish state but never the work's own `published` flag —
   invisible to anonymous visitors (RLS already blocked drafts for them),
   but a logged-in admin session legitimately sees every row, and this was
   the missing second gate that should have kept drafts off the
   public-facing pages regardless. Fixed, per explicit "no exceptions"
   direction: `if(!w.published) return false;` first, unconditionally.
5. **Fixed a real bug affecting every upload**: `crypto.randomUUID()` (used
   to generate temp/storage-path IDs for photos and voice annotations) has
   no fallback and is `undefined` outside a secure context. `http://` (not
   `https://`) requests to `cr.micheleokadoner.com` are currently served
   directly rather than redirected — confirmed live, not enforced HTTPS —
   so any visit over plain HTTP silently broke every upload with zero
   visible error. Added a manual-UUID fallback (`modcrGenId()`) in both the
   intake page's own script and the shared `modcr-client.js`, so uploads
   work regardless of how the page was reached.
6. **New field**: `works.photo_credit` (nullable text). Title Source and
   the image credit line on the entry page now both default to "MOD
   Studio" / "Courtesy of MOD Studio" when unset, instead of hiding
   (per explicit request — these two fields intentionally don't follow the
   usual hide-if-empty rule).
7. **Manage Works**: rows are now clickable through to Edit; Title/MOD
   CR/Date/Material column headers sort on click (toggle direction on
   repeat click); Material sorts alphabetically by tag, then chronologically
   within a material.
8. **Mobile admin header** (Work Intake page only so far): back arrow +
   hamburger menu replacing the inline nav list that wrapped into a mess on
   phone width. Two follow-up bugs from this same feature were found and
   fixed same-session: the hamburger was present but pushed off-screen
   (`.header-title` had no `flex-shrink`/`min-width`), and the mobile CSS
   only shipped on the intake page, not the rest of admin yet.
9. **Unlocated-work badge** (referenced mid-session, see live entry page —
   a small "i" info-circle next to the classification pill for a work with
   no provenance on record).
10. Confirmed working, live, end-to-end on the user's own iPhone (Brave):
    photo upload, voice-annotation recording, and naming a voice annotation.

## Open items — in priority order

1. **GitHub Pages "Enforce HTTPS" is not enabled for this custom domain.**
   Confirmed via direct test: `http://cr.micheleokadoner.com` returns real
   content (200), not a redirect. This is a real risk beyond the upload bug
   it caused — the admin login form could transmit credentials in cleartext
   if reached over HTTP. **User needs to enable this themselves** in GitHub
   repo → Settings → Pages — no tool available to this session exposes that
   setting. Flagged to the user twice this session; not yet confirmed done.
2. **Mobile hamburger/back-arrow header only exists on the intake page.**
   Dashboard, Manage Works, Manage Series, Manage Materials, and Admin
   Login all still have the old wrapping inline-nav-list header on phone
   width. Same fix, not yet propagated — natural next design pass.
3. **The 5 flagged curatorial discrepancies** (CR13, CR14, CR19, CR20,
   CR110) still sit in Manage Works awaiting the user's/artist's judgment
   call — explicitly deferred again this session, not code work.
4. **Legacy-site and 3rd-party (gallery/museum) photo migration** — discussed
   at length, confirmed technically feasible (download → Storage upload →
   real `work_photos` row, same path the intake form itself uses), but
   **explicitly held off** by the user until the studio confirms the site
   and admin are working end-to-end. Two real constraints flagged for
   whenever this resumes: per-work verification (not bulk scraping — CLAUDE.md
   already documents two real image-mismatch failures from doing this
   carelessly once before), and confirming reproduction rights before
   pulling anything from a 3rd-party institutional site.
5. **Deferred admin refinements requested 2026-08-19** (Manage Works
   clickable rows + sortable columns) — **done this session**, see above.
   Removing this note now that it's shipped; keeping the history in git log.
6. Real-hardware voice-annotation test (Snowball USB mic, studio) — not
   re-confirmed this session; last known-good test used a fake audio
   device. Today's session did confirm real iPhone mic recording works.

## How to verify "what's actually live" instead of trusting this file
```
git log --oneline -15
ls HTMLs/ | grep _sans.html | sort -t v -k2 -n   # eyeball the highest version per prefix
```
Confirm you're on the actual deploying branch first (see "Branch reality"
above) — checking version numbers on the wrong branch will mislead you.
Or just open `cr.micheleokadoner.com` and check the URL it redirects to.
