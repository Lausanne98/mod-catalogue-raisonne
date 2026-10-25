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
      platforms yet.

**Full handoff spec received 2026-10-25 — "MODCR Social Media Citations:
Handoff for Claude Code (v1)".** This is "Workstream D" of a referenced
`MODCR_Agentic_Layer_Brief_v1.md`, which is **not currently in this repo** —
treat that reference as external until/unless it's added here. Filed below
as received; not started.

**Context:** Social media is a subsection of Citations, on both the admin
intake form and the public work page. Every social post — pasted in by a
person or found automatically — lands as a draft in that Social Media
subsection, attached to one or more works. Nothing goes public without
human approval. Platforms in scope: Instagram, TikTok, X, YouTube.

**Ground rules for whoever builds this:**
- [ ] Build in a worktree or separate branch; create new table(s) only —
      never alter/delete/migrate existing tables.
- [ ] No deletes or destructive SQL — write SQL out for Jordan to run
      himself; the Supabase connection for this work is read-only.
- [ ] No publishing of any record without human approval.
- [ ] No automated screenshot/screen-recording capture of third-party
      posts — a stored copy is saved only once Permissions status is
      "granted".
- [ ] Version each deliverable sequentially (v1, v2, v3...).
- [ ] If a tool call fails twice, stop and ask — don't switch to a more
      permanent workaround.

**What's recorded per post:** platform, account handle, post date, view
count (where available), URL, which work(s) it concerns, rights status,
and a human-entered note. Store only the URL and human-entered facts
wherever a platform's terms don't allow persisting embed content/metadata.

**Capture approach:** each platform's oEmbed endpoint for a live embed +
basic metadata (not a copy of the photo/video file); check each platform's
current persistence terms before storing any metadata; optionally offer an
archived link (Wayback Machine / Perma.cc) as a link-rot safeguard, after
confirming that service's own terms work for the platform.

**Permissions tab:** tracks rights status per post (not requested / drafted
/ sent / granted / declined); drafts outreach (DM/email) for human approval
before sending; only on "granted" can the stored asset be saved and linked.

**Stories fast path (24-hour expiry):** a Story-based mention gets flagged
time-sensitive with a pre-drafted, one-tap permission request queued for
human approval. If the Story expires first, log it as missed/expired
(account, date, what was observed) with no capture.

**Manual capture (intake form fields — build first):** this is expected to
be the primary path, since capture will be serendipitous/incomplete.
- [ ] Add a separate Social Media subsection under Citations (alongside
      Publications) — appears only when at least one social entry exists
      on that work (site-wide empty-is-invisible rule: no blank labels/
      placeholders anywhere, public page or saved-record display alike).
- [ ] Every field on a social entry is optional: media (screenshot/image/
      video drag-and-drop, into the same media storage/library as every
      other CR media, not a separate store), account name, post date, view
      count, original post URL. A record with only an uploaded media file
      and nothing else must stand on its own with no empty text below it.
- [ ] Each new entry is a draft; rights status defaults to "not requested";
      nothing shows publicly until approved, and a stored copy shows
      publicly only once rights status is "granted".
- [ ] A time-sensitive checkbox for Story captures, triggering the Stories
      fast-path permission request.
- Acceptance: a draft with only an uploaded screenshot saves and displays
  with no empty labels; adding an account name makes it appear; removing
  it makes it disappear again.

**Phase 1 — research only, no building, stop for review:**
- [ ] Per platform (Instagram, TikTok, X, YouTube): how a post can be found
      automatically today — official API options, access requirements,
      cost, rate limits, what each returns.
- [ ] Paid third-party monitoring/listening services covering these
      platforms — approximate cost/reliability; flag any relying on
      scraping that violates platform terms.
- [ ] Each platform's current terms on oEmbed persistence and on scraping.
- [ ] A recommendation for the lowest-risk discovery route. Do not build
      any crawler/scraper, and do not create accounts or API keys without
      Jordan's approval, in this phase.

**Phase 2 — manual link-paste path (build first):** researcher pastes a
post URL into the admin citations form; system detects the platform,
fetches the oEmbed embed + allowed metadata, shows the live embed,
pre-fills account/date/view-count where permitted; a human links it to
one or more works and approves before saving.

**Phase 3 — Permissions tab + Stories fast path:** build the rights-status
workflow and drafted outreach, then the Stories flag, per the sections above.

**Phase 4 — public display:** under Citations on the public work page,
social posts show as one or two example tiles at roughly one-third scale,
expandable to the full set, each clickable into its own citation, platform
icons identifying the source. Front-end task, follows the CR design
language.

**Phase 5 — automatic discovery, only if Phase 1 finds a compliant
route:** expectation going in is that Instagram/TikTok/X don't allow
reliable automatic crawling, so the manual intake fields are likely the
whole feature in practice. Possible exception: tag/mention notifications
from the studio's own Instagram account via the official API, feeding
drafts. If a compliant route exists: discovered posts enter as drafts
only, never published; a post matching an already-live work becomes a
draft revision of that work's record; a post matching no known work
becomes a new draft entry; a human reviews and approves every draft. If
Phase 1 finds no compliant route, skip this phase entirely — no crawler.

**Acceptance checks (whole feature):**
- [ ] Given a post URL, the record shows platform, account, date, views
      where permitted, and a live embed.
- [ ] No media file is stored unless the Permissions tab shows "granted".
- [ ] A Story mention produces a flagged, pre-drafted permission request.
- [ ] Nothing is published without human approval.

**Non-goals:** no scraping that violates a platform's terms; no automated
capture of third-party social content without granted permission; no
changes to the PDF pipeline or the existing agents.
