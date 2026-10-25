# Roadmap — running task list

Purpose: a durable, living list of the project's high-level initiatives and
their open subtasks, so nothing raised in conversation gets lost once the
session ends. Different from the other root-level docs:

- `CLAUDE.md` — durable *conventions* (how things are built), not a task list.
- `HANDOFF.md` — a disposable point-in-time status snapshot, regenerated each
  session, meant to go stale on purpose.
- `SESSION_LOG.md` — a chronological record of what already happened.
- **This file** — neither a snapshot nor a history. It accumulates. Items are
  added as they come up, checked off (not deleted) once done, and a
  high-level heading stays even after everything under it is checked off,
  since more subtasks get added to it over time.

**How to use this**: whenever a new idea, bug, or feature comes up in
conversation that isn't being done immediately, add it here under the
matching heading (or a new heading, if it's a genuinely new initiative)
instead of letting it live only in chat history. Check an item off when it
ships; leave it checked rather than deleting it, so the file also shows what's
already been built, not just what's left.

---

## 1. PDF / document processing pipeline
The mechanical pipeline that turns an uploaded catalog PDF or legacy photo
batch into draft candidate works in Archivist's Drafts (`process-source-material`,
the associate-archivist skill's Mode B, `modcrExtractPdfPages` in
`modcr-client.js`).

**Done:**
- [x] Client-side PDF → per-page JPEG extraction (no raw PDF upload, any size).
- [x] Batch "Process all N together" action right after a multi-page upload.
- [x] In-app confirm dialogs (`modcrConfirm`) replacing native `confirm()` on
      Researcher's Desk — still owed on other pages, see item 1a below.
- [x] "Process all N together" button now stays in sync if one of its items
      gets processed individually elsewhere, instead of showing a stale count.
- [x] A toast now fires when a card resolves and leaves the Pending view
      ("→ moved to Archivist's Drafts" / "no MOD works found"), instead of it
      silently vanishing with no trace.
- [x] Color migration off the old yellow-green (`--agent-lt`) and off red for
      non-error states, site-wide for destructive buttons (now bronze/gold).

**Open:**
- [ ] **Stop/pause button** for an in-progress Process run — right now the
      only way to abort an accidental wrong-file upload is reloading the
      whole page, which does *not* actually stop the server-side job (it
      keeps running and will still produce drafts). Raised 2026-10-25.
- [ ] Convert the remaining native `confirm()`/`alert()` calls on every other
      admin page (Drafts, Manage Works, Series, Sources, Exhibitions,
      Chronology, IT, Intake) to `modcrConfirm()`/`showToast()` — see
      CLAUDE.md's "No native browser dialogs" rule.
- [ ] Clean up the 2 junk drafts ("Tattooed Doll (coiled forehead)",
      "Bramble") created from the accidental `MOD-CR-Calude-agentic-test-PDF`
      upload on 2026-10-25.
- [ ] Re-upload the cleaned PAMM Catalog PDF through Researcher's Desk for
      proper photo attachment (the original Sept run's images never
      attached correctly; the 36 resulting test drafts were discarded).
- [ ] 95-artwork MutualArt batch: citations, reconcile flag (Death Masks
      date conflict), and ~73 new drafts are built and ready (see
      `/tmp/mutualart_work/all_sql.sql` from the 2026-10-25 session if still
      present) but the final bulk INSERT/UPDATE hasn't landed yet — the
      Supabase SQL tool keeps timing out on large multi-statement queries
      (not just DELETEs, now confirmed). Needs retrying in smaller chunks.
- [ ] "Artworks only" notation on the Intake form, so printed support
      material (exhibition catalogs, gallery flyers) doesn't get mistaken
      for an artwork photo during intake.
- [ ] Fix the 5 (now re-pointed, but worth re-checking) MutualArt citations
      and any other non-URL `source_url` values site-wide for the same
      "shows as plain text instead of a dead link" treatment Drafts got.

## 2. Conversant agents (ambient voice layer — Chloe/Khalo/Timur)
The "talk to an agent and it actually responds" experience on the Agents hub
and IT Desk — distinct from the structured Voice Intake form (item 3).

**Done:**
- [x] Hand-rolled push-to-talk pipeline (record → ElevenLabs STT → agent-chat
      → ElevenLabs TTS) built for Khalo and ported to Timur, with timeouts,
      continuity buttons, and a wavy voice-button UI.

**Open / reconsidering:**
- [ ] The hand-rolled pipeline was judged unsatisfying after ~2 months on and
      off — it transcribes but doesn't feel genuinely agentic/conversational
      (slow, no real back-and-forth, no speaks-first behavior).
