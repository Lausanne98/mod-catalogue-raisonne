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
- **Role:** Gathers provenance and exhibition-history research,
  bibliographic lookups, and raw material (photography, catalogs,
  documents) into a holding folder for the Archivist to process.
- **Access:** Web search enabled. Read access to existing catalogue data
  (to cross-check findings against what's already recorded).
- **Write access:** None to the database. Saves files to a folder, not to
  Supabase directly.
- **Status:** Not yet built as a skill. Khalo (below) currently does its
  own web research directly (Mode A) rather than consuming Chloe's output
  — splitting that into a real separate Researcher pass is the next piece
  of this team to build.

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

Open design questions, deliberately not resolved yet: what table(s) back
the New Finds bullpen and the CR Archive (extend `source_materials`, or a
new table per CLAUDE.md's "adding a table is normal" precedent); how
outbound monitoring is actually triggered on a schedule (a cron-triggered
Edge Function, most likely, mirroring the existing GitHub Actions
keep-alive pattern rather than a new paid scheduler); and the UI for the
draft-catalog-record review/approve/reject/trash flow. Worth a dedicated
design pass before building, given the size of this feature.

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
- **Built:** `.claude/skills/associate-archivist/SKILL.md`. Two entry
  points — Mode A (research one named work) and Mode B (process an
  uploaded `source_materials` row, e.g. an exhibition catalog PDF).
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

**Open tension, deliberately not resolved:** the script authenticates the
same way `archive_indexer.py` does — prompting for the admin email/password
interactively, nothing ever stored — which is the safest option but means
a `launchd`-scheduled run will sit waiting for input nobody's there to
give, unless someone is physically at the Mac when it fires. Making it
truly unattended would mean storing *some* credential on disk for the
script to read on its own (a local, out-of-git credentials file, or a
Supabase service-role key) — a real, if modest, step up in what's exposed
if that Mac is ever compromised, compared to the project's current
practice of never storing a credential anywhere. Worth a deliberate choice
before relying on this fully hands-off, rather than picking silently.

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

Each persona's voice is a fixed `ELEVENLABS_VOICE_<NAME>` secret (a
voice_id picked from the studio's own ElevenLabs Voice Library), not a
per-session picker — there's no browser-voice list to choose from anymore,
so the old per-card "Voice" dropdown was removed. Personality brief guiding
which voice to pick per persona: Chloe: curious, quick, exploratory; Khalo:
measured, precise, a little formal; Timur: plain, technical, low-drama.

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
