# MOD Catalogue Raisonné — conventions

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

## Known open item
MOD CR 8 ("Into the Mysterium," mixed media installation) doesn't have a clean single
Medium value in the taxonomy above — flagged for a real decision rather than guessed.
