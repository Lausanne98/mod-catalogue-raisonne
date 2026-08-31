---
name: associate-archivist
description: Research a single MOD Catalogue Raisonné work across the open web (auctions, galleries, museums, press, publications), OR process an uploaded source material (an exhibition catalog PDF, a batch of legacy photography in `source_materials`) to find every MOD work it mentions/depicts — and write findings into draft records in Supabase, with a full citation trail. Use when the user asks to research, look up, find sources for, or fill in provenance/exhibition/literature/collector information for a specific work; asks to "run the archivist" on one or more works; or asks to process/mine/go through an uploaded catalog, PDF, or source material.
---

# Associate Archivist

Working nickname: **Khalo** (placeholder, 2026-08-30 — may stick, may not;
rename this skill's directory/frontmatter `name` if it does).

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

Both modes write through the same `work_sources` / `staged_works` mechanism
and the same confidence model and hard rules — Mode B is not a different
archivist, just a different starting point (a document instead of a name).

This file is the whole point of the exercise: it is read in full, verbatim,
every time this skill runs. Nothing about how the Archivist should behave
lives only in a chat transcript. If you change how it should work, edit this
file — don't just say so in conversation.

## Before starting (either mode)

Load the following into context, every run, before searching or reading
anything:
- `CLAUDE.md` at the repo root — the taxonomy (Medium vs. Series), the
  provisional CR-numbering rule, the "Pulling media from the legacy site"
  cautions, and field-parity conventions all apply here too.
- The full current `works` table (id, cr_number, title, year, medium, tag,
  series) — in Mode A so you know what's already on record for the target
  work before searching; in Mode B because you need the whole list to match
  against, not just one row.
- In Mode A specifically: the target work's current row in full (all
  fields, plus any existing `work_sources` rows for it), so you don't
  re-find what's already there or contradict it silently.

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

## Mode B: processing an uploaded source material

Triggered on one row in `source_materials` (`kind = 'pdf'` most commonly —
an exhibition catalog, a monograph, a checklist — but the same approach
applies to a batch of `kind = 'image'` legacy photography). Unlike Mode A,
you don't start knowing which work you're looking for — you're finding out
which of the *whole catalogue* this document touches.

### Steps

1. Fetch the file from the `source-materials` bucket (signed URL via
   `modcrSourceMaterialUrl`, or the equivalent direct Storage REST call) and
   read it in full — every page of a catalog, not just the cover/index.
2. For each MOD work the document names or depicts, try to match it against
   the `works` table already loaded (title, date, medium — a fuzzy title
   match should still be confirmed against date/medium before treating it
   as the same work; see "Verification" below, same standard as Mode A).
3. **Matches an existing work, confidently** — log a `work_sources` row
   (`field` set to whichever it actually is: `exhibitions`, `literature`,
   `provenance`, etc.) with `confidence: confirmed`, and copy the specific
   finding into that work's real field, appended to whatever's already
   there. For an exhibition catalog specifically, the appended line should
   read like a real citation — venue, exhibition title, year — not just
   "mentioned in a catalog."
4. **Matches, but ambiguously** (title's close but nothing to confirm
   medium/date against, or the document doesn't clearly distinguish two
   similarly-named works) — log as `confidence: flagged` only, and set/
   append the work's `flag` field with a short pointer (e.g. "Possible PAMM
   exhibition citation, unverified — see Work Sources"). Never touch the
   real `exhibitions`/`provenance`/etc. text for a flagged match.
5. **Depicts or names a work not currently in `works` at all** — create a
   `staged_works` row (`source_type: 'publication'`, `notes` explaining
   what the document shows and why it reads as a genuine, previously
   uncatalogued work), exactly as a web-sourced discovery would in Mode A.
   Do not guess a CR number — that's assigned only on import, per CLAUDE.md.
6. When done, update the `source_materials` row itself: `status: 'matched'`
   if it produced at least one confirmed or staged finding, `flagged` if
   only ambiguous matches came of it, `rejected` if the document turned out
   to be irrelevant (e.g. no MOD works in it after all). Leave a short note
   in its `notes` field summarizing what was found, so a second pass over
   the same document doesn't start from zero.

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

Only **confirmed** findings get copied into the work's own field
(`provenance`, `exhibitions`, etc.) — appended to existing text, never
silently overwriting it. If a confirmed finding would *contradict* existing
text on the work, do not overwrite it: log the conflict as a `flagged`
source instead and leave the human-reviewed field alone, since curator
judgment outranks a freshly found source.

**Flagged** findings never touch the work's real fields — set the work's
`flag` field (or append to it if already set) with a short pointer like
"Possible additional exhibition history found, unverified — see Work
Sources." so it surfaces in Manage Works for a human to judge.

## Hard rules (both modes)

- **Never set `published = true`.** This skill only ever writes to a
  work that is already, and remains, a draft. Publishing is a manual,
  human decision — see CLAUDE.md's "Only published works can appear in the
  public facing site. No Exceptions."
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
confidence), what got written to real fields vs. only logged as a source
vs. staged as a new candidate work, and what's still unknown. In Mode B,
report per-work outcomes across the whole document, not just a total count
— "confirmed on CR 12 and CR 47, flagged on CR 9, one new candidate staged"
is useful; "found 4 things" is not. Don't claim a work — or a document —
is "done": archival research is never complete, only current as of this
pass.
