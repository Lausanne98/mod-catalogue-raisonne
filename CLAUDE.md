# MOD Catalogue Raisonné — conventions

## Agent team
See `AGENT_ARCHITECTURE.md` at the repo root for the named agent team
(Chloe/Khalo/Timur), their scoped permissions, and the write-access model
for Archivist's Drafts (New Entries / Revisions). `.claude/skills/
associate-archivist/SKILL.md` is Khalo's actual operating instructions.

## Provisional CR numbering
`cr_number` should ultimately reflect chronological creation order, but the full
chronology isn't settled yet — many works (e.g. student works) are still to be
migrated and may need to slot in earlier than anything catalogued so far. Rather
than assign the next sequential number and have to renumber everything later,
newly migrated/added works that aren't yet placed in final chronological order
get provisional numbers starting at **100** (not continuing from the current
highest number). Numbers below 100 stay reserved for the eventual full
chronological renumbering, which happens once before the site is officially
published — CR numbers are expected to be fluid until then, not fixed on
assignment.

**Within the 100+ block itself, numbers must still be assigned in chronological
(by-year) order** — 100 is the earliest-dated work in that block, and each
subsequent number is the next-earliest, going up. This is not optional or
"eventually" — it applies every time a new work is added to the block, not just
once at the end. Do not assign the next sequential number by migration/discovery
order (e.g. "whatever I processed first") — sort by `year` first. Ties (same
year) can be broken arbitrarily, but a work from a later year must never get a
lower number than a work from an earlier year. A work with no known year at all
goes at the very end of the block (after every dated work), since it can't be
placed chronologically. Whenever a new work is added to the 100+ block, re-check
whether it needs to be inserted in the middle (shifting later numbers up) rather
than just appended at the end — appending only happens to be correct if the new
work is in fact the latest-dated one so far.

## Versioning rule
Live pages are the `.._sans.html` files in `HTMLs/`. When a file needs a meaningful
change: never edit an existing version in place. Copy it to the next version number
first, edit the copy, and leave the old version byte-identical (verify with
`git diff <initial-commit-sha> -- <path>`). Never skip a version number, never drop
the `_sans` suffix. Superseded versions eventually move to `Archive/`.

### Stable entry points (root-level redirect stubs)
`index.html` (`cr.micheleokadoner.com/`) and `admin/index.html`
(`cr.micheleokadoner.com/admin`) are plain, unversioned redirect stubs, exempt
from the rule above and meant to be edited in place, the same as
`HTMLs/modcr-client.js`. `index.html` redirects straight to the current
`catalogue_landing_vN_sans.html`. `admin/index.html` is a two-hop chain, not a
direct link to the Dashboard: it redirects to `catalogue_admin_login_vN_sans.html`,
which (in its own inline script, not a CLAUDE.md-visible `url=` target) redirects
again — to the current `catalogue_admin_vN_sans.html` if a session already
exists, or after a successful sign-in otherwise. This chain existed before an
`admin.html` root-level stub was tried and found dead: GitHub Pages resolves
`/admin` to the `admin/index.html` **directory** index, not a same-named flat
file at the root, so a competing root `admin.html` is never actually reached —
don't recreate one.

**Three places all have to agree, or `/admin` silently lands on a stale
version** — this already happened once (`admin/index.html` and the login
page's two hardcoded redirects had drifted to a version several bumps behind,
undetected for a long time because normal version-bump cross-reference sweeps
only ever grep for `href="..."` link patterns, not the `window.location.href =
'...'` JS string literals the login page uses):
1. `index.html`'s `url=` target, whenever `catalogue_landing_*` bumps.
2. `admin/index.html`'s `url=` target, whenever `catalogue_admin_login_*` bumps.
3. `catalogue_admin_login_*`'s own two `window.location.href` lines (one after
   a successful password sign-in, one for an already-signed-in session), whenever
   `catalogue_admin_*` (the Dashboard specifically, not other admin pages) bumps.
Every other admin page is already reachable from the Dashboard's own nav, which
stays in sync as part of normal version-bump cross-reference upkeep, so it
doesn't need its own root-level stub — only the Dashboard does, because it's
the one thing meant to be reachable before you've navigated anywhere at all.

## Work taxonomy
Every catalogued work has two independent classifications, filterable separately:

**Medium** (material) — a deliberately curated list, managed from the admin
**Manage Materials** page (add/remove a material there): paper, ceramic, bronze,
gold, silver, diamonds, stone, concrete, organic material, glass, steel, canvas,
painting, photography, video. `medium` (free text, e.g. "Raku ceramic", "Bronze
with silver") is the descriptive label shown on the work's page; the `tag` field
is the *filter* value and must match a `materials.slug` row — enforced by a
foreign key in the schema (`works.tag references materials(slug)`), not a hardcoded
check constraint, so a new material added via Manage Materials is automatically a
valid tag. It's still not the same as Series, though: Series is meant to grow
routinely as new bodies of work get organized; Medium changes rarely and
deliberately — a genuinely new material (like `concrete`, added once it turned up
as a recurring material across several works, e.g. "Another Sun") should still be
a considered addition, not silent reuse of the nearest existing tag. Deleting a
material still in use by a work fails (the foreign key blocks it) rather than
silently orphaning that work's tag.

**Series** (category) — open-ended, meant to grow. Unlike Medium, this is not a
fixed short list — it's whatever rows exist in the `series` table, and adding a
new one is a normal, expected operation, not a schema change. See "Granular named
series" below for the two tiers this actually contains in practice. `series` on a
work is the filter value and must match a `series.slug` (internal slugs may differ
from display labels for historical reasons — see the `seriesLabels` map in
`catalogue_entry_v6_sans.html` and the `SERIES` object in `catalogue_v10_sans.html`).

## Tag/series inference rules (for intake and automated research)
When a human or an automated pass (Khalo's Mode B, Researcher's Desk's
`promoteFindingToDraft`) is deriving `tag`/`suggested_series` from a free-text
`medium` string rather than being told them directly, these rules apply —
codified after several staged_works records got mistagged this way:

- **`tag` is always the base material alone, never a compound descriptive
  phrase.** "Organic material in abaca paper" is a medium description, not a
  tag — the tag is `paper` (the more specific material actually named), never
  `organic-material`. `organic-material` is a last-resort tag for when nothing
  more specific applies (e.g. "wax and organic material," no other named
  material) — never picked just because it's a plausible catch-all when a more
  specific material also appears in the same string. (`modcrGuessTagFromMedium`
  in `modcr-client.js` partitions candidates so `organic-material` never wins
  over a more specific match, even when its label is textually longer.)
- **Bronze and other metal objects: wearable → jewelry, everything else →
  bronze-works (Sculpture).** A wearable object type in the title/medium
  (necklace, brooch, pendant, ring, bracelet, earring, cuff, or similar) means
  `jewelry`; otherwise (a faucet, a bowl, a figure, a candelabra, a chair) it's
  `bronze-works`, regardless of the material being precious (bronze, silver,
  gold) — a bowl or sculpture in silver is still Sculpture, not Jewelry, just
  because the material overlaps with what jewelry is often made of.
- **All clay/ceramic work is Sculpture by default.** Any work tagged `ceramic`
  (terra-cotta, porcelain, stoneware, earthenware, etc.) gets `bronze-works`
  unless a more specific named sub-series clearly fits (e.g. `tattooed-dolls`).
  Independent of the Early Clay cross-categorization rule below, which is about
  the *filter* a pre-2000 ceramic work also shows up under, not its own series.
- **Never invent a tag for a material that isn't in the taxonomy.** A medium
  like "brass," with no matching `materials.slug`, does not get mapped to the
  nearest existing tag (e.g. `bronze`) — leave tag/series unset and flag it for
  a human decision (new material vs. mislabel) instead of silently reusing
  whatever tag looks close.

## Cross-categorization rule
Any work with medium/tag "ceramic" and a date before 2000 is cross-categorized into
the "Early Clay" series automatically, in addition to its own assigned series — this
should be implemented as live filter logic (a ceramic work dated pre-2000 shows up
under the Early Clay filter even if its `series` field is something else), not a
one-time manual fix, so it keeps applying as new works are added.

**Early Clay is ceramic-only, and it's a period, not just a material.** A work's
own `series` field must never be `early-clay` unless its medium/tag is `ceramic`
— bronze, silver, gold, etc. are never clay, regardless of date, subject matter,
or stylistic kinship with the early ceramic pieces. (MOD CR 2, "Germinating
Seeds," is bronze but was seeded with `series = early-clay` in the original
migration — that's a data error to fix, not a precedent to follow.) Ceramic is
necessary but not sufficient, though: a *post-2000* ceramic work is still
`tag = ceramic`, but its own `series` should be something other than
`early-clay` (e.g. `bronze-works`, labeled "Sculpture," or `editions` for a
limited-edition run) — Early Clay represents the artist's early-period ceramic
work specifically, not "ceramic at any date." The *only* way a non-directly-
assigned work should ever appear under the Early Clay filter is the
cross-categorization rule above (ceramic + pre-2000) — never by setting
`series = early-clay` directly on a work that isn't both.

## Granular named series
The `series` table holds two tiers, both real, both filterable the same way —
there's no schema distinction between them, just a difference in how broad they
are:
1. **Broad category buckets**: early-clay, jewelry, works-on-paper,
   public-installations, commissions, bronze-works ("Sculpture"), fables,
   editions, publications.
2. **Granular, named sub-series** — a specific body of work, closer to how
   Roy Lichtenstein's catalogue raisonné organizes hundreds of works into very
   specific named series (e.g. "Brushstroke Head [collages]," "Entablature
   Paintings," "Mirror series [prints]") rather than only broad material
   buckets. Reference examples added so far: `thorn-men` (Thorn Men),
   `terrible-chairs` (Terrible Chairs), `talisman-series` (Talisman), `radiant`
   (Radiant), `pollinators` (Pollinators), `hominim-relics` (Hominim Relics),
   `tattooed` (Tattooed).

A work's `series` is whichever of these two tiers is more specifically true for
it — if a named sub-series exists for its body of work (e.g. a Tattooed piece),
use that rather than the broader bucket it would otherwise fall into. This is
expected to keep expanding as more of the artist's work gets organized this way;
adding a new named series is a normal operation (insert a `series` row), not a
special case. It doesn't replace the cross-categorization rule above — a
ceramic/pre-2000 work in a granular series (e.g. `tattooed`) still shows under
the Early Clay filter too, on top of its own more specific series.

## Known open item
MOD CR 8 ("Into the Mysterium," mixed media installation) doesn't have a clean single
Medium value in the taxonomy above — flagged for a real decision rather than guessed.

## Backend
Works and series data now live in Supabase (see `supabase/schema.sql` and
`supabase/PROGRESS.md` for connection details and status). `HTMLs/modcr-client.js`
is the single shared client — every DB-backed page loads the Supabase CDN
script then this file, rather than duplicating client setup or a hardcoded
`works` array per page. It isn't a `.._sans.html` page, so the versioning
rule above doesn't apply to it directly — but it's shared by every admin and
public page, so treat changes to it as touching all of them at once.

## Source PDFs (catalogs, e-cats) don't live in Supabase long-term
A source PDF's *derived* JPEGs and extracted text belong in
`source_materials`/`source-materials` (that's the whole point of
`scripts/catalog_pdf_extractor.py` — see the associate-archivist skill's
"Processing a catalog PDF extraction batch" section). The PDF itself does
not: the real archive location is an external hard drive, same as raw TIFF
masters (see `scripts/archive_indexer.py`). A small PDF (well under
Supabase's project upload cap) can be uploaded directly to
`source_materials` as a `kind: 'pdf'` row for convenience when there's no
EXHD workflow set up yet — that's tolerated, not the target state. Once a
dedicated external-drive folder for source PDFs exists, move any
Supabase-hosted PDF there and stop uploading new ones directly; a large PDF
(Supabase's cap rejects raw e-cats in the 100MB+ range outright) never had
the option anyway and always needs `catalog_pdf_extractor.py` run against
the local file first.

## Credentials / secrets
This repo is public (served via GitHub Pages) — never commit a password, API
secret key, or other credential into any file that goes into git, regardless
of whether it's a code file, a doc, or a handoff note. This includes the admin
login password, the Supabase dashboard password, and the Postgres "Database
password" — none of these belong in `CLAUDE.md`, `HANDOFF.md`, `PROGRESS.md`,
commit messages, or code comments. The Supabase anon/publishable key in
`modcr-client.js` is the one exception — it's meant to be public, safe by
design because RLS (not key secrecy) is the real access-control boundary (see
"Backend" below). Credentials belong somewhere outside git entirely — a
password manager, not a repo file — and should be shared with a new session
out-of-band, not by asking Claude to read or write them into a tracked file.

## Pulling media from the legacy site (micheleokadoner.com)
The legacy WordPress media library is not a reliable 1:1 source of "icon = this work's
photo, title = this work's name." Two failure modes found so far, both from MOD CR 6:

1. **Exhibition icons aren't works.** If a legacy entry is tagged "exhibition," it is
   documentation of a show, not a standalone catalogued work — skip it when pulling
   new works. (Future idea, not built: have Claude scan the works listed in a given
   exhibition and try to pair them with existing work entries under an "Exhibitions"
   field on those entries — a real feature, but a separate task from intake.)
2. **Icon/title mismatches happen.** An image can be sourced correctly from the media
   library but simply not depict the work its title claims (pulled from a different,
   unrelated body of work). Before attaching a legacy-site image to a work record,
   verify the image actually depicts that work — don't assume filename/title proximity
   means they match. If a work's `img` can't be verified, leave it unset (renders as a
   text placeholder, per existing fallback behavior) rather than showing a wrong photo.
   A work with a suspected mismatch should carry a `flag` field describing the issue so
   it surfaces in the admin Manage Works view instead of silently shipping bad data.

## Secondary series (dual categorization)
A work can optionally belong to a second series in addition to its primary one —
e.g. a jewelry piece that's also part of a limited-edition run. Use `works.secondary_series`
(nullable, references `series.slug`) for this rather than changing the primary `series`,
since the work still belongs under its original category too. It's visible under either
series' filter once *either* one is published (enforced in the RLS policies, not just
client-side). This is a general-purpose, manually-assigned second category — different
from the ceramic+pre-2000 cross-categorization rule above, which is an automatic rule
based on medium and date rather than an explicit editorial assignment.

## Process photos
`work_photos.photo_type` distinguishes an ordinary work photo (`'work'`, the default)
from documentation of the work being made — foundry, patina, studio-process shots
(`'process'`). Most works will never have one; it's optional and only shows up (as a
"Process" nav item and section on the entry page) when a work actually has a photo
tagged that way. Process photos are excluded from primary/featured-image selection —
they document the work, they aren't a candidate to represent it.

## Admin/front-end field parity
Every field an admin can populate must render somewhere on the public entry page,
and every category shown on the entry page must have a corresponding admin input —
no orphans in either direction (flagged as a "major architectural issue" when this
slipped once already). Current full set, admin field ↔ entry page display:
title, cr_number, series ↔ header/breadcrumb/sidebar, date_display/year ↔ date line,
medium ↔ medium line, tag ↔ classification pill, dimensions/title_source/inscriptions/
`collection` ↔ data table rows, description/provenance/exhibitions/literature/remarks
↔ their sections, `revisions` ↔ Entry Revisions section. There are two deliberate
exceptions, both admin-only by design and never meant to surface publicly: `flag`
(a data-quality note for the Manage Works view) and `auction_history` (added
2026-09-13 — a sale's price/estimate, distinct from `provenance`'s curated public
ownership history; restructured 2026-09-14 from one free-text field into a jsonb
array of per-sale records — `{house, title, date, estimate, sold, note}` — so the
intake form can present broken-out House/Title/Date/Est./Sold fields with an Add
Sale Record row instead of one paragraph to hand-parse; `note` is a catch-all for
anything that doesn't fit those five, including the citation dump the "New Entry
from Draft" prefill still parks here). `collection` (e.g. "The artist's collection")
and `revisions` (free text, one dated entry per line, same "date, then note" pattern
as Provenance/Exhibitions/Literature — admin-authored, not an automatic change log)
were added 2026-08-18 to close the last two gaps against the May reference design.

## Entry page layout (superseded 2026-08-18 — see below)
As of 2026-08-18 the entry page was reverted to the original May reference design
(`preview_entry_v6.html`, a Claude-chat mockup — internally `catalogue_entry_v6_sans.html`
in that mockup's own self-references) after the no-sidebar direction below caused
real, repeated loss of the original design intent across session handoffs. **The
current, correct layout has a left `.subnav` sidebar**: a "← Browse the Works" back
link, a dynamically-built "In this entry" jump list (only sections that actually
rendered get a jump link — hide-if-empty still applies to the nav itself), a
"Series" list, and a "Print this page" button. The work's series now legitimately
appears in **three** places on the entry page — the `cr-num` header line, the
breadcrumb, and the sidebar's Series list — matching the reference exactly. This
intentionally supersedes the two rules below; they're kept only as a paper trail so
a future session doesn't reintroduce the no-sidebar layout thinking it's restoring
something. If this page changes again, treat the *current live entry page file* and
this note as the source of truth, not the two paragraphs beneath it.

The classification pill (bottom of the meta column, bordered) is sourced from the
formal material classification (`materials.label` for `work.tag`, e.g. "Ceramic")
rather than literally repeating the `work.medium` free-text line above it — the May
mockup's pill duplicated Medium verbatim, which was flagged separately as a
redundant-data-display bug earlier in the project; this keeps the mockup's visual
slot and position but not that specific duplication.

**(2026-09-14, refined same day — see below) Most sections continue in the
right-hand meta column, next to the image — not full-width below it.**
Description, Provenance, Exhibition History, Publications/Literature, Artist's
Annotations, Process, Remarks, How to Cite, and Entry Revisions (`#sections`,
built in `initEntry()`) live *inside* `.meta-col`, right after the
classification pill — matching a real catalogue raisonné reference layout
(checked against the Roy Lichtenstein CR site), where the image sits in the
wide left column and every category continues in the narrower right column
beside it, however long that makes the column. `.entry-top` uses
`align-items: start` so the image column isn't stretched to match the meta
column's height. `.process-grid` already used `auto-fill`/`minmax` and needed
no change for this width.

