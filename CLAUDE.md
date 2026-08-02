# MOD Catalogue Raisonné — conventions

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

## Work taxonomy
Every catalogued work has two independent classifications, filterable separately:

**Medium** (material): paper, ceramic, bronze, gold, silver, diamonds, stone,
organic material, glass, steel, canvas, painting, photography, video.

**Series** (category): early clay, jewelry, works on paper, public works,
commissions, sculpture, fables.

`medium` (free text, e.g. "Raku ceramic", "Bronze with silver") is the descriptive
label shown on the work's page. The `tag` field on each work is the *filter* value
and must be one of the Medium list above. `series` is the filter value for Series
and must be one of the Series list above (internal slugs may differ from display
labels for historical reasons — see the `seriesLabels` map in
`catalogue_entry_v6_sans.html` and the `SERIES` object in `catalogue_v10_sans.html`).

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
