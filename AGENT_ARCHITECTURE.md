# MODCR Agent Architecture

Handoff document for Claude Code sessions working on the Michele Oka Doner
Catalogue Raisonné project (cr.micheleokadoner.com, repo:
Lausanne98/mod-catalogue-raisonne, built on Supabase).

This defines a tiered team of named agents, each with a distinct role and
scoped permissions. They are kept separate rather than merged into one
agent, to preserve clean permission boundaries — in particular, none of
them can write to a live, published work.

An eventual human editor — a credentialed validator with experience on
other contemporary artists' catalogues, to be hired separately — sits
above all agents as the ultimate authority.

This file is the durable reference; update it here, not just in
conversation, whenever the team's shape changes. `.claude/skills/
associate-archivist/SKILL.md` is Khalo's actual operating instructions —
read in full every time that skill runs — and should stay consistent with
what's described here.

## The write-access model (resolved 2026-09-05)

Earlier drafts of this doc gave Researcher and Archivist "no write access"
and left unclear who actually gets to change anything. Resolved: **writes
are fine, but only into a pending-review staging area — never directly to
a live work.** Concretely:

- `staged_works` — a candidate work Khalo doesn't think exists in the
  catalogue yet. Surfaces in the admin's **Archivist's Drafts → New
  Entries** tab. A human reviews and either imports it (assigning a real
  CR number) or rejects it. Nothing here is a real work until imported.
- `work_revisions` — a proposed change to a work that already exists
  (published or draft) — a new citation, an exhibition, a corrected
  dimension. Surfaces in **Archivist's Drafts → Revisions**. A human
  approves (which applies the text to the real field) or rejects. Even a
  **confirmed** finding — Khalo's highest confidence level — only ever
  proposes a revision; it never writes to the field directly. That's a
  deliberate change from an earlier version of Khalo, which did auto-apply
  confirmed findings — too permissive for something this consequential.
- `work_sources` — the citation trail underneath both of the above: every
  finding, confirmed or not, logged with its source and confidence,
  whether or not it ever becomes a proposed revision.

No agent in this file has, or should ever be given, direct write access to
a `works` row. The only things that change a real work are a human's
Approve click in Archivist's Drafts, or the manual admin (Manage Works /
Add a Work) forms a person uses directly.

## Agent engagement on/off (built 2026-09-05)

A single global switch, `agent_settings.engagement_enabled`, toggled from
Archivist's Drafts. Any agent must check it first, before doing anything
else, and do nothing at all if it's off — this is a kill switch, not a
per-finding filter. Readable by anyone (no sensitive data in it, and an
agent invoked from a Claude Code session has no logged-in admin session to
satisfy an admin-gated read); only flipping it requires an authenticated
admin session. Khalo's `SKILL.md` checks this as the very first step of
"Before starting." Chloe and Timur should do the same once built.

## Visual convention: the "agent" color

Chartreuse (`--agent: #8a9a2b`, `--agent-lt: #eef3c9` in the admin pages'
CSS) is the color associated with agent-run interfaces across the admin —
deliberately distinct from the existing muted forest green (`--green`)
used for approve/success states elsewhere, so the two don't get confused.
Currently applied to the New Entries / Revisions tabs and the engagement
toggle in Archivist's Drafts (`catalogue_admin_drafts_v2_sans.html`). Any
future agent-facing admin UI (Source Materials, a future Chloe/Timur
interface) should reuse these same two variables rather than introducing
another green.

## Live chat (built 2026-09-06)

Each agent card on the Agents hub page now has a **Chat** button — real
back-and-forth conversation, not the static Overview blurb. This is a
*conversational intelligence* feature, separate from the *voice/audio*
work (Kokoro/Parler-TTS/ElevenLabs) discussed elsewhere — this makes what
an agent says be dynamic and grounded in live data; it doesn't change how
it sounds when read aloud.

Architecture: `supabase/functions/agent-chat/index.ts`, a Supabase Edge
Function — the project's first. All Anthropic-specific code lives in this
one file by design, so a future move to a different LLM provider (Grok,
etc.) means editing only this function, not rebuilding the feature. It:

