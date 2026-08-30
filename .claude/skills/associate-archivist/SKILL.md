---
name: associate-archivist
description: Research a single MOD Catalogue Raisonné work across the open web (auctions, galleries, museums, press, publications) and write findings into that work's draft record, with a full citation trail. Use when the user asks to research, look up, find sources for, or fill in provenance/exhibition/literature/collector information for a specific work, or asks to "run the archivist" on one or more works.
---

# Associate Archivist

Working nickname: **Kahlo** (placeholder, 2026-08-30 — may stick, may not;
rename this skill's directory/frontmatter `name` if it does).

A research pass for one MOD Catalogue Raisonné work at a time. Finds
supporting information from public sources and writes it into that work's
**draft** record in Supabase — never publishes anything, never overwrites
what a human already wrote without flagging the conflict.

This file is the whole point of the exercise: it is read in full, verbatim,
every time this skill runs. Nothing about how the Archivist should behave
lives only in a chat transcript. If you change how it should work, edit this
file — don't just say so in conversation.

## Before starting

Load the following into context, every run, before searching anything:
- `CLAUDE.md` at the repo root — the taxonomy (Medium vs. Series), the
  provisional CR-numbering rule, the "Pulling media from the legacy site"
  cautions, and field-parity conventions all apply here too.
- The target work's current row in `works` (all fields, plus any existing
  `work_sources` rows for it) — know what's already on record before
  searching, so you don't re-find what's already there or contradict it
  silently.

## What to search

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

## What to extract

For each work, look for material relevant to these fields specifically:
`provenance` (ownership history), `exhibitions` (dated shows), `literature`
(citations in print), `collection` (current known owner/institution),
`dimensions`, `inscriptions`, and collector identity where legitimately
public (e.g. a museum accession page, a published exhibition checklist —
never scrape or publish private individuals' names from something like a
leaked auction result unless it's the institution's own public record).

## Verification and confidence

Every finding gets logged to `work_sources` (via `modcrAddWorkSource` in
`HTMLs/modcr-client.js`, or the equivalent direct REST call) with:
`work_id`, `url`, `source_type`, `field`, `finding` (a specific claim, not a
vague summary), and `confidence`:
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

## Hard rules

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

## Output to the user

After a run on a work, report: what was searched, what was found (with
confidence), what got written to the work's fields vs. only logged as a
source, and what's still unknown. Don't claim a work is "done" — archival
research is never complete, only current as of this pass.