- [ ] **Recommended direction (not started): ElevenLabs Conversational AI /
      Agents product** — a purpose-built ambient voice-agent platform
      (continuous listening, turn-taking, speaks first, custom tools/
      function-calling) as a likely real fix, replacing the hand-rolled
      orchestration rather than continuing to patch it.
- [ ] Open question from the studio: what input/setup is needed on their end
      to stand this up (an ElevenLabs Agent config, voice selection, tool
      wiring back into Supabase)?
- [ ] "Not yet built" status pills already removed from the agent cards —
      kept here as a reminder not to reintroduce that kind of internal note
      on a user-facing page.

## 3. Conversant intake form (structured Voice Intake)
The "fill out the Add a Work form by talking" feature — field-by-field voice
entry, separate from the ambient agent chat above.

**Open — active spec received 2026-10-25, "Voice Form Entry: Field Value
Extraction Fix":**
- [ ] **v1**: Test set + scoring script against *current* behavior, to show
      the failure (spoken lead-ins like "The title is X" being stored
      verbatim instead of just "X"). Several phrasings per field type
      (title, date, medium, dimensions, notes), including edge cases (bare
      value, a correction, a value that legitimately starts with "The" or
      contains "is"). Report pass/fail counts.
- [ ] **v2**: Structured extraction — model returns `{field, value}`, code
      stores only `value`; model instructed to strip spoken lead-ins/filler,
      never strip words that are part of the real value. Re-run v1's test set.
- [ ] **v3**: Read-back confirmation before saving ("Title: X. Correct?"),
      handling yes/no/correction. Re-run the test set again.
- Ground rules for this whole item: scope is voice form-entry only (don't
  touch the PDF pipeline, crawler, or broader agent); no deletes/migrations/
  schema changes (stop and ask if one seems needed); never edit/overwrite a
  human-authored entry; version each deliverable sequentially; if a tool call
  fails twice, stop and ask rather than switching to a more permanent
  workaround; stop and report after each deliverable rather than chaining
  straight through to the next.

**Also open (older, lower-priority given the above supersedes it):**
- [ ] Too much "tap to answer" friction reported in the existing Voice
      Intake flow — somewhat addressed by the read-back-confirmation
      redesign above, but worth re-checking once v3 ships.

## 4. Automatic web crawl (auction/press) → Researcher's Desk → Archivist's Desk
Finding new mentions/sales of the artist's work across the open web
(auction houses, galleries, museums, press, publications), logging them as
candidate finds, and promoting well-supported ones into actual drafts.

**Done:**
- [x] Researcher skill — on-demand web search logging into the "New Finds"
      bullpen (`research_finds`), read-only against the live catalogue.
- [x] Associate-archivist skill (Khalo) — can research a single named work,
      or process an uploaded source document, writing draft records with a
      full citation trail.
- [x] MutualArt-specific precedent: her full "Artworks for Sale & Sold"
      listing (95 items) was captured via a print-to-PDF workaround (not
      live crawling — see note below) and partially reconciled against the
      existing catalogue (12 auction-history citations on existing works, 1
      date-discrepancy reconcile flag, ~73 new drafts) — see item 1's open
      MutualArt entry for the part still not landed in the database.

**Important architectural constraint, discovered 2026-10-25:** MutualArt
actively blocks automated/headless access with bot-detection (a WAF
challenge, not a visual CAPTCHA) — a direct attempt to fetch it with a
headless browser was correctly blocked by this session's own safety
guardrails as bot-check circumvention. **Any future "automatic crawl" of
MutualArt specifically has to go through a human-driven browser (print-to-
PDF, then process the PDF through the existing pipeline), never a live
scrape** — this isn't a capability gap to engineer around, it's a "don't do
this" boundary. Other sites may or may not have the same restriction; check
before assuming a general-purpose crawler can reach them.

**Open:**
- [ ] A genuinely *automatic/scheduled* crawl (vs. an on-demand research
      run) — not built yet.
- [ ] Explicit "promote to Archivist's Desk once there's enough information"
      threshold/logic for a web-found candidate — currently promotion is a
      manual human/Khalo judgment call, not a defined automatic rule.
- [ ] Future idea (noted in CLAUDE.md, not built): scan the works listed in
      a given exhibition and try to pair them with existing work entries
      under an "Exhibitions" field — related to this theme but scoped as a
      separate task.

## 5. Social media crawl
Finding mentions/posts about the artist's work on social platforms.

**Open — not started:**
- [ ] `research_finds.category` already has a `'social-media'` option in the
      schema, but no actual crawling/searching logic targets social
      platforms yet. Everything here is still to be designed and built.
