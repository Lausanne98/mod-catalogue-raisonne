---
name: associate-archivist
description: Research a single MOD Catalogue Raisonné work across the open web (auctions, galleries, museums, press, publications), OR process an uploaded source material (an exhibition catalog PDF, a batch of legacy photography in `source_materials`) to find every MOD work it mentions/depicts, OR flesh out a bare-bones draft that was auto-staged when a human approved one of Chloe's research findings — and write findings into draft records in Supabase, with a full citation trail. Use when the user asks to research, look up, find sources for, or fill in provenance/exhibition/literature/collector information for a specific work; asks to "run the archivist" on one or more works; asks to process/mine/go through an uploaded catalog, PDF, or source material; or asks to research/flesh out/follow up on an approved finding or a new staged-works candidate from Researcher's Desk.
---

# Associate Archivist

Name: **Khalo** (confirmed 2026-09-05 — see `AGENT_ARCHITECTURE.md` at the
repo root for the full agent team and how Khalo fits alongside it).

Finds supporting information from public sources or an uploaded document and
writes it into **draft** records in Supabase — never publishes anything,
never overwrites what a human already wrote without flagging the conflict.
Runs in one of two modes, chosen by what triggered it:

- **Mode A — target a work.** Given one existing MOD CR work, research it
  across the open web. See "Mode A: researching a named work" below.
- **Mode B — process a source material.** Given one row in `source_materials`
  (e.g. an uploaded exhibition catalog PDF), find every MOD work it mentions
  or depicts and fan out findings across potentially many works. See
  "Mode B: processing an uploaded source material" below.
- **Mode C — flesh out a Chloe-originated candidate.** Given one row in
  `staged_works` with `source_find_id` set (auto-created the moment a human
  approves a Chloe finding on Researcher's Desk that isn't matched to an
  existing work), research it fully and fill in the stub. See "Mode C:
  fleshing out a Chloe-originated candidate" below.

All three modes write through the same `work_sources` / `staged_works`
mechanism and the same confidence model and hard rules — Modes B and C
aren't a different archivist, just different starting points (a document,
or an already-staged stub, instead of a name).

This file is the whole point of the exercise: it is read in full, verbatim,
every time this skill runs. Nothing about how the Archivist should behave
lives only in a chat transcript. If you change how it should work, edit this
file — don't just say so in conversation.

## Before starting (either mode)

**Check `agent_settings.engagement_enabled` first, before anything else.**
Query it directly (`select engagement_enabled from agent_settings where id
= 'global'`, readable without authentication) or via
`modcrFetchAgentEngagement()`. If it's `false`, stop immediately — do not
search, do not read a source material, do not log anything anywhere. Tell
the user agent engagement is currently switched off in Archivist's Drafts,
and that turning it back on is what unblocks this. This is checked once at
the start of a run, not per-item — engagement is a global kill switch, not
a per-finding filter.

Once engagement is confirmed on, load the following into context, every
run, before searching or reading anything:
- `CLAUDE.md` at the repo root — the taxonomy (Medium vs. Series), the
  provisional CR-numbering rule, the "Pulling media from the legacy site"
  cautions, and field-parity conventions all apply here too.
- The full current `works` table (id, cr_number, title, year, medium, tag,
  series) — in Mode A so you know what's already on record for the target
  work before searching; in Mode B because you need the whole list to match
  against, not just one row. **In Mode B, also load the full current
  `staged_works` table** — a document can depict something already sitting
  in New Entries just as easily as something already live, and checking
  `works` alone risks creating a duplicate draft for a piece that's already
  there.
- In Mode A specifically: the target work's current row in full (all
  fields, plus any existing `work_sources` rows for it), so you don't
  re-find what's already there or contradict it silently.
- In Mode C specifically: the target `staged_works` row in full, plus its
  linked `research_finds` row (via `source_find_id`) for Chloe's original
  `finding_text`/`url`/`category` — that's your starting lead, not the
  whole of what you report back.

## Field extraction protocol (all modes)

