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
- **Write access:** No destructive write access by default.
- **Status:** Not yet built.

### Parked for later (separate project): Studio liaison / voice-driven interface
For the artist's studio team, who don't use Claude Code directly. Concept:
verbalize plain-language change requests, which trigger changes on a
parallel staging clone/branch of the site and database rather than live
production. Preview reviewed and approved before merging to the live
default. Not yet scoped for build.

## Voices

Open item, not yet decided: each named agent (Chloe, Khalo, Timur) could be
given a distinct voice for spoken interaction (e.g. via the Claude mobile
app's voice mode). That's a per-conversation setting in the Claude app
itself, not something a Claude Code session can configure or assign in
advance — there's no file or API call here that "sets Chloe's voice." If a
consistent voice per persona matters, the practical approach is picking one
manually in the app when talking to each persona, guided by a short
personality brief for each (e.g. Chloe: curious, quick, exploratory; Khalo:
measured, precise, a little formal; Timur: plain, technical, low-drama) —
worth pinning down there rather than here if it turns out to matter.

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