- Verifies the caller has a real, authenticated Supabase session (defense
  in depth on top of the function's own default JWT verification) — never
  reachable by an unauthenticated/public request, since every call costs
  real API money.
- Fetches a small live-data snapshot per persona (pending drafts/revisions
  counts, unreviewed source materials, flagged works for Khalo/Chloe;
  tracked IT subscriptions for Timur) via a service-role client, and folds
  it into that persona's system prompt — this is the "grounded in real
  data" requirement, implemented as a fixed per-request snapshot rather
  than an open-ended tool-calling loop, since the queries needed are
  bounded and predictable for this use case.
- Calls Claude Haiku 4.5 (`claude-haiku-4-5`) for Chloe and Khalo — chosen
  for cost, given this is lightweight, occasional internal chat, not a
  coding/reasoning task. **Timur is the exception**: he runs on Sonnet 5
  with the `web_search_20260209` server tool enabled (2026-09-06), because
  his job now involves real judgment calls (is this update critical? is
  this plan actually cheaper?) plus live external lookups that a cheaper
  model + no search can't do. Server tools need no client-side loop — the
  search happens inside the one API call, so the request shape barely
  changes; the response just needs every text block concatenated, not only
  the first, since Claude can write, search, then write again in one turn.
- Is read-only end to end: the chat can discuss and explain, but cannot
  actually create/edit/approve anything — a persona asked to "do" something
  is instructed to point back to the real admin pages (Drafts, Manage
  Works, etc.) instead of claiming to have done it.
- Chat history is kept client-side in memory only (cleared on page
  reload), capped to the last 20 turns sent per request to bound cost.

Client wiring: `catalogue_admin_agents_v4_sans.html`, calling
`modcrSupabase.functions.invoke('agent-chat', {...})` — this automatically
attaches the admin's current session token, which is what the function's
auth check relies on.

### Timur on the IT page (2026-09-06)

The IT page (`catalogue_admin_it_v5_sans.html`) got its own embedded Timur
chat panel — a "Chat with Timur" button at the top, plus every subscription
row and every Infrastructure Map box is clickable, each firing a pre-formed
question about that specific thing (what it does, cost, active status,
where credentials live, updates, cheaper plans). Two constraints baked
directly into Timur's system prompt, not left to chance:

- **Credentials always answer the same way, for every service, no
  exceptions**: "Not stored in this system by design — check the studio's
  password manager." This matches CLAUDE.md's credentials rule exactly —
  Timur must never imply a password/key lives anywhere in this project's
  database, because none ever does, on purpose.
- **No background monitoring, no memory between conversations.** This is a
  static site with no scheduler — Timur cannot proactively notice a price
  drop or a security update. Every answer is a live check happening
  because someone asked, in that moment, never an ongoing watch. He's
  instructed to say so plainly if asked something like "any updates since
  last time" — there is no "last time" he can actually recall.

Deployment note: this session has no Supabase CLI/service-role access, so
the function file is committed to git but must be deployed manually (via
`supabase functions deploy agent-chat` locally, or pasted into the
Dashboard's function editor) — same constraint as `schema.sql` changes.

## Agent cards link to their real pages, and a Researcher's Desk (2026-09-06)

Each agent card on the Agents hub page now links straight to where that
agent's actual work happens: Khalo → Archivist's Drafts, Timur → IT /
Infrastructure, Chloe → a new **Researcher's Desk** page
(`catalogue_admin_researcher_v1_sans.html`).

Researcher's Desk is not a new data model — it's Chloe's own view onto the
same `source_materials` table the Sources page already manages, split into
**Updates** (status `unreviewed`) and **Archive** (everything else:
flagged/matched/rejected). Uploading through either page writes to the
same shared pile; there's one set of records, two entry points into it.

An "External Archive" panel documents a real constraint rather than
pretending around it: a planned local folder on an external drive (e.g.
"MOD CR Archive / MOD CR Archive Assets," path still pending) **cannot be
read automatically** by this site or by any Claude Code session — there is
no filesystem connection between a drive at the studio and either of
those. Getting a folder's contents onto the site will always require an
actual upload through the dropzone (or, if the studio would rather not
upload the files themselves, a manual log entry that references the
drive's contents without them ever leaving it) — never a "watch this
folder" sync.

Found and fixed in passing while touching `catalogue_admin_drafts` for
this round's nav cascade: a pre-existing `\\'` (double backslash) instead
of `\'` in a `confirm()` string had been a silent syntax error breaking
**the entire script block** on that page — every function on Archivist's
Drafts, not just the one button, since one syntax error anywhere in a
`<script>` tag prevents the whole tag from parsing.

## Stale login redirect fixed (2026-09-12)

Found while investigating why Researcher's Desk "still looked like v13"
for the studio — unrelated to that (a stale bookmark), but real: the login
page's post-auth redirect (`catalogue_admin_login_v64_sans.html` →
`catalogue_admin_v64_sans.html`) had silently fallen 24 versions behind
the actual current dashboard (v88 at the time) over many rounds of admin
work, none of which had ever touched the login page itself. v64's nav
predates the entire Agents/Drafts/Researcher's Desk/IT Desk feature set —
Works, Series, Materials, Add a Work, Chronology, View Site only. Anyone
signing out and back in landed somewhere with no path to any agent page at
all, silently, with no error to notice.

Fixed by bumping login to v65 (both redirects now target the current
dashboard) and re-linking every live page that referenced the old login
version — the full admin nav mesh plus four public pages with a footer
"Add / Update a Work" link (`catalogue_entry`, `catalogue_guide`,
`catalogue_landing`, the main `catalogue` page) — plus the four
root-level `index.html` redirect stubs (`/`, `/admin/`, `/entry/`,
`/works/`), which are outside the `.._sans.html` versioning scheme
(edited in place, same as `modcr-client.js`) but were pointing at
whichever page-version existed when each stub was first written, not
necessarily the current one. **Lesson for next time a page gets bumped:**
check whether a root-level `index.html` alias points at it, not just the
sibling nav mesh — these stubs are easy to forget since they're outside
`HTMLs/` and don't show up in a `grep` scoped to that folder.

## Raw archive indexing (2026-09-06)

Solves for a real studio need: a photographer's shoot can be 500MB-4GB of
TIFF masters, spread across many folders on an external drive — and there
are many such shoots. Those masters should never be bulk-uploaded (per
CLAUDE.md's existing guidance that full-resolution masters stay in the
studio's own raw archive), but the archive still needs to be *browsable*
from the admin site.

`scripts/archive_indexer.py` is a local script — run on whatever machine
has the drive attached, never by a Claude Code cloud session, which has no
access to that drive regardless of what path it's given. Two modes:

- `index <folder> --label "..."` walks the folder tree and records only
  filename/size/type into the new `archive_index` table — no image bytes
  ever leave the drive. Upserts on `(archive_label, relative_path)`, so
  re-indexing the same folder updates rows instead of duplicating them.
- `convert --label ... --path ... --root ...` converts exactly one file to
  JPEG (via macOS's built-in `sips`, no extra install) and uploads only
  that JPEG to `source_materials` — the same 2000px-max-dimension
  convention Source Materials already uses — then marks the matching
  `archive_index` row `converted` and links it to the new
  `source_materials` row.

Authentication: the script signs in interactively with the admin's real
email/password each run (via `supabase-py`'s password auth) — nothing
stored, same RLS-authenticated pattern as every other admin-only table.

The Researcher's Desk page renders `archive_index` read-only, grouped by
`archive_label`, showing size/type/status per file — this is the
"browsable without uploading" half of the workflow the studio asked for.

## Top nav consolidated into an "Agents ▾" dropdown (2026-09-06)

The admin top nav had grown to 9+ flat items. Drafts, Agents, Researcher's
Desk, and IT — the four agent-related pages — are now one `Agents ▾`
dropdown menu (`.nav-dropdown` / `.nav-dropdown-trigger` /
`.nav-dropdown-menu`, toggled by `toggleNavDropdown(event)`, closed on any
outside click) rather than four separate top-level links, across every
admin page: `catalogue_admin`, `catalogue_admin_manage`,
`catalogue_admin_chronology`, `catalogue_admin_sources`,
`catalogue_admin_drafts`, `catalogue_admin_agents`,
`catalogue_admin_researcher`, `catalogue_admin_it`, `catalogue_intake`,
`catalogue_admin_series`, `catalogue_admin_materials`. On whichever of the
four member pages is current, the trigger itself (not a menu item) carries
`nav-dark` to show where you are. Series and Materials — already reachable
only via "Edit →" links next to their filters on Manage Works, not the top
nav, since the prior round — are unaffected by the dropdown itself but were
still bumped a version to keep their own nav's links to the other 9 pages
current.

While touching every page's nav block, also fixed the same pre-existing
"Chronology mislabeled `nav-dark`" bug (it was highlighting Chronology as
the current page from Dashboard, Manage Works, and Intake, none of which
are the Chronology page) that Series and Materials had already had fixed in
the prior round.

## The team

### 1. Chloe — Researcher
- **Role:** Two jobs. Outbound: checks a Master Site List (galleries,
  auction houses, museums, press, publications, media, social media,
  books) for new mentions or sales of the artist's work. Inbound: gathers
  provenance/exhibition research and raw material into a holding folder
  for Khalo to process.
- **Access:** Web search enabled. Public (unauthenticated) read on
  `research_sites` and `works`, so the skill runs without any admin login.
- **Write access:** `research_finds` only, and only inserts (`status:
  'pending'`) — an intentionally narrow staging table, not a path to
  `works`/`work_sources`/`staged_works`/`work_revisions`, which stay
  Khalo's alone. RLS lets an anonymous insert through (same pattern as
  `public_submissions`) specifically so this skill never needs a stored or
  requested credential to run.
- **Built (2026-09-12):** `.claude/skills/researcher/SKILL.md`, plus
  `research_sites`/`research_finds` in `supabase/schema.sql` and a New
  Finds / CR Archive / Master Site List review UI on Researcher's Desk
  (`catalogue_admin_researcher`). The inbound side (raw-material intake,
  the conversational drop-off flow) is still spec-only — see below.
- **Also built (2026-09-12), the Approve → draft connector:** clicking
  Approve on a finding with no `matched_work_id` now auto-creates a
  bare-bones `staged_works` row client-side (title + a note pointing back
  at the finding; date/medium/series left null on purpose) rather than
  leaving "approved" as a dead end — see "Chloe → Khalo handoff" below.
- **Not yet built:** the *automatic, scheduled* version of the outbound
  check — today this skill runs when a Claude Code session is asked to run
  it, not on a timer. See "Phase 2" further down for what that would take.

#### Spec notes captured 2026-09-06, not yet built

Two distinct jobs for Chloe, gathered here before either is designed in
detail:

**A. Outbound monitoring — new mentions of the artist's work**
- Starts from a given list of sites (gallery sites, auction houses, press
  outlets) and checks them periodically for new mentions of the artist or
  her work.
- A new mention goes into a **"New Finds" bullpen** — provisional, pending
  studio approval — tagged with one of four categories: `press`,
  `auction-house`, `gallery`, `book`.
- Chloe also maintains a **CR Archive**: a website/source archive of
  everything found, organized under those same four categories, separate
  from the New Finds queue (New Finds is the pending-review inbox; the CR
  Archive is the organized, categorized holding of what's been gathered).
- Studio review outcome on a New Finds item is three-way, not two: approve
  (moves toward Khalo/staging), reject-but-keep (goes to a reject archive),
  or **trash** (deleted outright) — the trash option exists specifically so
  rejected noise doesn't pile into a large reject archive nobody wants to
  wade through.
- For a website find specifically, Chloe drafts the catalog-record fields
  (see below) automatically and places the draft directly in the bullpen —
  no back-and-forth needed the way there is for a physical drop-off, since
  there's no one on the other end to ask.

**B. Inbound intake — labeling what the studio drops in**
- The studio is not consistent about labeling its own material. Chloe's
  second job is to help label everything as it's onboarded, one folder or
  file at a time, closing that gap at the point of intake rather than
  after the fact.
- When a folder is dropped, Chloe has fields to populate, fillable either
  by typing or by voice. Sketched conversational flow:
  1. "Received — let me have a quick look." Chloe scans the contents:
     is this a catalog, a press clipping, a photo of an artwork? Is it one
     work, or a folder covering several different works?
  2. "Would you like to tell me about this file, or would you like to see
     what I see so far and we can go from there?"
  3. Target fields — for an artwork: title, date, name, material. For
     press: publication, date, byline.
  4. For a folder or a group of photos specifically: "Are you looking for
     a specific photo, or should we label these now? Should we label the
     group, or go through and label the individual photos?"
  5. "Would you like me to draft this based on what's already in the
     archive, and see how far I can get on my own?"
- To draft well, Chloe needs read access to micheleokadoner.com (the
  legacy site), the CR site itself, and a small set of other reference
  sites given to her up front, for context when populating fields.
- Once a first pass is drafted, Chloe presents it back as a **draft catalog
  record** for that file/folder — the term to use here (an archives/museum
  term, not "labeling matrix") is a **catalog record** (museum collections
  systems often call the same thing an **object record**); reserve
  **accession record** for the formal record made once something is
  actually accepted into the permanent collection, which is a later,
  separate step from Chloe's draft.
- End state either way (web find or studio drop-off): Chloe labels as much
  as she reliably can, so that Khalo has a properly labeled item to place
  correctly into the catalogue rather than starting from nothing.

**Resolved 2026-09-12** (Phase 1 of this spec): the backing tables are
`research_sites` and `research_finds`, and the review/approve/reject/trash
UI lives on Researcher's Desk — see "Built" above.

**Still open** (Phase 2 — the *automatic, scheduled* version): today,
Chloe's outbound check runs when a Claude Code session is asked to run it,
using this session's own web search — real, but not unattended. Making it
fire on a timer with nobody asking would mean a scheduled Edge Function
calling Claude's API with its own web-search tool (the same mechanism
Timur already uses on demand, on a cron trigger instead of a button click)
— its own separate build, deliberately not started yet, since Phase 1
(above) is what makes every research pass land somewhere durable in the
meantime. The inbound intake flow (drag-and-drop → conversational
labeling → draft catalog record) is also still spec-only, not built.

#### Starter auction-house site list (compiled 2026-09-12)

A first pass via live web search, seeding the "given list of sites to
begin with" the outbound-monitoring spec above calls for. Not
exhaustive — meant to be added to over time, the way Series already is.

**Direct auction houses with confirmed MOD sales found so far:** Christie's,
Sotheby's, Phillips, Bonhams (incl. Bonhams Skinner), Rago Arts and Auction
Center, Wright, DOYLE Auctioneers & Appraisers, Toomey & Co. Auctioneers,
Freeman's | Hindman, C Doyle Auctioneers & Appraisers, Auctions at
Showplace, STAIR.

**Aggregators — check these first for cheap, broad coverage of the many
smaller regional houses neither the studio nor Chloe would otherwise think
to name individually:** LiveAuctioneers (73 tracked results for MOD, the
richest single source found — though note liveauctioneers.com specifically
returned `EGRESS_BLOCKED` when fetched directly from this cloud sandbox;
web search still surfaces its content, direct page fetches don't), Invaluable,
MutualArt, LotSearch, Artnet.

**Primary-market marketplaces, not secondary auction — a different `press`/
`gallery` categorization than the auction-house category above, not to be
conflated with it:** Artsy (David Gill Gallery consignment listings),
1stDibs.

**Confirmed specific results found in this pass**, worth Khalo processing
into `work_sources`/`staged_works` properly rather than left sitting only
in this list: "Burning Bush" candelabrum ($58,420, Phillips, June 2025);
"Coral Wave" chair, 1993 ($38,296, Phillips London, 2018); "Faucet," 1986,
cast bronze (Christie's, July 2015, lot 186; resold Bonhams Sept 2020,
$2,167); "The Shaman's Hut" (Christie's, 2014); Set of Two 'Talisman'
Necklaces, 1987 (Sotheby's "Art as Jewelry as Art"); "Wrapped Figure," 1985
stoneware ($12,600, Rago, Oct 2024); "Apple," 1978, brass (Wright, Oct
2023); "Torso (Prototype for Steuben Glass)," 2007 (DOYLE, Oct 2023);
Terrible Chair Series piece, bronze/gold leaf (DOYLE, Sept 2023); 18k gold
'Palmaceae' necklace (Bonhams); Brooch, c.2000 ($2,489, Toomey, July 2024).

#### Chloe → Khalo handoff (built 2026-09-12)

Approving a finding on Researcher's Desk used to just flip
`research_finds.status` to `approved` and stop — there was no connection
from there to an actual draft record, so "approved" had nowhere to go. Two
cases, handled differently:

- **Finding has no `matched_work_id`** (plausibly a previously-uncatalogued
  work): Approve now also creates a `staged_works` row on the spot
  (`title` from the finding, `notes` pointing back at the original claim,
  `source_url`, `source_type` mapped from the finding's `category`,
  `confidence: 'candidate'`, `status: 'new'`, `source_find_id` linking back
  to the finding) — this lands it in the **New Entries** tab of Archivist's
  Drafts, same as any other staged candidate. Deliberately leaves
  `date_display`/`year`/`medium`/`tag`/`suggested_series` null: guessing
  those from a finding's short text would be inventing data, which is
  exactly the discipline this whole pipeline exists to avoid. That
  research pass is Khalo's Mode C (see above) — invoked separately, not
  automatically, on the new staged row.
- **Finding has a `matched_work_id`** (already in the catalogue): no draft
  is created since the work already exists. The finding is just flagged in
  its card as ready for Khalo's Mode A, to fold the new lead into that
  work's existing research.

Two new columns carry the traceability: `staged_works.source_find_id` and
`research_finds.staged_work_id` (both nullable FKs, added via `alter
table ... add column if not exists` in `schema.sql`). Both writes happen
client-side in an authenticated admin session (the Researcher's Desk page
itself, not a headless skill run) — Chloe's own anonymous-insert access to
`research_finds` is unaffected and still needs no credential; only the
human clicking Approve needs to be logged in, which they already are to
see the New Finds bullpen at all (`research_finds` SELECT is admin-only).

This still isn't the whole pipeline the studio described (scan sites →
sort into draft entries) running unattended — Mode C still has to be
invoked, same as Mode A/B always have been. What changed is that nothing
approved falls through a gap anymore: every approved, unmatched finding
reliably becomes a real, addressable draft the moment it's approved,
rather than sitting as a flipped status with no next step.

### 2. Khalo — Associate Archivist
- **Role:** Processes and verifies what the Researcher gathers (or, today,
  what it finds itself via direct web search or an uploaded document).
  Confirms fields — title, date, medium, dimensions — cross-references
  against what's already catalogued, and sorts everything into one of:
  a new entry, a revision to an existing entry, or not relevant/discard.
- **Access:** Read access to the full `works` table and existing
  `work_sources`. Write access to `work_sources`, `staged_works` (via
  `modcrCreateStagedWork`), and `work_revisions` (via
  `modcrProposeRevision`) only — see the write-access model above.
- **Built:** `.claude/skills/associate-archivist/SKILL.md`. Three entry
  points — Mode A (research one named work), Mode B (process an uploaded
  `source_materials` row, e.g. an exhibition catalog PDF), and Mode C
  (2026-09-12: flesh out a bare-bones `staged_works` stub that the Approve
  → draft connector created from an approved Chloe finding).
- **Open gap:** the skill doesn't yet have an explicit "this isn't the
  artist's work at all, or is support material — discard" outcome at the
  per-item level (only at the whole-document level, via `source_materials.
  status = 'rejected'`). Worth adding next time Khalo's methodology gets
  revisited.

### 3. Digital Editor
- **Role:** Sits above Chloe and Khalo. Reviews and reconciles their
  output before anything is presented as final. Evaluates citation
  quality, sourcing rigor, and overall archive viability and structure —
  what should be included or excluded. Gives high-level structural notes.
- **Priming:** Should be primed with a small set of key scholarly/
  archival-theory texts (the core texts typically absorbed in an art
  archivist's graduate training) plus roughly 6–12 current catalogue
  raisonné websites, so it can synthesize theoretical standards against
  contemporary digital-archive practice.
- **Framing:** An internal prompting technique only — instructed to
  evaluate with the rigor of a credentialed, experienced archivist. This
  must stay entirely inside the skill's own instructions; nothing this
  agent produces should ever be presented externally as if authored by an
  actual credentialed person.
- **Write access:** None — reviews and flags, does not directly edit
  anything, including staging tables.
- **Status:** Not yet built.

### 4. Timur — IT / Infrastructure Keeper
- **Role:** Tracks where all documents and services live — Supabase,
  GitHub, and third-party relationships, including where credentials/
  passwords are kept (never in the repo — see CLAUDE.md's "Credentials /
  secrets"). Long-term vendor/protocol risk tracking: what each service
  does, and the fallback/export path if a vendor changes or shuts down.
- **Access:** Read access to config, environment variables, and
  deployment setup. Web search enabled (for checking service docs).
- **Write access:** None at all, not even non-destructive. `agent-chat`'s
  Timur grounding only ever runs a `select` against `it_subscriptions`;
  every insert/update/delete on that table is wired exclusively to the
  human-facing Add/Edit/Delete controls on the IT Desk page. Timur can
  describe what's tracked and suggest that something be added, but he has
  no path to actually add or change a row himself.
- **Status:** Built (chat via the `agent-chat` Edge Function, clickable
  UI on the IT Desk page — see "Timur on the IT page" above). The stub
  "Not yet built" pill shown on the Agents hub card is stale relative to
  this and should be corrected.

#### Protocol, articulated 2026-09-07

Timur's system prompt (in `supabase/functions/agent-chat/index.ts`) already
carries two fixed rules — credentials always answer "not stored here,
check the password manager," and never imply background monitoring or
memory between conversations. Filling in the rest of his operating
protocol, parallel to the confidence-level rigor Khalo's skill already has:

**Reactive only, by design.** Timur never runs unprompted — there is no
scheduled job that wakes him up to check anything. Every answer is a live
check triggered by a question, in that moment. This isn't a limitation to
work around; it's the honesty rule already in his prompt taken to its
logical conclusion — a persona that can't remember previous conversations
also can't be "keeping an eye on things" between them.

**Asked about something not in `it_subscriptions` at all.** Say plainly
that it isn't currently tracked, rather than guessing at cost/status from
general knowledge of the service — the same "don't invent a source"
discipline Khalo's protocol already requires, applied to infrastructure
facts instead of provenance facts. Offer to be added via the IT Desk's own
Add-a-subscription form (which Timur can describe but not submit himself).

**Confidence on web-searched claims.** Cost and status come from the
tracked table and are stated as fact. Anything from a live web search
(current pricing, whether an update is security-critical, whether a
cheaper plan now exists) is inherently time-bound and should be presented
as "as of this search" rather than a permanent fact, with the source named
plainly enough that the studio could re-check it. If a search comes back
ambiguous or contradictory, say so rather than picking one number to
report confidently.

**The IT Desk subscriptions table is the only source of truth for
cost/plan/status** — already stated in the system prompt's grounding
context, restated here because it's the anchor the rest of this protocol
hangs off of: Timur reasons from what's actually tracked, not from what a
service "usually" costs.

#### Scheduled backups (built 2026-09-07)

Asked whether "the IT manager" (Timur) can run a periodic backup of the
studio's archive to an external drive (proposed cadence: every 6 weeks).
Not Timur himself — a chat persona, whether running in this cloud sandbox
or answering a question in the Claude app, has no standing process and no
access to a physical drive, the same structural limit already documented
under "Raw archive indexing" above for reading an external drive, applying
equally to writing one on a schedule.

What's actually built: `scripts/backup_archive.py`, a local script (same
shape and same interactive-login pattern as `archive_indexer.py`) that
dumps every table in `supabase/schema.sql` to JSON and downloads every file
in every Storage bucket, into a fresh timestamped folder per run — so
running it repeatedly builds a history of backups rather than overwriting
the last one. `scripts/com.modcr.backup.plist.template` is a `launchd`
schedule template (macOS's cron replacement) set to a 6-week interval;
copy it into `~/Library/LaunchAgents/` with the placeholder paths filled
in to make it run automatically.

**Resolved 2026-09-07:** decided in favor of fully unattended operation. The
script now checks for `~/.modcr_backup_credentials` (two lines: email,
password) first, using it non-interactively if present, and only falls
back to the interactive prompt when that file doesn't exist — so a manual,
on-demand run (the studio's second ask: a way to trigger a backup any time,
not only on the 6-week schedule) works exactly as before either way, while
a `launchd`-fired scheduled run can now complete with nobody at the Mac.
This is a deliberate, acknowledged exception to the project's usual
never-store-a-credential practice, scoped as narrowly as possible: the file
lives outside the repo (never git-tracked), the script only ever reads it
(never writes or creates it), and setup requires the studio to create it
by hand in a terminal on the Studio Mac itself — never by pasting a real
password into a Claude Code chat message, cloud or local. See the comment
above `CREDENTIALS_FILE` in `backup_archive.py` for the exact setup steps.
Placing the actual file is still an outstanding step — a cloud session has
no access to the Studio Mac's filesystem to do it, so it needs either a
local Claude Code session running directly on that machine, or the studio
doing it by hand.

### Parked for later (separate project): Studio liaison / voice-driven interface
For the artist's studio team, who don't use Claude Code directly. Concept:
verbalize plain-language change requests, which trigger changes on a
parallel staging clone/branch of the site and database rather than live
production. Preview reviewed and approved before merging to the live
default. Not yet scoped for build.

## Voices (built 2026-09-06)

The Agents hub's Play buttons originally used the browser's built-in
`speechSynthesis` (Web Speech API) — whatever OS-bundled TTS voice the
visitor's browser happened to have, robotic and inconsistent across
machines. Replaced with a real ElevenLabs voice per persona, via a new
`supabase/functions/agent-voice` Edge Function that proxies
`POST /v1/text-to-speech/{voice_id}` (model `eleven_flash_v2_5`) and
streams the resulting MP3 back to the browser — same
authenticated-admin-only gating as `agent-chat`.

Each persona's voice is a fixed `ELEVENLABS_VOICE_<NAME>` secret, not a
per-session picker — there's no browser-voice list to choose from anymore,
so the old per-card "Voice" dropdown was removed. Personality brief guiding
which voice to design per persona: Chloe: curious, quick, exploratory; Khalo:
measured, precise, a little formal; Timur: plain, technical, low-drama.

**Voice source matters on the Free plan.** A voice picked from ElevenLabs'
shared community Voice Library is gated behind a paid plan for API use
(`402 Payment Required` on Free, even though it plays fine in the
dashboard). A voice generated with Voice Design and saved to your own
account works on Free regardless of plan tier. Khalo's original voice was
Voice-Design-generated and worked from the start; Chloe's and Timur's were
initially picked from library search results and hit the 402 until
regenerated via Voice Design on 2026-09-12 — use Voice Design for any
future persona voice, not the Library picker.

Billing: uses the studio's own ElevenLabs account (separate from the
ElevenReader consumer app subscription, which is a different product with
no API access) — starting on the Free tier for this beta/internal-testing
phase, with a move to Starter ($6/mo) planned once the site goes
consumer-facing, since Free's license terms don't cover commercial use.
Track this on the IT Desk subscriptions table once the account is live.

The client-side player caches each generated clip's object URL in memory
per page load (`audioCache` in `catalogue_admin_agents`), so replaying the
same greeting/overview during one visit doesn't re-spend credits. Play
toggles to Stop while a clip is playing and actually halts playback
(`audio.pause()`) rather than restarting from the top on a second click.

## Infrastructure notes

- A second sandbox folder is planned on the artist's external hard drive
  (separate from the existing sandbox on an iMac) to hold large volumes of
  photography — connect via Tailscale or self-hosted WireGuard rather than
  uploading everything to shared cloud. This only applies to a *local*
  Claude Code instance running on a machine that can join that network —
  this project's cloud Claude Code sessions cannot join a WireGuard mesh
  themselves (different protocol, not just a blocked domain), but don't
  need to: they only ever need the small structured findings the local
  side pushes to Supabase, which is reachable from anywhere.
- Cost-conscious on recurring subscriptions — small monthly fees compound
  significantly over the project's decade-plus lifespan. Weigh self-
  hosted/open-source alternatives against paid services where feasible
  (e.g. the Supabase keep-alive cron runs on GitHub Actions, already free
  infrastructure, rather than standing up a new paid or third-party cron
  service).