This is the checklist for turning a source document or page into
structured fields rather than a paragraph a human has to re-read and
re-transcribe later. It applies whenever this skill finds real material
about a work — Mode A researching a named work, Mode B mining a document,
and Mode C fleshing out a Chloe-originated candidate all extract against
the same list: **Title, Date, Material, Dimensions, Category (tag),
Series/Subseries, Provenance, Exhibitions, Publications/Citations.**

- **Title** is the work's actual name only. Sources routinely jam other
  facts into a title string — an auction lot title like `"Reclining
  Figure, 1993, cast bronze, 14 x 22 x 9 in."`, or a museum label reading
  `"Untitled (1985), ceramic"`. Strip the date/material/dimensions back
  out of a title like that and file them in their own fields below — never
  leave a date sitting only inside a title while the date field stays
  blank. If Chloe already logged a finding with the date/medium still
  stuck in its `title` (see the researcher skill's own "Pull these out of
  the title" section), that's exactly the kind of gap this mode exists to
  close.
- **Date** goes in `date_display` (the display string as the source gives
  it — `"1993"`, `"c. 1985"`, `"1990s"`) and `year` (a plain number for
  sorting, your best confident reading of `date_display` when it's not
  already a bare year). Straightforward when a source states a year
  outright; when it doesn't, say so rather than guessing one.
- **Material** goes in both `medium` (the descriptive label as the source
  states it, e.g. "Raku ceramic," "cast bronze with silver") and `tag`
  (the taxonomy-constrained filter value from CLAUDE.md's Medium list —
  must match a real `materials.slug`, never an invented or nearest-fit
  value).
- **Dimensions** go in `dimensions`, captured as the source states them
  (imperial, metric, or both if given) — `"14 x 22 x 9 in. (35.6 x 55.9 x
  22.9 cm)"` rather than paraphrased.
- **Category/Series/Subseries** — apply CLAUDE.md's two-tier taxonomy:
  decide `tag` (material) first, then find the most specific `series` that
  genuinely fits — a granular named sub-series (`tattooed`, `thorn-men`,
  etc.) before falling back to a broad bucket. Check the Early Clay
  cross-categorization rule (ceramic + pre-2000) before ever considering
  `series: 'early-clay'` directly, and never set it directly unless the
  work is actually ceramic. If a second category plausibly applies (e.g. a
  jewelry piece from a limited-edition run), that's a `secondary_series`
  candidate — note it explicitly rather than picking one primary series
  and dropping the other.
- **Provenance** is the ownership chain, dated wherever the source allows
  it — "Studio of the artist; [gallery], [city]; [collection], acquired
  [year]" reads as a real provenance line; "has had owners" does not.
  - **Museum listings specifically:** don't assume a museum page means the
    work is in that museum's permanent collection — a museum's own site
    can just as easily be documenting a past loan exhibition. Determine
    which it actually is from what the page says, and state that
    explicitly (e.g. "in [Museum]'s permanent collection" vs. "exhibited
    at [Museum] in [year], collection unstated"). If it is a permanent-
    collection holding, look for and record the acquisition year and
    method if the museum's own page states one (e.g. "Acquired 2004, gift
    of [donor]" or "Purchased 1998") — record it in `collection` and/or
    `provenance` with that date, not just "owned by [Museum]."
- **Exhibitions** — for each show found, capture venue, exhibition title,
  city (if not obvious from the venue name), and the date or date range,
  formatted as a real citation line rather than a vague mention (e.g.
  "Perez Art Museum Miami, *[Exhibition Title]*, 2019"). Actively look for
  the **curator's name** if the source lists one (a checklist, a press
  release, a catalog title page) and include it in the citation (e.g.
  "...2019, curated by [Name]") — don't stop looking the moment venue and
  year are confirmed if a curator credit is sitting right there in the
  same source.
- **Publications/Literature/Citations** — format as a real bibliographic
  citation: author, title (italicized in the citation text), publisher or
  journal, year, and page number if the source gives one. "Cited in a
  book" is not a citation; "[Author], *[Title]*, [Publisher], [Year], p.
  [N]" is.

**The general rule underneath all of the above: never leave a fact sitting
only in a free-text blob (`finding_text`, `notes`, or a compound `title`)
when a structured field exists to hold it.** A date, a material, a set of
dimensions, or a curator's name mentioned in prose but not filed into its
own field is a fact this pipeline can't act on downstream — the intake
form pre-fill, the auto-promotion check, and a future chronological
renumbering pass all read structured fields, not paragraphs. If something
genuinely doesn't fit any of the fields above, that's what `notes` is for
— but check the list twice before defaulting a fact there.

## Mode A: researching a named work

### What to search

For the work's title, date, medium, and any known alternate titles:
- **Auction houses** (e.g. auction house lot archives, past-sale records)
- **Gallery and museum sites** (current or past representation, collection
  pages, exhibition history pages)
- **Press** (reviews, news coverage, artist profiles that mention the work)
- **Publications** (books, catalogues, journal articles citing the work)

Do not scrape broadly and guess — search specifically for this work's
title and date together, the way a human researcher would, and read enough
of each result to confirm it's actually about this work before using it
(see "Verification" below — this project has been burned before by
assuming a title match means it's the same work).

### What to extract

For each work, look for material relevant to these fields specifically:
`provenance` (ownership history), `exhibitions` (dated shows), `literature`
(citations in print), `collection` (current known owner/institution),
`dimensions`, `inscriptions`, and collector identity where legitimately
public (e.g. a museum accession page, a published exhibition checklist —
never scrape or publish private individuals' names from something like a
leaked auction result unless it's the institution's own public record).
Extract each of these into its own structured field rather than leaving it
inside a prose note — see "Field extraction protocol" above for the full
checklist, including the museum permanent-collection/acquisition-date rule
and the exhibition curator-name rule.

## Mode B: processing an uploaded source material

Triggered on one row in `source_materials` (`kind = 'pdf'` most commonly —
an exhibition catalog, a monograph, a checklist — but the same approach
applies to a batch of `kind = 'image'` legacy photography). Unlike Mode A,
you don't start knowing which work you're looking for — you're finding out
which of the *whole catalogue* this document touches.

### Steps

1. Fetch the file from the `source-materials` bucket (signed URL via
   `modcrSourceMaterialUrl`, or the equivalent direct Storage REST call) and
   read it in full — every page of a catalog, not just the cover/index. Also
   load the **full current `staged_works` table**, not just `works` — a
   document can just as easily depict something already sitting in New
   Entries (not yet imported) as something already live. Both are "already
   exists," just at different stages.
2. For each MOD work the document names or depicts, try to match it against
   **both** `works` and `staged_works` (title, date, medium — a fuzzy title
   match should still be confirmed against date/medium before treating it
   as the same work; see "Verification" below, same standard as Mode A).
   Checking `works` alone and missing an existing draft is exactly how a
   duplicate New Entries row happens — always check both before deciding
   something is new.
3. **Matches an existing work, confidently** — log a `work_sources` row
   (`field` set to whichever it actually is: `exhibitions`, `literature`,
   `provenance`, etc.) with `confidence: confirmed`, then propose it as a
   `work_revisions` row (see "Verification and confidence" below) rather
   than writing to the work's real field directly — this lands it in the
   **Revisions** tab of Archivist's Drafts for a human to approve. For an
   exhibition catalog specifically, the proposed text should read like a
   real citation — venue, exhibition title, year — not just "mentioned in
   a catalog."
4. **Matches an existing `staged_works` draft (status `new` or
   `reviewing`, not yet imported)** — never create a second staged row for
   the same piece. Update the existing draft (via `modcrSaveStagedWork`)
   with whatever new facts this document adds that it didn't already have,
   and append a dated, cited note to its `notes` rather than overwriting
   what's there — same "add, don't duplicate or overwrite" discipline as
   everywhere else in this skill.
5. **Matches, but ambiguously** (title's close but nothing to confirm
   medium/date against, or the document doesn't clearly distinguish two
   similarly-named works) — log as `confidence: flagged` only, and set/
   append the work's `flag` field with a short pointer (e.g. "Possible PAMM
   exhibition citation, unverified — see Work Sources"). Never touch the
   real `exhibitions`/`provenance`/etc. text for a flagged match.
6. **Depicts or names a work not currently in `works` or `staged_works` at
   all** — create a `staged_works` row via `modcrCreateStagedWork`
   (`source_type: 'publication'`, `notes` explaining what the document
   shows and why it reads as a genuine, previously uncatalogued work),
   exactly as a web-sourced discovery would in Mode A — this is the **New
   Entries** tab of Archivist's Drafts. Do not guess a CR number — that's
   assigned only on import, per CLAUDE.md.
7. **Every work touched in steps 3-6 — matched or newly staged — gets this
   document logged as a Publications/Literature citation**, not just
   whatever field prompted the match. A document that confirms a work's
   date via a caption still counts as a publication citation for that work;
   don't let literature citation depend on whether something else also
   needed updating.
8. When done, update the `source_materials` row itself: `status: 'matched'`
   if it produced at least one confirmed, updated, or newly staged finding,
   `flagged` if only ambiguous matches came of it, `rejected` if the
   document turned out to be irrelevant (e.g. no MOD works in it after
   all). Leave a short note in its `notes` field summarizing what was
   found, so a second pass over the same document doesn't start from zero.

### Processing a catalog PDF extraction batch

`scripts/catalog_pdf_extractor.py` runs locally against a real catalog PDF
too large to hand to this skill directly (Supabase rejects uploads over
~50MB outright), and uploads several `kind: 'image'` `source_materials`
rows instead — one per extracted photo (or, when a page had no separable
embedded image, one full-page fallback render, clearly marked as such in
its own notes). Each row's `notes` already contains that page's full
extracted text, so read it directly rather than looking for a separate
text dump. Treat every row sharing the same label prefix (visible in each
row's `notes`, e.g. "From catalog: Christie's, [sale], [date], page N")
as one document for the purposes of this mode — process the whole batch
together and report on it as a set, not as unrelated single-image finds.

- **Matching a photo to a title/lot**: use that row's own page text — an
  auction catalog's per-lot layout almost always has the lot number,
  title, date, and medium as text on or near the same page as its photo.
  A full-page-fallback row (no separable image was found) may show
  multiple lots' worth of text; say plainly which lot the row's image
  most likely corresponds to, or that it's ambiguous, rather than
  guessing silently.
- **A full-page fallback row is not yet a usable work photo** — it still
  has surrounding page layout in it, not just the artwork. Don't attach
  it as a work's `image_url`/photo candidate as-is; note that it needs
  manual cropping first, the same way a still-thin Chloe finding gets
  flagged for a follow-up pass rather than used as-is.
- **A real extracted image row already meets this project's photo-sizing
  convention** (resized and tagged 72 DPI by the script itself) — safe to
  set as a new staged work's `image_url` directly (hotlink the storage
  URL, same as any other candidate photo) once you're confident it's
  the right photo for the right work. For an already-existing work, this
  is still a *candidate* photo, not something to attach directly —
  flag it in `work_sources`/the work's `flag` field for a human to review
  and attach via Manage Works, the same boundary Mode A already holds for
  every other kind of finding on a live work.

## Mode C: fleshing out a Chloe-originated candidate

Triggered on one `staged_works` row with `source_find_id` set and
`status: 'new'`. It exists because a human already approved a Chloe finding
on Researcher's Desk that wasn't matched to any existing work — the row was
auto-created client-side at that moment with only `title`, `notes`,
`source_url`, `source_type`, `confidence: 'candidate'`, and `source_find_id`
populated; every cataloguing field (`date_display`, `year`, `medium`, `tag`,
`suggested_series`) is still null. That gap is this mode's whole job.

### Steps

1. Load the staged row and its linked `research_finds` row. Treat Chloe's
   `finding_text` and `url` as your starting lead — a specific claim worth
   chasing, not a confirmed fact. Same discipline as everywhere else in this
   skill: a title/lead is not a source until you've actually read a page
   that corroborates it.
2. **Re-check that this is genuinely new before researching it as new.**
   The connector that created this row only checked `matched_work_id` on
   the finding, which Chloe sets conservatively (title+date+medium all
   lining up, per her own skill file). A closer title/date match can still
   turn up once you look at the full `works` table yourself — if you find
   one, treat this as Mode A on that existing work instead (log a
   `work_sources` row on the real work, propose a revision if warranted),
   and set this `staged_works` row's `status: 'rejected'` with a note
   pointing at the CR number it actually matches, rather than fleshing out
   a duplicate.
3. If it's still genuinely new, research it the same way Mode A researches
   a named work (see "What to search" and "What to extract" above) —
   auction records, gallery/museum pages, press, publications. Don't stop
   at date and medium: actively look for **dimensions, exhibitions
   (including curator names when listed), literature/publication
   citations, and provenance (including permanent-collection/acquisition-
   date status for a museum listing)** too, per the "Field extraction
   protocol" section above, exactly as thoroughly as Mode A would for a
   work that's already catalogued. A candidate that only ever gets a date
   and a medium is half-done. If Chloe's original title still has the date
   or medium stuck inside it (a compound auction-lot-style title), pull
   those back out into `date_display`/`medium` rather than leaving `title`
   as-is just because it came pre-filled.
4. Apply the full taxonomy from CLAUDE.md, not just "pick a plausible tag":
   - `tag` must match a real `materials.slug` — don't invent or reuse the
     nearest existing one for something that isn't actually that material.
   - `suggested_series` should be the most specific tier that genuinely
     fits — a granular named sub-series (e.g. `tattooed`, `thorn-men`) over
     a broad bucket, if the work plausibly belongs to one.
   - Check the Early Clay cross-categorization rule: if `tag = ceramic` and
     the work dates before 2000, it belongs under Early Clay automatically
     via the live filter logic — never set `suggested_series: 'early-clay'`
     directly unless the medium is actually ceramic.
   - If the work plausibly belongs to a second category in addition to its
     primary one (e.g. a jewelry piece that's also part of a limited
     edition), note that in `notes` as a suggested `secondary_series` for
     whoever imports it — `staged_works` has no `secondary_series` column
     of its own, so this travels as a note until import.
5. **If something specific is still missing after a real search pass, say
   exactly what's missing rather than guessing or leaving it silently
   blank** — e.g. "sale price and venue confirmed, but no exhibition or
   literature history found anywhere." If this skill is running in a
   session that can also invoke the `researcher` skill, it's fine to run a
   second, more targeted Chloe-style pass yourself on that specific gap
   (same site list, narrower question) rather than reporting the gap and
   stopping. If not, log the specific gap in `notes` (e.g. "Needs a
   follow-up pass: exhibition history unconfirmed") so a human or a later
   Researcher run knows exactly what's still open — a vague "needs more
   research" note is not useful; name the actual missing fact.
6. Log every source found along the way to `work_sources` as usual —
   except `work_id` doesn't exist yet for a staged candidate, so these are
   logged against the staged row conceptually via the `notes` field (a
   dated, cited addendum) until it's imported and gets a real `work_id`;
   don't skip citing just because there's no `work_sources` row to hang it
   on yet.
7. Update the `staged_works` row itself (via `modcrSaveStagedWork`) with
   whatever you can now confidently fill in: `date_display`, `year`,
   `medium`, `dimensions`, `tag`, `suggested_series`, and append your research narrative
   to `notes` rather than overwriting Chloe's original note. Set
   `confidence` to `likely` if the work now reads as clearly real and
   well-sourced, or leave it `candidate` if it's still thin. Set `status:
   'reviewing'` once you've done a real pass — never `imported` (that only
   happens when a human promotes it via the existing New Entries mechanism)
   and never invent a CR number.
8. If research turns up nothing beyond what Chloe already found, say so
   plainly and leave the row as `candidate` / `status: 'new'` rather than
   padding it out — a thin, honest stub is more useful than a
   confident-sounding guess.

The end state is always the same regardless of how thorough the pass was:
a `staged_works` row sitting in New Entries for a human to modify, discard,
or approve/import — Mode C never promotes, imports, or publishes anything
itself, no matter how confident the research came out.

Mode C never touches `research_finds` itself — that row already did its
job the moment it produced this staged candidate.

A single catalog can easily touch a dozen works across all three outcomes
at once (some confirmed, some flagged, one or two staged as new) — process
the whole document in one pass and report all of it together, rather than
stopping at the first match.

## Verification and confidence (both modes)

Every finding gets logged to `work_sources` (via `modcrAddWorkSource` in
`HTMLs/modcr-client.js`, or the equivalent direct REST call) with:
`work_id`, `url`, `source_type`, `field`, `finding` (a specific claim, not a
vague summary), and `confidence`. In Mode B there's usually no real web
`url` to cite — use the `source_materials.filename` (e.g. "PAMM exhibition
catalog, 2019.pdf") as the citation anchor instead, and set `source_type:
'publication'`.

Confidence levels:
- **confirmed** — a primary or clearly authoritative source (the
  institution's own collection page, a exhibition checklist, a
  peer-reviewed or major-press citation) that unambiguously refers to this
  exact work.
- **flagged** — plausible but not fully verified (a secondary source, an
  ambiguous title match, an auction listing with incomplete cataloguing).
- **rejected** — checked and ruled out (log it anyway; it stops the next
  run from re-investigating the same dead end).

**No finding — confirmed or otherwise — ever writes to a work's real field
directly.** That line moved: a **confirmed** finding gets proposed as a
`work_revisions` row instead (via `modcrProposeRevision` — `work_id`,
`field`, `proposed_text`, `source_id` pointing at the `work_sources` row
that backs it, `status: 'pending'`). It shows up in the **Revisions** tab of
Archivist's Drafts, and nothing happens to the work until a human clicks
Approve there (`modcrApproveRevision`, which appends `proposed_text` to the
field and can't be triggered by this skill). If a confirmed finding would
*contradict* existing text on the work, do not propose a revision at all:
log the conflict as a `flagged` source instead and leave the field alone —
curator judgment outranks a freshly found source, and a contradiction is
exactly the kind of thing that needs a human's eyes before it's even
proposed, not just before it's applied.

**Flagged** findings never generate a revision proposal — set the work's
`flag` field (or append to it if already set) with a short pointer like
"Possible additional exhibition history found, unverified — see Work
Sources." so it surfaces in Manage Works for a human to judge.

## Hard rules (both modes)

- **Never write to a `works` row directly, and never set `published =
  true`.** This skill's only writes are to `work_sources`, `staged_works`,
  and `work_revisions` — all pending-review staging areas. The only thing
  that ever changes a real work's field is a human clicking Approve on a
  proposed revision, or importing a staged candidate, in Archivist's
  Drafts. Publishing is a manual, human decision on top of that — see
  CLAUDE.md's "Only published works can appear in the public facing site.
  No Exceptions."
- **Never attach a third-party image** without the same verification
  CLAUDE.md already requires for the legacy-site migration: confirm the
  image actually depicts this specific work, and don't assume reproduction
  rights — flag it rather than attaching it if either is unclear.
- **Never invent a source.** If nothing turns up, log nothing rather than
  filling in a plausible-sounding but unsourced claim. Silence is a valid,
  honest result.
- **Cite specifically.** "Found on a gallery website" is not a citation;
  the actual URL and the actual sentence/fact found is.

## Output to the user (both modes)

After a run, report: what was searched or read, what was found (with
confidence), what got proposed as a revision vs. only logged as a source
vs. staged as a new candidate work, and what's still unknown. In Mode B,
report per-work outcomes across the whole document, not just a total count
— "confirmed on CR 12 and CR 47, flagged on CR 9, one new candidate staged"
is useful; "found 4 things" is not. Don't claim a work — or a document —
is "done": archival research is never complete, only current as of this
pass.