**Related Works is the one exception — it's full-width, below `.entry-top`,
not in the meta column.** Squeezing an 8-item grid into ~300px alongside
everything else read as cramped, so it was pulled back out into its own
`#section-related-wrap` div, a direct sibling of `.entry-top` inside
`.entry-body` (so it inherits that container's own 960px-max centered width
for free — see `.entry-body > *`). `.related-grid` uses
`auto-fill`/`minmax(200px,1fr)`, sized for a ~960px-wide row rather than the
~300px column it briefly lived in. The main image itself was also shrunk
(`.main-img-wrap`/its `img`, `min-height`/`max-height` 750px → 560px) — at
750px next to a meta column padded out with every other section, the image
read as oversized relative to the reference layout. If this page changes
again, treat the current live entry page file as the source of truth for
exactly which sections live where — don't move Related Works back into
`#sections`, and don't move `#sections` itself back below the image, thinking
either is a restoration of something.

---

**(Superseded) Don't repeat a work's series/category on the entry page.** Previously:
a work's series appeared in exactly one place (the `cr-num` header line), enforced
because it had been requested multiple times. No longer the rule — see above.

**(Superseded) Entry page layout.** Previously: no left sidebar/subnav, text only
above and to the right of the image, no jump-links/series-links/print button. No
longer the rule — see above.
