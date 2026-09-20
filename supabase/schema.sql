-- MOD Catalogue Raisonné — Supabase schema, RLS policies, storage buckets, and
-- data migration from the static works array. Paste this whole file into the
-- Supabase SQL Editor (Project → SQL Editor → New query) and run it once.
--
-- Safe to re-run: uses "if not exists" / "on conflict do nothing" throughout.

-- ═══ SERIES (reference table + phase/rollout control) ═══
-- Mirrors PUBLISHED_SERIES in catalogue_v10_sans.html / catalogue_entry_v6_sans.html.
-- Toggling `published` here is how a future phase goes live once the backend
-- is wired up — no code deploy needed at that point.
create table if not exists series (
  slug        text primary key,
  label       text not null,
  published   boolean not null default false,
  sort_order  integer not null default 0
);

insert into series (slug, label, published, sort_order) values
  ('early-clay',           'Early Clay',      true,  1),
  ('jewelry',               'Jewelry',         false, 2),
  ('works-on-paper',        'Works on Paper',  false, 3),
  ('public-installations',  'Public Works',    false, 4),
  ('commissions',           'Commissions',     false, 5),
  ('bronze-works',          'Sculpture',       false, 6),
  ('fables',                'Fables',          false, 7),
  ('editions',              'Editions',        false, 8),
  ('publications',          'Publications',    false, 9),
  -- Granular, named sub-series (see CLAUDE.md "Granular named series") — a work's
  -- own body-of-work grouping, distinct from the broad material/category buckets
  -- above. A ceramic/pre-2000 work in one of these still cross-categorizes into
  -- Early Clay per the existing rule regardless of this more specific series.
  ('thorn-men',             'Thorn Men',        false, 10),
  ('terrible-chairs',       'Terrible Chairs',  false, 11),
  ('talisman-series',       'Talisman',         false, 12),
  ('radiant',               'Radiant',          false, 13),
  ('pollinators',           'Pollinators',      false, 14),
  ('hominim-relics',        'Hominim Relics',   false, 15),
  ('tattooed',              'Tattooed',         false, 16)
on conflict (slug) do nothing;

-- ═══ MATERIALS (Medium/tag reference table) ═══
-- Was originally a hardcoded CHECK constraint on works.tag, deliberately kept
-- fixed/rarely-changing per CLAUDE.md's Medium taxonomy. Converted to a real
-- table so it can be managed from admin (Manage Materials) the same way
-- Series is — add/remove a material there instead of a code change. Kept
-- alphabetically ordered by label; unlike series it has no published/
-- sort_order concept, since there's no "coming soon" phase for a material.
create table if not exists materials (
  slug   text primary key,
  label  text not null
);

insert into materials (slug, label) values
  ('paper',            'Paper'),
  ('ceramic',           'Ceramic'),
  ('bronze',            'Bronze'),
  ('gold',              'Gold'),
  ('silver',            'Silver'),
  ('diamonds',          'Diamonds'),
  ('stone',             'Stone'),
  ('concrete',          'Concrete'),
  ('organic-material',  'Organic Material'),
  ('glass',             'Glass'),
  ('steel',             'Steel'),
  ('canvas',            'Canvas'),
  ('painting',          'Painting'),
  ('photography',       'Photography'),
  ('video',              'Video')
on conflict (slug) do nothing;

-- ═══ WORKS ═══
create table if not exists works (
  id           uuid primary key default gen_random_uuid(),
  cr_number    integer not null unique,          -- "MOD CR 6" -> 6
  title        text not null,
  date_display text,                             -- e.g. "c. 1975", "Date pending"
  year         integer,                          -- null if genuinely unknown
  medium       text,                             -- descriptive free text, e.g. "Raku ceramic"
  tag          text references materials(slug),  -- nullable: a work with no clean single Medium
                                                    -- value (see CLAUDE.md "Known open item")
                                                    -- stays unset, not guessed
  series       text not null references series(slug),
  secondary_series text references series(slug),  -- optional: work also belongs under a
                                                    -- second series filter (e.g. a jewelry
                                                    -- piece that's also part of a limited
                                                    -- edition run), in addition to its
                                                    -- primary `series` above.
  dimensions   text,
  title_source text,                             -- e.g. "Artist", "RLF" (Roy Lichtenstein Foundation-style label), "Estate"
  inscriptions text,                             -- e.g. "Foundry mark on base: [Tallix / 1972]"
  collection   text,                             -- e.g. "The artist's collection", "Private collection, New York"
  description  text,
  provenance   text,
  exhibitions  text,                             -- free text for now, one entry per line
  literature   text,                             -- free text for now, one entry per line
  revisions    text,                             -- admin-authored change log, one dated entry per
                                                   -- line ("date, then note"), same pattern as
                                                   -- provenance/exhibitions/literature -- not an
                                                   -- automatic audit trail
  remarks      text,
  flag         text,                             -- data-quality flag, e.g. "icon mismatch"
  legacy_image_url text,                         -- bridge: existing GitHub Pages-hosted image,
                                                   -- used until/unless a real work_photos row exists.
                                                   -- New intake uploads should use work_photos + Storage.
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists works_series_idx on works(series);
create index if not exists works_tag_idx on works(tag);

-- Self-healing for a table created by an earlier, buggy version of this script
-- (tag was `not null`). Safe to re-run: no-ops once already fixed.
alter table works alter column tag drop not null;
-- Self-healing: tag was originally a CHECK constraint against a hardcoded list
-- (see the materials table above) — replaced with a real foreign key so a
-- material added later via Manage Materials is automatically a valid tag.
alter table works drop constraint if exists works_tag_check;
alter table works drop constraint if exists works_tag_fkey;
alter table works add constraint works_tag_fkey foreign key (tag) references materials(slug);

-- Self-healing: add secondary_series to a works table created before this column existed.
alter table works add column if not exists secondary_series text references series(slug);

-- Self-healing: add title_source/inscriptions to a works table created before these existed.
alter table works add column if not exists title_source text;
alter table works add column if not exists inscriptions text;

-- Self-healing: add collection/revisions to a works table created before these existed.
alter table works add column if not exists collection text;
alter table works add column if not exists revisions text;

-- Self-healing: auction/sale history (results, prices) -- a second
-- deliberate exception to the admin/public field-parity rule alongside
-- `flag` (see CLAUDE.md). Distinct from `provenance` (public, curated
-- ownership history): this is where a specific sale's price and estimate
-- live, and it must never reach the public entry page.
--
-- jsonb array of structured records, not free text (migrated 2026-09-14):
-- [{ house, title, date, estimate, sold }, ...], one object per recorded
-- sale so the admin intake form can present broken-out fields (Auction
-- House / Lot Title / Date / Est. Price / Sold Price) instead of one
-- freeform paragraph. Any field can be null if unknown. Defaults to '[]'.
alter table works add column if not exists auction_history jsonb default '[]'::jsonb;

-- Self-healing: add photo_credit -- unlike other optional fields, this and
-- title_source display with a studio default on the entry page rather than
-- hiding when unset (see CLAUDE.md "Default display values"), so an admin
-- only needs to fill this in for a photo actually credited to someone else.
alter table works add column if not exists photo_credit text;

-- Self-healing: add parent_slug to series -- lets a specific, granular named
-- sub-series (e.g. "Descending Figures") nest under a broader bucket series
-- (e.g. "Early Clay") for browsing purposes: the front end shows it in the
-- parent's own "Sub Series" dropdown instead of as a separate flat entry in
-- the main Series list. Purely a UI/navigation grouping -- a work's own
-- `series` field still points directly at whichever series (broad or
-- granular) actually applies to it, exactly as before; nothing about how
-- works are tagged or filtered changes because a series has a parent.
alter table series add column if not exists parent_slug text references series(slug);

-- Self-healing: add the two "Highlights" flags -- Large-Scale Work and Museum
-- Collection. These back the Browse toolbar's quick-link shortcuts (the
-- other two, Public Installations and Unlocated Works, need no new column:
-- Public Installations is just the existing series, and Unlocated Works is
-- computed from a work having no recorded provenance, same as the existing
-- "Unlocated Work" badge on the entry page). Most works are neither, and
-- leaving both false is the expected default -- these only ever surface
-- (as a small badge on the entry page, and via the quick-links) for the
-- minority of works an admin has actually checked.
alter table works add column if not exists is_large_scale boolean not null default false;
alter table works add column if not exists is_museum_collection boolean not null default false;

-- Self-healing: the other two Highlights, added once the first two were live --
-- Public Installation and Unlocated are now explicit admin flags too, rather
-- than derived (respectively) from series='public-installations' and from
-- missing provenance. Making them explicit means an admin can set a work as
-- a public installation regardless of which Series bucket it's filed under,
-- and can correct/confirm "unlocated" by hand rather than it just following
-- from a Provenance field that may simply not be filled in yet. This is a
-- deliberate one-time behavior change: any work that showed the "Unlocated
-- Work" badge automatically (because it had no provenance on record) stops
-- showing it until someone explicitly checks the box for that work.
alter table works add column if not exists is_public_installation boolean not null default false;
alter table works add column if not exists is_unlocated boolean not null default false;

-- Self-healing: per-work draft/published state, independent of series.published.
-- Saving the intake form only ever writes a draft (published defaults false);
-- a work only becomes publicly visible once explicitly published from the admin,
-- AND its series is also published. Backfill only runs the one time the column
-- is actually added — everything already in the catalogue before this feature
-- existed was already effectively live, so it must not be retroactively hidden.
-- Re-running this block after that first time is a no-op, same as the rest of
-- this file.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'works' and column_name = 'published'
  ) then
    alter table works add column published boolean not null default false;
    update works set published = true;
  end if;
end $$;

-- ═══ MEDIA (photos — a work can have several; one marked primary) ═══
create table if not exists work_photos (
  id            uuid primary key default gen_random_uuid(),
  work_id       uuid not null references works(id) on delete cascade,
  storage_path  text not null,                   -- path within the work-photos bucket
  is_primary    boolean not null default false,
  caption       text,
  sort_order    integer not null default 0,      -- user-controlled display order (drag to reorder)
  photo_type    text not null default 'work' check (photo_type in ('work','process')),
  created_at    timestamptz not null default now()
);
create index if not exists work_photos_work_id_idx on work_photos(work_id);

-- Self-healing: add photo_type to a work_photos table created before this column
-- existed. Most works will never have a 'process' photo — that's the point, it's
-- an optional category that only shows on the entry page when actually populated.
alter table work_photos add column if not exists photo_type text not null default 'work';
alter table work_photos drop constraint if exists work_photos_photo_type_check;
alter table work_photos add constraint work_photos_photo_type_check check (photo_type in ('work','process'));

-- Self-healing: add sort_order to a work_photos table created before this column existed.
alter table work_photos add column if not exists sort_order integer not null default 0;

-- ═══ VOICE ANNOTATIONS ═══
create table if not exists work_annotations (
  id                uuid primary key default gen_random_uuid(),
  work_id           uuid not null references works(id) on delete cascade,
  storage_path      text not null,                -- path within the work-audio bucket
  duration_seconds  integer,
  label             text,                         -- set after recording, from the intake form
  created_at        timestamptz not null default now()
);
-- Self-healing: label was added after annotations already existed in some projects.
alter table work_annotations add column if not exists label text;
-- Self-healing: text-based Artist's Annotations, alongside the existing voice
-- recordings -- storage_path becomes optional since a typed note has none.
alter table work_annotations alter column storage_path drop not null;
alter table work_annotations add column if not exists text_note text;
create index if not exists work_annotations_work_id_idx on work_annotations(work_id);

-- ═══ ROW LEVEL SECURITY ═══
-- Public (anon) visitors can read only works whose series is published.
-- Authenticated (the admin, once real auth is wired up) can read/write everything.
alter table series enable row level security;
alter table materials enable row level security;
alter table works enable row level security;
alter table work_photos enable row level security;
alter table work_annotations enable row level security;

drop policy if exists "series_public_read" on series;
create policy "series_public_read" on series for select
  using (true); -- everyone needs to see the full list to render "Coming Soon" options

drop policy if exists "series_admin_write" on series;
create policy "series_admin_write" on series for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "materials_public_read" on materials;
create policy "materials_public_read" on materials for select
  using (true); -- everyone needs the full list to populate filter/intake dropdowns

drop policy if exists "materials_admin_write" on materials;
create policy "materials_admin_write" on materials for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "works_public_read" on works;
create policy "works_public_read" on works for select
  using (
    auth.role() = 'authenticated'
    -- Anonymous visitors additionally require the work itself to be published —
    -- a per-work draft/publish state, independent of series.published below.
    -- A draft is invisible to the public no matter how its series is set.
    or (
      works.published = true
      and (
        exists (select 1 from series s where s.slug = works.series and s.published = true)
        -- A work with a secondary_series is visible once *either* of its two series
        -- is published — same idea as the cross-categorization rule below, but for an
        -- explicit second assignment (e.g. a jewelry piece that's also an edition)
        -- rather than an automatic material+date rule.
        or (
          works.secondary_series is not null
          and exists (select 1 from series s where s.slug = works.secondary_series and s.published = true)
        )
        -- Cross-categorization rule (see CLAUDE.md): a ceramic work dated before 2000
        -- is publicly visible once Early Clay is published, even if its own series
        -- isn't published yet — must be enforced here too, or RLS would hide the row
        -- from anon reads before the client-side filter logic ever sees it.
        or (
          works.tag = 'ceramic' and works.year < 2000
          and exists (select 1 from series s where s.slug = 'early-clay' and s.published = true)
        )
      )
    )
  );

drop policy if exists "works_admin_write" on works;
create policy "works_admin_write" on works for insert
  with check (auth.role() = 'authenticated');
drop policy if exists "works_admin_update" on works;
create policy "works_admin_update" on works for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
drop policy if exists "works_admin_delete" on works;
create policy "works_admin_delete" on works for delete
  using (auth.role() = 'authenticated');

drop policy if exists "photos_public_read" on work_photos;
create policy "photos_public_read" on work_photos for select
  using (
    exists (
      select 1 from works w join series s on s.slug = w.series
      where w.id = work_photos.work_id and (
        auth.role() = 'authenticated'
        or (
          w.published = true
          and (
            s.published = true
            or (w.secondary_series is not null and exists (select 1 from series ss where ss.slug = w.secondary_series and ss.published = true))
            or (w.tag = 'ceramic' and w.year < 2000 and exists (select 1 from series es where es.slug = 'early-clay' and es.published = true))
          )
        )
      )
    )
  );
drop policy if exists "photos_admin_write" on work_photos;
create policy "photos_admin_write" on work_photos for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "annotations_public_read" on work_annotations;
create policy "annotations_public_read" on work_annotations for select
  using (
    exists (
      select 1 from works w join series s on s.slug = w.series
      where w.id = work_annotations.work_id and (
        auth.role() = 'authenticated'
        or (
          w.published = true
          and (
            s.published = true
            or (w.secondary_series is not null and exists (select 1 from series ss where ss.slug = w.secondary_series and ss.published = true))
            or (w.tag = 'ceramic' and w.year < 2000 and exists (select 1 from series es where es.slug = 'early-clay' and es.published = true))
          )
        )
      )
    )
  );
drop policy if exists "annotations_admin_write" on work_annotations;
create policy "annotations_admin_write" on work_annotations for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ WORK SOURCES (Associate Archivist research trail) ═══
-- Every fact the Associate Archivist finds while researching a work gets
-- logged here BEFORE (and regardless of whether) it's copied into the
-- work's own fields -- so the citation trail is structured, queryable data
-- from the moment it's found, rather than living only in a chat transcript
-- that could get summarized away. Admin-only: this is working scratchpad
-- behind the scenes, not the public-facing Provenance/Exhibitions/
-- Literature text itself (that still lives on the work row, same as ever).
create table if not exists work_sources (
  id           uuid primary key default gen_random_uuid(),
  work_id      uuid not null references works(id) on delete cascade,
  url          text,
  source_type  text not null default 'other', -- auction | gallery | museum | press | publication | collector | other
  field        text,                          -- which work field this bears on, e.g. 'provenance', 'exhibitions' -- optional
  finding      text not null,                 -- the actual excerpt/claim/fact found, in the archivist's own words or quoted
  confidence   text not null default 'flagged', -- confirmed | flagged | rejected
  accessed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists work_sources_work_id_idx on work_sources(work_id);

alter table work_sources enable row level security;
drop policy if exists "work_sources_admin_only" on work_sources;
create policy "work_sources_admin_only" on work_sources for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ STAGED WORKS (Associate Archivist candidate discoveries) ═══
-- Separate from `works` on purpose: a candidate the Archivist finds while
-- scouting (an auction listing, a gallery page) that *looks* like a real,
-- previously uncatalogued MOD work does not get a real CR number or a row
-- in `works` until a human confirms it's real and imports it. This is the
-- inbox for that judgment call -- distinct from work_sources, which is for
-- enriching a work that's already safely in `works` as a draft.
create table if not exists staged_works (
  id                uuid primary key default gen_random_uuid(),
  title             text,
  date_display      text,
  year              integer,
  medium            text,
  tag               text references materials(slug),
  suggested_series  text references series(slug),
  notes             text,                            -- why the archivist thinks this is real/uncatalogued
  source_url        text,
  source_type       text not null default 'other',   -- auction | gallery | museum | press | publication | other
  confidence        text not null default 'candidate', -- candidate | likely | needs_review
  status            text not null default 'new',       -- new | reviewing | imported | rejected
  imported_work_id  uuid references works(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists staged_works_status_idx on staged_works(status);

alter table staged_works enable row level security;
drop policy if exists "staged_works_admin_only" on staged_works;
create policy "staged_works_admin_only" on staged_works for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Self-healing: the Draft Entry bar (Archivist's Drafts) shows an icon and
-- dimensions alongside title/date/medium -- neither existed on this table.
-- image_url is copied in at promotion time from the source finding
-- (research_finds.image_url) rather than joined at read time, so a
-- manually-created staged work (no source_find_id) can still carry its own.
alter table staged_works add column if not exists image_url text;
alter table staged_works add column if not exists dimensions text;

-- ═══ AGENT SETTINGS (global on/off switch for agent engagement) ═══
-- A single row. Any agent (Khalo today; Chloe/Timur once built) must check
-- engagement_enabled before doing ANY work -- research, writes, everything
-- -- and stop immediately, doing nothing, if it's false. Readable by anyone
-- (not sensitive, and an agent invoked from a Claude Code session has no
-- logged-in Supabase Auth session of its own to satisfy an admin-only
-- policy) -- only flipping it requires an authenticated admin session, via
-- the toggle in Archivist's Drafts.
create table if not exists agent_settings (
  id                  text primary key default 'global',
  engagement_enabled  boolean not null default true,
  admin_display_name  text,   -- for Khalo's greeting on the Agents page, e.g. "Good morning, Jordan"
  updated_at          timestamptz not null default now()
);
insert into agent_settings (id) values ('global') on conflict (id) do nothing;

alter table agent_settings enable row level security;
drop policy if exists "agent_settings_public_read" on agent_settings;
create policy "agent_settings_public_read" on agent_settings for select
  using (true);
drop policy if exists "agent_settings_admin_write" on agent_settings;
create policy "agent_settings_admin_write" on agent_settings for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ WORK REVISIONS (Associate Archivist proposed changes to an EXISTING
-- work, published or draft) ═══
-- Companion to staged_works: staged_works is for a work the Archivist
-- doesn't think exists in the catalogue yet ("New Entries"); this table is
-- for new information about a work that's already in `works` -- a citation,
-- an exhibition, a corrected dimension ("Revisions"). Neither table lets the
-- Archivist touch a real work field directly, no matter how confident the
-- finding: a "confirmed" work_sources finding creates a PENDING row here
-- instead of being auto-applied, and only a human approving it (via
-- modcrApproveRevision) actually writes to the work. This replaces the
-- earlier, more permissive rule where a confirmed finding was appended to
-- the work's field immediately -- every change to an existing work now
-- waits on a human decision, not just a flagged/ambiguous one.
create table if not exists work_revisions (
  id             uuid primary key default gen_random_uuid(),
  work_id        uuid not null references works(id) on delete cascade,
  field          text not null,             -- which work field this would change, e.g. 'exhibitions'
  proposed_text  text not null,             -- the exact text to append to that field
  source_id      uuid references work_sources(id), -- the citation backing this proposal, if any
  status         text not null default 'pending', -- pending | approved | rejected
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists work_revisions_status_idx on work_revisions(status);

alter table work_revisions enable row level security;
drop policy if exists "work_revisions_admin_only" on work_revisions;
create policy "work_revisions_admin_only" on work_revisions for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ IT / INFRASTRUCTURE (the manual version of what Timur -- the not-yet-
-- built IT agent -- would eventually maintain automatically) ═══
-- NEVER a place to store an actual password or API key -- see CLAUDE.md's
-- "Credentials / secrets": this whole site runs on a public anon key with
-- RLS as the only real boundary, so anything in a table here is exactly as
-- exposed as the public site is. login_url points at where to sign in
-- (Supabase dashboard, GitHub, etc.); the credential itself lives in a
-- password manager, never here.
create table if not exists it_subscriptions (
  id             uuid primary key default gen_random_uuid(),
  service_name   text not null,
  plan           text,
  monthly_cost   numeric(10,2),
  billing_cycle  text,   -- monthly | annual | free | usage-based
  login_url      text,
  status         text not null default 'active', -- active | needs-review | cancelled
  notes          text,
  created_at     timestamptz not null default now()
);

alter table it_subscriptions enable row level security;
drop policy if exists "it_subscriptions_admin_only" on it_subscriptions;
create policy "it_subscriptions_admin_only" on it_subscriptions for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

insert into it_subscriptions (service_name, login_url, notes) values
  ('Supabase', 'https://supabase.com/dashboard', 'Postgres database, Storage, and Auth for the whole site. Free-tier project -- see the GitHub Actions keep-alive cron that prevents 7-day inactivity auto-pause.'),
  ('GitHub', 'https://github.com/login', 'Repo (Lausanne98/mod-catalogue-raisonne), GitHub Pages hosting, and the Actions keep-alive cron all live here.'),
  ('Domain registrar', null, 'Whoever cr.micheleokadoner.com is registered through -- fill in once known.')
on conflict do nothing;

-- A second, tighter password gate for the IT page -- separate table (not
-- agent_settings) specifically so it is NEVER covered by agent_settings'
-- public-read policy. Admin-only in both directions: unlike engagement_
-- enabled, nothing unauthenticated ever needs to read this. Stores a
-- SHA-256 hash only, computed client-side -- the plaintext password is
-- never sent anywhere or stored anywhere, including here.
create table if not exists it_access_settings (
  id         text primary key default 'global',
  gate_hash  text,
  updated_at timestamptz not null default now()
);
insert into it_access_settings (id) values ('global') on conflict (id) do nothing;

-- Add Resend and the Anthropic API account to IT tracking (2026-09-06), and
-- record what a DNS check turned up about micheleokadoner.com's mail host
-- and an existing SPF misconfiguration, on the Domain registrar row.
-- service_name has no unique constraint, so these guard against duplicate
-- inserts by hand rather than via ON CONFLICT.
insert into it_subscriptions (service_name, plan, login_url, status, notes)
select 'Resend', null, 'https://resend.com/login', 'needs-review',
  'Domain (micheleokadoner.com) not yet verified in Resend for MOD CR -- the account is shared with the separate CE project. Not wired into any MOD CR code yet; planned for a notification email on new Call for Works submissions.'
where not exists (select 1 from it_subscriptions where service_name = 'Resend');

insert into it_subscriptions (service_name, plan, login_url, status, notes)
select 'Anthropic API (Claude)', 'Pay-as-you-go API credits', 'https://console.anthropic.com', 'active',
  'Powers the agent chat feature (Supabase Edge Function agent-chat) via the ANTHROPIC_API_KEY secret. Billing account is shared with the separate CE project -- not MOD-CR-exclusive spend.'
where not exists (select 1 from it_subscriptions where service_name = 'Anthropic API (Claude)');

insert into it_subscriptions (service_name, plan, login_url, status, notes)
select 'Voyage AI', 'Pay-as-you-go API credits', 'https://dashboard.voyageai.com', 'needs-review',
  'Generates embeddings (voyage-3, 1024 dims) for the knowledge-index Edge Function -- powers semantic search over CLAUDE.md''s classification rules and works/staged_works/source_materials, used by Khalo''s search_classification_rules and search_similar_works tools. Code is deployed but requires a VOYAGE_API_KEY secret (Project Settings -> Edge Functions -> Secrets) not yet added -- until then, every search call returns an error and Khalo''s two knowledge-index tools degrade to "no results" rather than failing the whole run. Per CLAUDE.md''s architecture principle, this is a replaceable layer: all canonical data stays in plain Postgres tables, and every embedding here is regenerable from that data at any time.'
where not exists (select 1 from it_subscriptions where service_name = 'Voyage AI');

update it_subscriptions
set notes = 'Host is Pair Networks (pair.com), not Bluehost -- MX is mail3.g1.pair.com, account appears to be under "donerstudiollc." Log in at pair.com to manage DNS.' ||
  E'\n\nOpen items (found 2026-09-06):\n' ||
  E'1. Domain currently has two conflicting SPF TXT records -- needs merging into one before adding anything else.\n' ||
  E'2. Add micheleokadoner.com as a verified domain in Resend; fold its SPF requirement into the merged record above, plus add the DKIM record Resend provides.\n' ||
  E'3. Ask the studio to create a real mailbox for cr@micheleokadoner.com at Pair, so replies to automated notifications do not bounce.'
where service_name = 'Domain registrar';

alter table it_access_settings enable row level security;
drop policy if exists "it_access_settings_admin_only" on it_access_settings;
create policy "it_access_settings_admin_only" on it_access_settings for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ PUBLIC SUBMISSIONS (Call for Works form on the public landing page) ═══
-- Anyone can INSERT (no login) -- this is a public-facing intake form, not
-- an admin tool. Nobody but an authenticated admin can ever read, update,
-- or delete a row: a public write-only form is the standard safe pattern
-- for this (no anon key can be used to browse other people's submissions).
-- Photos ARE accepted directly on the form (photo_storage_paths), unlike
-- the first draft of this table -- every upload is re-encoded through the
-- same browser-canvas convert/resize step already used on Source Materials
-- before it ever reaches Storage, which flattens embedded payloads and
-- strips EXIF; the accept type is restricted to images only. PDFs are
-- deliberately NOT accepted here -- a PDF's spec allows embedded scripts/
-- launch actions, a materially different risk profile than a flattened
-- JPEG -- the page asks anyone submitting a PDF catalog to email it
-- instead, where a human looks at it before it's opened. A reviewed
-- submission gets triaged by hand into staged_works / work_sources /
-- source_materials, same as any other Associate Archivist input.
create table if not exists public_submissions (
  id                  uuid primary key default gen_random_uuid(),
  submitted_at        timestamptz not null default now(),
  submitter_name      text,
  submitter_email     text,
  relationship        text,   -- owner | gallery | estate | institution | other
  work_title          text,
  medium              text,
  dimensions          text,
  date_estimate       text,
  provenance_notes    text,
  exhibition_notes    text,
  additional_notes    text,
  confidential_contact boolean not null default false,
  photo_storage_paths text[] not null default '{}',
  status              text not null default 'new', -- new | reviewing | imported | rejected
  created_at          timestamptz not null default now()
);
create index if not exists public_submissions_status_idx on public_submissions(status);

alter table public_submissions enable row level security;
drop policy if exists "public_submissions_anyone_insert" on public_submissions;
create policy "public_submissions_anyone_insert" on public_submissions for insert
  with check (true);
drop policy if exists "public_submissions_admin_read" on public_submissions;
create policy "public_submissions_admin_read" on public_submissions for select
  using (auth.role() = 'authenticated');
drop policy if exists "public_submissions_admin_write" on public_submissions;
create policy "public_submissions_admin_write" on public_submissions for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
drop policy if exists "public_submissions_admin_delete" on public_submissions;
create policy "public_submissions_admin_delete" on public_submissions for delete
  using (auth.role() = 'authenticated');

-- ═══ SOURCE MATERIALS (raw intake — catalog PDFs & legacy photography,
-- pending triage/mining by the Associate Archivist) ═══
-- Distinct from work_photos/work_sources: this is unreviewed raw material
-- dropped in for processing, not yet tied to a confirmed work or fact. Image
-- uploads here are web-ready derivatives (converted/resized client-side on
-- upload, e.g. TIFF/HEIC -> JPEG) -- the original large-format master, if
-- one exists, stays on the studio's local raw archive and is never uploaded
-- here; this bucket only ever holds working copies for review.
create table if not exists source_materials (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'image' check (kind in ('pdf','image','url')),
  filename         text not null,
  -- Null for kind='url' (nothing uploaded -- there's no storage object, just
  -- a live web page fetched at processing time). Always set for pdf/image.
  storage_path     text,
  -- Only set for kind='url' -- the page to fetch and read at processing
  -- time, e.g. a single auction lot, gallery, or press page pasted in
  -- directly rather than uploaded as a file.
  url              text,
  related_work_id  uuid references works(id),
  status           text not null default 'unreviewed' check (status in ('unreviewed','processing','flagged','matched','rejected')),
  notes            text,
  uploaded_at      timestamptz not null default now(),
  -- Live "Step N of M -- K findings logged so far" text, written by
  -- process-source-material on every loop iteration while status is
  -- 'processing' and cleared once it lands on a final status. Not a time
  -- estimate (there isn't a reliable one for an agentic tool loop of
  -- unknown length) -- just real, current step progress for the Researcher's
  -- Desk progress bar to reflect instead of a purely cosmetic animation.
  progress         text,
  -- Saved conversation state ({messages, totalIterations, writeCount}) when
  -- a pass gets cut off by the Edge Function platform's wall-clock ceiling
  -- (150s free / 400s paid -- a real agentic pass over a full document
  -- routinely exceeds this) before it finishes. process-source-material
  -- reads this back to resume exactly where it left off instead of starting
  -- over, self-invoking the next batch automatically. Cleared once a run
  -- reaches a final status.
  checkpoint       jsonb
);
create index if not exists source_materials_status_idx on source_materials(status);

alter table source_materials enable row level security;
drop policy if exists "source_materials_admin_only" on source_materials;
create policy "source_materials_admin_only" on source_materials for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Metadata-only index of a photographer's raw archive (e.g. a folder of
-- 500MB-4GB TIFF masters on an external drive at the studio) -- the actual
-- image bytes are never uploaded here, only filename/size/type, so the
-- archive is browsable/searchable from the admin site without moving
-- gigabytes of raw masters into Supabase. Populated by a local script
-- (scripts/archive_indexer.py) run on whatever machine has the drive
-- attached -- this table has no client-side upload path of its own.
-- When a specific file is actually needed, it's converted to JPG and
-- uploaded to source_materials separately; linked_source_material_id then
-- points at that row so the index shows what's been pulled in already.
create table if not exists archive_index (
  id                        uuid primary key default gen_random_uuid(),
  archive_label             text not null, -- e.g. "XYZ Photographer -- 2019 Shoot"
  relative_path             text not null, -- path within that archive/shoot, e.g. "raw/DSC001.tif"
  filename                  text not null,
  file_size_bytes           bigint,
  file_type                 text,
  status                    text not null default 'not_converted' check (status in ('not_converted','converted','skipped')),
  linked_source_material_id uuid references source_materials(id) on delete set null,
  notes                     text,
  indexed_at                timestamptz not null default now(),
  unique (archive_label, relative_path)
);
create index if not exists archive_index_label_idx on archive_index(archive_label);
create index if not exists archive_index_status_idx on archive_index(status);

alter table archive_index enable row level security;
drop policy if exists "archive_index_admin_only" on archive_index;
create policy "archive_index_admin_only" on archive_index for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ SERIES CAROUSEL PHOTOS ("Image Gallery" in the browse page's Overview
-- panel) — previously a hardcoded JS object with base64 images embedded
-- directly in the browse page; now a real per-series photo set, editable
-- from Manage Series instead of a code change. ═══
create table if not exists series_photos (
  id           uuid primary key default gen_random_uuid(),
  series       text not null references series(slug),
  storage_path text not null,
  caption      text,
  photo_type   text not null default 'work' check (photo_type in ('work','process','context','press')),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists series_photos_series_idx on series_photos(series);

alter table series_photos enable row level security;
drop policy if exists "series_photos_public_read" on series_photos;
create policy "series_photos_public_read" on series_photos for select
  using (
    auth.role() = 'authenticated'
    or exists (select 1 from series s where s.slug = series_photos.series and s.published = true)
  );
drop policy if exists "series_photos_admin_write" on series_photos;
create policy "series_photos_admin_write" on series_photos for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ CHRONOLOGY — previously hand-written static HTML on the chronology
-- page (every event, every decade, hardcoded), now database-backed and
-- editable from a Manage Chronology admin page. Grouped by decade (with an
-- optional curatorial subtitle per decade, e.g. "Origins & Formation") and,
-- within a decade, by individual dated events — a flexible date label
-- ("October 27, 1923", "Fall 1968", just "1975") rather than a fixed
-- calendar date, since chronology sources are often exactly that loose. ═══
create table if not exists chronology_decades (
  decade    integer primary key,   -- e.g. 1940 for the 1940s
  subtitle  text                   -- e.g. "Origins & Formation"; optional
);

create table if not exists chronology_events (
  id                  uuid primary key default gen_random_uuid(),
  year                integer not null,
  date_label          text not null,   -- e.g. "October 27, 1923", "Fall 1968", "1975"
  description         text not null,
  photo_storage_path  text,
  photo_caption       text,
  photo_credit        text,            -- e.g. "Photo: Jordan Doner" — kept separate from
                                        -- the caption since it's a distinct citation line
  sort_order          integer not null default 0,
  published           boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists chronology_events_year_idx on chronology_events(year);

alter table chronology_decades enable row level security;
drop policy if exists "chronology_decades_public_read" on chronology_decades;
create policy "chronology_decades_public_read" on chronology_decades for select
  using (true); -- just curatorial subtitles, no sensitivity in showing them pre-launch
drop policy if exists "chronology_decades_admin_write" on chronology_decades;
create policy "chronology_decades_admin_write" on chronology_decades for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table chronology_events enable row level security;
drop policy if exists "chronology_events_public_read" on chronology_events;
create policy "chronology_events_public_read" on chronology_events for select
  using (auth.role() = 'authenticated' or published = true);
drop policy if exists "chronology_events_admin_write" on chronology_events;
create policy "chronology_events_admin_write" on chronology_events for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ ADMIN PAGE BACKGROUNDS — self-serve upload, one image per admin page.
-- Replaces hardcoding a single shared wallpaper image into each page's CSS
-- (which required a chat-based file hand-off from the studio to a Claude
-- session every time it needed to change, and was the source of at least one
-- low-resolution/cropped result when that hand-off silently degraded the
-- file). Each admin page now reads its own row by page_slug and lets the
-- signed-in admin upload/replace it directly from a small on-page control —
-- no code change, no versioned-file edit, no hand-off needed to update a
-- background again. ═══
create table if not exists admin_backgrounds (
  page_slug    text primary key,
  storage_path text not null,
  updated_at   timestamptz not null default now()
);

alter table admin_backgrounds enable row level security;
drop policy if exists "admin_backgrounds_public_read" on admin_backgrounds;
create policy "admin_backgrounds_public_read" on admin_backgrounds for select
  using (true); -- decorative site chrome only, no sensitivity in showing it
drop policy if exists "admin_backgrounds_admin_write" on admin_backgrounds;
create policy "admin_backgrounds_admin_write" on admin_backgrounds for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ STORAGE BUCKETS ═══
insert into storage.buckets (id, name, public)
values ('work-photos', 'work-photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('work-audio', 'work-audio', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('series-photos', 'series-photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('chronology-photos', 'chronology-photos', true)
on conflict (id) do nothing;

-- Private, unlike the buckets above: raw catalog PDFs and legacy photography
-- are very likely copyrighted (published exhibition catalogs, monographs) --
-- fine to hold for internal research/mining, never meant to be world-readable
-- the way a published work's own photos are. Admin-only read AND write.
insert into storage.buckets (id, name, public)
values ('source-materials', 'source-materials', false)
on conflict (id) do nothing;

-- Private too: photos attached to a Call for Works submission haven't been
-- reviewed yet, and may include images of works that turn out not to be
-- genuine, unrelated, or something a submitter didn't intend to share
-- publicly. Admin-only read, same as source-materials; anon may only INSERT.
insert into storage.buckets (id, name, public)
values ('public-submissions', 'public-submissions', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('admin-backgrounds', 'admin-backgrounds', true)
on conflict (id) do nothing;

drop policy if exists "work_photos_public_read" on storage.objects;
create policy "work_photos_public_read" on storage.objects for select
  using (bucket_id = 'work-photos');
drop policy if exists "work_photos_admin_write" on storage.objects;
create policy "work_photos_admin_write" on storage.objects for insert
  with check (bucket_id = 'work-photos' and auth.role() = 'authenticated');
drop policy if exists "work_photos_admin_update" on storage.objects;
create policy "work_photos_admin_update" on storage.objects for update
  using (bucket_id = 'work-photos' and auth.role() = 'authenticated');
drop policy if exists "work_photos_admin_delete" on storage.objects;
create policy "work_photos_admin_delete" on storage.objects for delete
  using (bucket_id = 'work-photos' and auth.role() = 'authenticated');

drop policy if exists "work_audio_public_read" on storage.objects;
create policy "work_audio_public_read" on storage.objects for select
  using (bucket_id = 'work-audio');
drop policy if exists "work_audio_admin_write" on storage.objects;
create policy "work_audio_admin_write" on storage.objects for insert
  with check (bucket_id = 'work-audio' and auth.role() = 'authenticated');
drop policy if exists "work_audio_admin_update" on storage.objects;
create policy "work_audio_admin_update" on storage.objects for update
  using (bucket_id = 'work-audio' and auth.role() = 'authenticated');
drop policy if exists "work_audio_admin_delete" on storage.objects;
create policy "work_audio_admin_delete" on storage.objects for delete
  using (bucket_id = 'work-audio' and auth.role() = 'authenticated');

drop policy if exists "series_photos_bucket_public_read" on storage.objects;
create policy "series_photos_bucket_public_read" on storage.objects for select
  using (bucket_id = 'series-photos');
drop policy if exists "series_photos_bucket_admin_write" on storage.objects;
create policy "series_photos_bucket_admin_write" on storage.objects for insert
  with check (bucket_id = 'series-photos' and auth.role() = 'authenticated');
drop policy if exists "series_photos_bucket_admin_update" on storage.objects;
create policy "series_photos_bucket_admin_update" on storage.objects for update
  using (bucket_id = 'series-photos' and auth.role() = 'authenticated');
drop policy if exists "series_photos_bucket_admin_delete" on storage.objects;
create policy "series_photos_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'series-photos' and auth.role() = 'authenticated');

drop policy if exists "chronology_photos_bucket_public_read" on storage.objects;
create policy "chronology_photos_bucket_public_read" on storage.objects for select
  using (bucket_id = 'chronology-photos');
drop policy if exists "chronology_photos_bucket_admin_write" on storage.objects;
create policy "chronology_photos_bucket_admin_write" on storage.objects for insert
  with check (bucket_id = 'chronology-photos' and auth.role() = 'authenticated');
drop policy if exists "chronology_photos_bucket_admin_update" on storage.objects;
create policy "chronology_photos_bucket_admin_update" on storage.objects for update
  using (bucket_id = 'chronology-photos' and auth.role() = 'authenticated');
drop policy if exists "chronology_photos_bucket_admin_delete" on storage.objects;
create policy "chronology_photos_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'chronology-photos' and auth.role() = 'authenticated');

drop policy if exists "source_materials_bucket_admin_read" on storage.objects;
create policy "source_materials_bucket_admin_read" on storage.objects for select
  using (bucket_id = 'source-materials' and auth.role() = 'authenticated');
drop policy if exists "source_materials_bucket_admin_write" on storage.objects;
create policy "source_materials_bucket_admin_write" on storage.objects for insert
  with check (bucket_id = 'source-materials' and auth.role() = 'authenticated');
drop policy if exists "source_materials_bucket_admin_update" on storage.objects;
create policy "source_materials_bucket_admin_update" on storage.objects for update
  using (bucket_id = 'source-materials' and auth.role() = 'authenticated');
drop policy if exists "source_materials_bucket_admin_delete" on storage.objects;
create policy "source_materials_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'source-materials' and auth.role() = 'authenticated');

drop policy if exists "public_submissions_bucket_anyone_insert" on storage.objects;
create policy "public_submissions_bucket_anyone_insert" on storage.objects for insert
  with check (bucket_id = 'public-submissions');
drop policy if exists "public_submissions_bucket_admin_read" on storage.objects;
create policy "public_submissions_bucket_admin_read" on storage.objects for select
  using (bucket_id = 'public-submissions' and auth.role() = 'authenticated');
drop policy if exists "public_submissions_bucket_admin_delete" on storage.objects;
create policy "public_submissions_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'public-submissions' and auth.role() = 'authenticated');

drop policy if exists "admin_backgrounds_bucket_public_read" on storage.objects;
create policy "admin_backgrounds_bucket_public_read" on storage.objects for select
  using (bucket_id = 'admin-backgrounds');
drop policy if exists "admin_backgrounds_bucket_admin_write" on storage.objects;
create policy "admin_backgrounds_bucket_admin_write" on storage.objects for insert
  with check (bucket_id = 'admin-backgrounds' and auth.role() = 'authenticated');
drop policy if exists "admin_backgrounds_bucket_admin_update" on storage.objects;
create policy "admin_backgrounds_bucket_admin_update" on storage.objects for update
  using (bucket_id = 'admin-backgrounds' and auth.role() = 'authenticated');
drop policy if exists "admin_backgrounds_bucket_admin_delete" on storage.objects;
create policy "admin_backgrounds_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'admin-backgrounds' and auth.role() = 'authenticated');

-- ═══ WORK CITATIONS — a growing index of every work mention Khalo or Chloe
-- encounters during any research pass, whether or not that work has its own
-- staged/live record yet. Solves "a PDF mentions 40 works in passing while
-- researching one of them -- log all 40, so when any of them gets its own
-- entry later (manually or via a draft), the citation is already there to
-- pull in" rather than being silently dropped because it wasn't the specific
-- work being staged in that pass. ═══
create table if not exists work_citations (
  id               uuid primary key default gen_random_uuid(),
  title_raw        text not null,            -- exactly as it appeared in the source
  normalized_title text not null,            -- lowercased/trimmed, for matching against a new entry's title
  citation_kind    text not null check (citation_kind in ('publication','exhibition','provenance','auction','other')),
  citation_text    text not null,            -- the actual citation content (a provenance line, an exhibition line, a lit. reference...)
  source_url       text,
  source_material_id uuid references source_materials(id) on delete set null,
  work_id          uuid references works(id) on delete set null,        -- set once this title is matched to a live work
  staged_work_id   uuid references staged_works(id) on delete set null, -- set once this title is matched to a draft
  created_at       timestamptz not null default now()
);
create index if not exists work_citations_normalized_title_idx on work_citations(normalized_title);
create index if not exists work_citations_work_id_idx on work_citations(work_id);
create index if not exists work_citations_staged_work_id_idx on work_citations(staged_work_id);

alter table work_citations enable row level security;
drop policy if exists "work_citations_admin_only" on work_citations;
create policy "work_citations_admin_only" on work_citations for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- pg_trgm powers a fuzzy ILIKE/similarity match from a new entry's title
-- against normalized_title -- titles are rarely quoted identically across
-- sources (see CLAUDE.md's title-parsing rule), so exact match alone would
-- miss most real matches.
create extension if not exists pg_trgm;
create index if not exists work_citations_normalized_title_trgm_idx on work_citations using gin (normalized_title gin_trgm_ops);

-- Fuzzy title match against the citation index, called from Intake when a
-- new entry begins (manual or from a draft) to auto-prime Provenance/
-- Exhibitions/Literature, and from process-source-material's log_citation
-- tool to check whether an incoming citation already matches a live work or
-- staged draft. similarity() comes from pg_trgm; 0.35 is a deliberately
-- permissive floor since real-world title variance is high (quoted-name
-- extraction, punctuation, articles) -- callers still show/apply results as
-- suggestions, not silent auto-writes, so a loose floor costs a human a
-- glance, not a wrong publish.
create or replace function match_work_citations(p_title text, p_limit int default 20)
returns table (
  id uuid,
  title_raw text,
  citation_kind text,
  citation_text text,
  source_url text,
  work_id uuid,
  staged_work_id uuid,
  similarity real
)
language sql
stable
as $$
  select
    wc.id, wc.title_raw, wc.citation_kind, wc.citation_text, wc.source_url,
    wc.work_id, wc.staged_work_id,
    similarity(wc.normalized_title, lower(trim(p_title))) as similarity
  from work_citations wc
  where wc.normalized_title % lower(trim(p_title))
  order by similarity desc
  limit p_limit;
$$;

-- ═══ STAGED WORK PHOTO CANDIDATES — the "maybe" bullpen. A photo Khalo
-- found plausibly related to a draft but not confidently enough to set as
-- its actual image_url outright (no explicit caption, ambiguous among
-- several images on the same page, etc.) lands here instead of being
-- silently discarded -- a human reviewing the draft can promote one to the
-- real photo. High-confidence photos (an explicit caption naming the work,
-- or a table-of-contents/List of Works page number match) still go straight
-- to image_url as before -- this is only for the gray area in between. ═══
alter table staged_works add column if not exists candidate_photos jsonb not null default '[]'::jsonb;

-- A title is a sourced claim (see the associate-archivist skill's Title
-- rule) -- staged_works had no column to carry that source forward to
-- import, even though works.title_source has existed all along.
alter table staged_works add column if not exists title_source text;

insert into storage.buckets (id, name, public)
values ('staged-work-photos', 'staged-work-photos', true)
on conflict (id) do nothing;

drop policy if exists "staged_work_photos_bucket_public_read" on storage.objects;
create policy "staged_work_photos_bucket_public_read" on storage.objects for select
  using (bucket_id = 'staged-work-photos');
drop policy if exists "staged_work_photos_bucket_admin_write" on storage.objects;
create policy "staged_work_photos_bucket_admin_write" on storage.objects for insert
  with check (bucket_id = 'staged-work-photos' and auth.role() = 'authenticated');
drop policy if exists "staged_work_photos_bucket_admin_update" on storage.objects;
create policy "staged_work_photos_bucket_admin_update" on storage.objects for update
  using (bucket_id = 'staged-work-photos' and auth.role() = 'authenticated');
drop policy if exists "staged_work_photos_bucket_admin_delete" on storage.objects;
create policy "staged_work_photos_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'staged-work-photos' and auth.role() = 'authenticated');

-- ═══ MIGRATE EXISTING 28 WORKS ═══
-- Images point at the already-hosted GitHub Pages files for now (legacy_image_url)
-- rather than re-uploading into Storage in this pass — new intake uploads going
-- forward use work_photos + the work-photos bucket properly.
insert into works (cr_number, title, date_display, year, medium, tag, series, legacy_image_url, flag) values
  (1, 'Tattooed Torso', '1966', 1966, 'Ceramic', 'ceramic', 'tattooed', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/TattooedTorso1966-icon.png', null),
  (13, 'Ceramic Seeds', 'c. 1971', 1971, 'Glazed ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/TwoCeramicSeeds-icon-1.png', null),
  (2, 'Germinating Seeds', 'c. 1972', 1972, 'Bronze', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/GerminatingSeeds-icon-223x200.png', null),
  (18, 'Tattooed Relic', 'c. 1974', 1974, 'Ceramic', 'ceramic', 'tattooed', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Tatoed_Relic.jpg', null),
  (14, 'Death Masks', 'c. 1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/DeathMasks-Icon.png', null),
  (15, 'Descending Torsos', '1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/DescendingTorsos1975-icon.png', null),
  (16, 'Wings II', '1975', 1975, 'Raku ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/WaveFigures-Icon.png', null),
  (20, 'Seeds & Pods', 'c. 1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/SeadPods-icon.png', null),
  (17, 'Triads', 'c. 1976', 1976, 'Raku ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Tortoises-icon.png', null),
  (21, 'Tattooed Dolls', 'c. 1975', 1975, 'Ceramic', 'ceramic', 'tattooed', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Totems-icon.png', null),
  (19, 'Figures with Staffs', 'c. 1978', 1978, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Figures-Icon.png', null),
  (3, 'Burning Branches', '1975', 1975, 'Bronze', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/BurningBranches-Icon.png', null),
  (4, 'Soul Catchers', '1977', 1977, 'Bronze', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/SoulCatchers_Clay-Icon.png', null),
  (5, 'Pictographs', 'c. 1979', 1979, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Pictograph_icon.png', null),
  (7, 'Celestial Plaza', '1986', 1986, 'Bronze — permanent public install.', 'bronze', 'public-installations', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/AMNH_installation-icon.png', null),
  (9, 'Radiant Disk', '1988', 1988, 'Bronze with patina', 'bronze', 'radiant', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/RadiantDiskIceRing.png', null),
  (6, 'A Walk on the Beach', '1995', 1995, 'Bronze — permanent public install.', 'bronze', 'public-installations', null, 'icon mismatch — sourced image did not depict this work, removed pending correct image'),
  (10, 'Blueprint of Eden', '1999', 1999, 'Cyanotype, natural specimens', 'paper', 'works-on-paper', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/BluePrintOfEden-IconV3-1-213x223.png', null),
  (11, 'Thorn Man', 'c. 2000', 2000, 'Bronze with silver', 'bronze', 'thorn-men', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Thornmen3_studio-photos_Dirk-Bakker-R_iconV2-177x223.png', null),
  (8, 'Into the Mysterium', '2003', 2003, 'Mixed media installation', null, 'public-installations', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Mysterium-Icon.png', 'Medium classification undecided — mixed media installation, no clean single Medium value in the taxonomy (see CLAUDE.md known open item)'),
  (12, 'Talisman', '2019', 2019, 'Bronze — permanent public install.', 'bronze', 'talisman-series', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Talisman_Icon-142x223.png', null),
  (22, 'Frond Necklace', 'Date pending', null, 'Silver', 'silver', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/FrondNecklace.jpg', null),
  (23, 'Totem Necklace', 'Date pending', null, 'Silver', 'silver', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/TotemNecklace.jpg', null),
  (24, 'Amulet Necklace', 'Date pending', null, 'Silver', 'silver', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/AmuletNecklace-Icon.png', null),
  (25, 'Palm Necklace', 'Date pending', null, 'Gold', 'gold', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/PalmNecklaceGold.jpg', null),
  (26, 'Seed Ring', 'Date pending', null, 'Gold', 'gold', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/SeedRing.jpg', null),
  (27, 'Ceremonial Silver', 'Date pending', null, 'Silver', 'silver', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/CeremonialSilver-Icon.png', null),
  (28, 'Palm Vase', '1999', 1999, 'Sterling silver', 'silver', 'jewelry', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/PalmVase1999-Icon.png', null)
on conflict (cr_number) do nothing;

-- ═══ MIGRATE ADDITIONAL CERAMIC WORKS FROM LEGACY SITE ═══
-- Pulled from micheleokadoner.com/clay/, cross-checked against the 28 works above to
-- exclude duplicates, and against exhibition/documentation entries per CLAUDE.md's
-- legacy-media rules. Each candidate's image was independently viewed to verify it
-- plausibly depicts the claimed ceramic work before inclusion (one exhibition entry
-- and one bronze-mislabeled entry, "Bouverie Audubon," were excluded on this basis).
-- Several entries carry a flag for further curatorial review (bundled group works,
-- name similarity to an existing entry, or no verifiable image/medium confirmation).
-- Numbered 100+, not continuing from 28: see "Provisional CR numbering" in CLAUDE.md
-- — these aren't yet placed in true chronological order among works still to be added
-- (e.g. student works), so their numbers are provisional until final renumbering.
-- WITHIN the 100+ block, numbers are still assigned in strict year-ascending order
-- (100 = earliest), per CLAUDE.md — undated works (Prophecy) go last since they can't
-- be placed. Post-2000 pieces (Caio, the Telchine group, Fe, One Fluid Stroke) are
-- ceramic but not series=early-clay — Early Clay represents the artist's early-period
-- ceramic work specifically, not "ceramic at any date" (see CLAUDE.md).
insert into works (cr_number, title, date_display, year, medium, tag, series, legacy_image_url, flag) values
  (100, 'Fossil & Volcanic Bowl', '1964', 1964, 'Clay (two bowls: "Fossil Bowl" and "Volcanic Bowl")', 'ceramic', 'early-clay', null, 'No image found; may represent two separate bowls bundled as one legacy entry — needs curatorial review.'),
  (101, 'Early Torsos', 'c. 1967', 1967, null, 'ceramic', 'early-clay', null, 'Bundles several named sub-works (Wave Figures, Coiled Figure, Early Figures, Open Mouth); no image found; likely overlaps with Wave Torsos/Tribe — needs curatorial review.'),
  (102, 'Tattooed Torsos', '1968', 1968, 'Clay ("Six Totems")', 'ceramic', 'tattooed', 'https://micheleokadoner.com/wp-content/uploads/2018/01/Tatooed-Toros-68.jpg', 'Name closely echoes MOD CR 1 "Tattooed Torso" (1966) — appears distinct per date/description (a group of six totems vs. a single 1966 piece) but flagged for curatorial confirmation it isn''t a duplicate.'),
  (103, 'Wave Torsos', 'c. 1969', 1969, 'Clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2022/03/WaveTorsos.jpg', null),
  (104, 'Burial Pieces', 'c. 1974–1975', 1975, 'Raku, high-fired porcelain, smoked stoneware (group work)', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2017/12/Burial-Pieces-Master-2.jpg', 'Group photo names ~8 sub-pieces; some (Triad, Descending Torso, Wings II) overlap existing MOD CR 15/16/17 — needs curatorial review on whether to split into individual works.'),
  (105, 'Labyrinth', '1977', 1977, 'Handmade basalt clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/06/Labyrinth1977-icon_lighter-copy_no-bg_REFINED_COLOR-155x146.jpg', null),
  (106, 'Scapula', '1977', 1977, 'Raku', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2017/12/Scalpula_PorcelainSculptureMODoner-f-2.jpg', null),
  (107, 'Tribe', 'c. 1982', 1982, 'Clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/01/TribeDB.jpg', null),
  (108, 'Terrible Table', 'c. 1984', 1984, 'Bronze, glass', 'bronze', 'terrible-chairs', 'https://micheleokadoner.com/wp-content/uploads/2017/12/22Terrible-Table22_MODoner_LR-copy.jpg', null),
  (109, 'Terrible Chair 4', 'c. 1984', 1984, 'Bronze with gold leaf', 'bronze', 'terrible-chairs', 'https://micheleokadoner.com/wp-content/uploads/2017/12/1.-Large-Gold-Terrible-Chair.jpg', null),
  (110, 'Disarming Images', '1985', 1985, 'Clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/09/DisarmingImages-Icon.png', null),
  (111, 'Radiant Site', '1990', 1990, 'Gold-luster Pewabic ceramic tile (MTA installation)', 'ceramic', 'radiant', null, 'Image URL from legacy site was truncated/unconfirmed during research — needs sourcing before display.'),
  (112, 'Terrible Chairs', '1990', 1990, 'Bronze', 'bronze', 'terrible-chairs', 'https://micheleokadoner.com/wp-content/uploads/2017/12/ThorneChair.jpg', null),
  (113, 'Caio', '2008', 2008, 'Iron-glazed porcelain', 'ceramic', 'bronze-works', 'https://micheleokadoner.com/wp-content/uploads/2018/09/Caio-Consumed-by-Fire-2ViewsMOD.jpg', null),
  (114, 'Telchine, Gaia, Rhea & Ur', 'c. 2009–2010', 2010, 'Earthenware (Nymphenburg Porcelain Manufactory)', 'ceramic', 'bronze-works', 'https://micheleokadoner.com/wp-content/uploads/2018/02/Telchine.jpg', 'Legacy page bundles four named pieces (Telchine, Gaia, Rhea, Ur) under one photo/entry — may need splitting into separate catalogue works.'),
  (115, 'Fe', '2010', 2010, null, 'ceramic', 'bronze-works', null, 'No image or explicit medium confirmation found on the legacy site — classified ceramic per curatorial direction; needs source verification.'),
  (116, 'One Fluid Stroke', '2014', 2014, 'Ceramic ("Fifty Plates" — 50 unique numbered plates)', 'ceramic', 'editions', null, 'No photo found on the legacy site to verify — medium confirmed as ceramic via page text only.'),
  (117, 'Apis 1-9 and Queen', '2014', 2014, 'Cast bronze', 'bronze', 'pollinators', 'https://micheleokadoner.com/wp-content/uploads/2017/12/Polinators-f.jpg', 'From the series "The Rise of Plants."'),
  (118, 'Hominim Relics', '2015', 2015, 'Wax, wood', 'organic-material', 'hominim-relics', 'https://micheleokadoner.com/wp-content/uploads/2017/12/063797_015.jpg', null),
  (119, 'Prophecy', 'Date pending', null, 'Bronze', 'bronze', 'public-installations', 'https://micheleokadoner.com/wp-content/uploads/2021/07/Prophesy_Icon_bw.png', null)
on conflict (cr_number) do nothing;

-- Frond Necklace is also part of a limited-edition run, in addition to being jewelry.
update works set secondary_series = 'editions' where cr_number = 22;

-- Terrible Table (MOD CR 108) is held in a museum collection.
update works set provenance = 'Collection of The Art Institute of Chicago.' where cr_number = 108;

-- Prophecy (MOD CR 119) has a verified process photo — "Patina at Talix," the artist
-- applying patina at the Talix foundry — self-hosted (uploaded to the work-photos
-- bucket) rather than linked to the legacy site, matching how new intake works.
-- No natural unique key on work_photos to use "on conflict", so guard with NOT EXISTS
-- instead to keep this safe to re-run.
insert into work_photos (work_id, storage_path, photo_type, caption)
select w.id, w.id || '/patina-at-talix.jpg', 'process', 'Patina at Talix'
from works w
where w.cr_number = 119
and not exists (
  select 1 from work_photos wp where wp.work_id = w.id and wp.storage_path = w.id || '/patina-at-talix.jpg'
);

-- ═══ CHLOE'S OUTBOUND MONITORING — a master site list she checks, and a
-- "New Finds" bullpen for what turns up, doubling as the "CR Archive" once
-- reviewed (status distinguishes the two: pending = bullpen, approved/
-- rejected = archive, trashed = gone). See AGENT_ARCHITECTURE.md's Chloe
-- section for the full spec this implements. ═══
create table if not exists research_sites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  url         text not null unique,
  category    text not null check (category in ('gallery','auction-house','museum','press','publication','media','social-media','book')),
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists research_sites_category_idx on research_sites(category);

-- Public SELECT (this is just a list of website names/URLs, nothing
-- sensitive) is what lets Chloe's skill read the site list using only the
-- public anon key -- no interactive admin login required to run a research
-- pass, in this cloud sandbox or any local session. Managing the list
-- itself (add/edit/remove a site) stays admin-only.
alter table research_sites enable row level security;
drop policy if exists "research_sites_anyone_read" on research_sites;
create policy "research_sites_anyone_read" on research_sites for select
  using (true);
drop policy if exists "research_sites_admin_write" on research_sites;
create policy "research_sites_admin_write" on research_sites for insert
  with check (auth.role() = 'authenticated');
drop policy if exists "research_sites_admin_update" on research_sites;
create policy "research_sites_admin_update" on research_sites for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
drop policy if exists "research_sites_admin_delete" on research_sites;
create policy "research_sites_admin_delete" on research_sites for delete
  using (auth.role() = 'authenticated');

create table if not exists research_finds (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid references research_sites(id) on delete set null,
  category         text not null check (category in ('gallery','auction-house','museum','press','publication','media','social-media','book')),
  title            text not null,
  finding_text     text not null,
  url              text,
  matched_work_id  uuid references works(id) on delete set null,
  status           text not null default 'pending' check (status in ('pending','approved','rejected','trashed')),
  discovered_at    timestamptz not null default now(),
  notes            text
);
create index if not exists research_finds_status_idx on research_finds(status);
create index if not exists research_finds_category_idx on research_finds(category);

-- Same pattern as public_submissions: anyone (including this skill running
-- with only the public anon key, no admin login) may INSERT a new pending
-- finding, but reviewing/approving/rejecting/trashing it -- and reading the
-- bullpen at all -- is admin-only. A pending row can't do any harm sitting
-- unreviewed; that asymmetry is what lets Chloe run unattended.
alter table research_finds enable row level security;
drop policy if exists "research_finds_anyone_insert" on research_finds;
create policy "research_finds_anyone_insert" on research_finds for insert
  with check (true);
drop policy if exists "research_finds_admin_read" on research_finds;
create policy "research_finds_admin_read" on research_finds for select
  using (auth.role() = 'authenticated');
drop policy if exists "research_finds_admin_update" on research_finds;
create policy "research_finds_admin_update" on research_finds for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
drop policy if exists "research_finds_admin_delete" on research_finds;
create policy "research_finds_admin_delete" on research_finds for delete
  using (auth.role() = 'authenticated');

-- Defensive/documentation only -- anon and authenticated already had these
-- privileges by default (confirmed via information_schema.role_table_grants
-- while chasing a 42501 error during the first real insert). The actual
-- cause of that error was unrelated to grants: see the "Prefer:
-- return=representation" note in .claude/skills/researcher/SKILL.md.
grant select on research_sites to anon, authenticated;
grant insert, update, delete on research_sites to authenticated;
grant insert on research_finds to anon, authenticated;
grant select, update, delete on research_finds to authenticated;

-- Approving a Chloe finding with no matched_work_id auto-creates a
-- bare-bones staged_works draft (client-side, on Researcher's Desk) rather
-- than leaving an approved finding with nowhere to go -- these two columns
-- are the traceability link between a finding and the draft it produced.
-- When matched_work_id is set instead, no draft is created since the work
-- already exists -- see AGENT_ARCHITECTURE.md.
alter table staged_works add column if not exists source_find_id uuid references research_finds(id) on delete set null;
alter table research_finds add column if not exists staged_work_id uuid references staged_works(id) on delete set null;

-- The OTHER traceability link, for the other intake path: a document
-- processed via process-source-material (Khalo's automated pass, see that
-- Edge Function) can stage brand-new candidate works directly, with no
-- research_finds row involved at all -- previously there was no way to see
-- "what did this document actually produce?" from Researcher's Desk short
-- of reading the row's own prose summary. One source material can produce
-- many staged works (a whole catalog PDF stages dozens), so unlike
-- source_find_id/staged_work_id above this is one-directional: the child
-- (staged_works) holds the FK, there's no scalar column back on
-- source_materials for it to point to.
alter table staged_works add column if not exists source_material_id uuid references source_materials(id) on delete set null;
create index if not exists staged_works_source_material_id_idx on staged_works(source_material_id);

-- Small reference thumbnail for the New Finds card, admin-only display --
-- NOT the same guarantee as a work's public `img` field. Chloe may set this
-- to a hotlinked (not downloaded/rehosted) source-page image URL when she's
-- confident it depicts the specific item the finding describes; left null
-- for anything not about one specific object (press mentions, publications,
-- social posts), where the UI shows a category-coded square instead. If the
-- finding is later promoted into a real work, that work's own `img` still
-- needs the full verification CLAUDE.md already requires -- this column
-- never substitutes for that.
alter table research_finds add column if not exists image_url text;

-- Structured (not prose) date/medium, set only when Chloe is confident of
-- them specifically -- separate from finding_text's free-text narrative so
-- the auto-promotion rule below (image + at least 2 of name/date/medium/
-- site) can check them deterministically instead of parsing a sentence.
alter table research_finds add column if not exists date_display text;
alter table research_finds add column if not exists medium text;

-- Same reasoning as date_display/medium above -- a structured slot for a
-- dimension string Chloe is confident of (e.g. "14 x 22 x 9 in."), so it
-- doesn't end up buried only in finding_text and lost when a finding is
-- promoted into a staged_works draft.
alter table research_finds add column if not exists dimensions text;

-- A gallery/auction-house finding this well-documented (a trustworthy
-- photo plus real specifics, not just a title) skips the manual Approve
-- step and goes straight to a staged_works draft -- see
-- catalogue_admin_researcher's qualifiesForAutoPromotion(). Everything
-- else (thinner findings, and every non-gallery/auction-house category)
-- still needs a human Approve click, same as before. Auto-promoted rows
-- are marked status:'approved' with a note explaining it was automatic,
-- for the same audit-trail reason nothing in this project is ever silent
-- about what a human decided vs. what a rule decided.

-- Starter site list, compiled 2026-09-12 via live web search (auction
-- houses/aggregators) plus the studio's own named museums/galleries.
-- Safe to re-run -- unique(url) makes this idempotent.
insert into research_sites (name, url, category) values
  ('Christie''s', 'https://www.christies.com', 'auction-house'),
  ('Sotheby''s', 'https://www.sothebys.com', 'auction-house'),
  ('Phillips', 'https://www.phillips.com', 'auction-house'),
  ('Bonhams', 'https://www.bonhams.com', 'auction-house'),
  ('Rago Arts and Auction Center', 'https://www.ragoarts.com', 'auction-house'),
  ('Wright', 'https://www.wright20.com', 'auction-house'),
  ('DOYLE Auctioneers & Appraisers', 'https://www.doyle.com', 'auction-house'),
  ('Toomey & Co. Auctioneers', 'https://www.toomeyco.com', 'auction-house'),
  ('Freeman''s | Hindman', 'https://www.freemanshindman.com', 'auction-house'),
  ('LiveAuctioneers', 'https://www.liveauctioneers.com', 'auction-house'),
  ('Invaluable', 'https://www.invaluable.com', 'auction-house'),
  ('MutualArt', 'https://www.mutualart.com', 'auction-house'),
  ('LotSearch', 'https://www.lotsearch.net', 'auction-house'),
  ('Artnet', 'https://www.artnet.com', 'auction-house'),
  ('Artsy', 'https://www.artsy.net', 'gallery'),
  ('1stDibs', 'https://www.1stdibs.com', 'gallery'),
  ('David Gill Gallery', 'https://www.davidgillgallery.com', 'gallery'),
  ('Marlborough Gallery', 'https://www.marlboroughgallery.com', 'gallery'),
  ('The Metropolitan Museum of Art', 'https://www.metmuseum.org', 'museum'),
  ('MoMA', 'https://www.moma.org', 'museum'),
  ('The Bunker (Palm Beach)', 'https://thebunkerartspace.com', 'museum'),
  ('Pérez Art Museum Miami (PAMM)', 'https://www.pamm.org', 'museum')
on conflict (url) do nothing;

-- Added 2026-09-19: press coverage plus a deliberate modern addition,
-- social media (see the researcher skill's own note on this -- most
-- catalogues raisonnés don't cover it, the studio wants it here). The two
-- social-media rows are her accounts as identified via live web search, not
-- a manually confirmed link -- see the notes column and the researcher
-- skill's confidence guidance for social posts.
insert into research_sites (name, url, category, notes) values
  ('Brooklyn Rail', 'https://brooklynrail.org', 'press', null),
  ('The New Criterion', 'https://newcriterion.com', 'press', null),
  ('Instagram (Michele Oka Doner)', 'https://www.instagram.com/micheleokadoner/', 'social-media',
    'Verified via web search as her account, not a manually confirmed link. Treat a specific work claim from a post with the same confidence bar as everything else -- her own account posting a piece is strong, someone else tagging/mentioning her is a candidate at best.'),
  ('X / Twitter (Michele Oka Doner)', 'https://x.com/okadoner', 'social-media',
    'Verified via web search as her account, not a manually confirmed link -- same notes as the Instagram row above.')
on conflict (url) do nothing;

-- ═══ KNOWLEDGE INDEX (semantic search for Khalo & co's sorting protocols) ═══
-- Lets the automated archivist pass retrieve the most relevant classification
-- rule, or the most similar existing work, by meaning -- instead of only
-- exact/fuzzy title matching and a full always-pasted rules block in the
-- system prompt. Embeddings are 1024-dim (Voyage AI voyage-3), generated and
-- queried by the knowledge-index Edge Function; this section only adds the
-- storage. Requires a VOYAGE_API_KEY secret (Project Settings -> Edge
-- Functions -> Secrets) -- never committed to this repo, added out-of-band.
create extension if not exists vector;

-- One row per logical CLAUDE.md section (split on "## " headings) -- CLAUDE.md
-- itself isn't a database row, so this table is populated by POSTing the
-- current file content to knowledge-index's sync_claude_md action (a manual
-- step after CLAUDE.md changes, run from a session with repo access). A full
-- sync replaces every row, so this table is never edited in place.
create table if not exists claude_md_chunks (
  id          uuid primary key default gen_random_uuid(),
  heading     text not null,
  content     text not null,
  embedding   vector(1024),
  updated_at  timestamptz not null default now()
);
create index if not exists claude_md_chunks_embedding_idx on claude_md_chunks
  using hnsw (embedding vector_cosine_ops);

alter table claude_md_chunks enable row level security;
drop policy if exists "claude_md_chunks_admin_only" on claude_md_chunks;
create policy "claude_md_chunks_admin_only" on claude_md_chunks for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Self-healing: semantic-search embeddings directly on the rows they
-- describe (title + medium + series + notes, see knowledge-index's
-- buildEmbeddingText) rather than a separate join table -- simplest shape
-- given each row already logically IS the "document" being indexed.
alter table works add column if not exists embedding vector(1024);
alter table staged_works add column if not exists embedding vector(1024);
-- source_materials: embeds `notes`, which for a kind='image' row from
-- scripts/catalog_pdf_extractor.py already holds that page's own extracted
-- text (see "Source PDFs" above). A kind='pdf' row has no persisted
-- extracted text to embed (Claude reads the raw PDF live each pass) and a
-- kind='url' row's page text isn't persisted either -- both stay unembedded,
-- which the search results simply won't include, not an error case.
alter table source_materials add column if not exists embedding vector(1024);

create index if not exists works_embedding_idx on works
  using hnsw (embedding vector_cosine_ops);
create index if not exists staged_works_embedding_idx on staged_works
  using hnsw (embedding vector_cosine_ops);
create index if not exists source_materials_embedding_idx on source_materials
  using hnsw (embedding vector_cosine_ops);

-- Generic cosine-similarity search across the four embedded collections,
-- called by the knowledge-index Edge Function's `search` action. One
-- function (rather than one per table) so the Edge Function has a single
-- RPC surface; dynamic SQL per branch since each collection's display
-- columns differ. Called with the service-role key (bypasses RLS), same as
-- every other write this Edge Function makes.
create or replace function match_knowledge_index(
  p_collection text,
  p_query_embedding vector(1024),
  p_match_count int default 5
) returns setof jsonb
language plpgsql
as $$
begin
  if p_collection = 'claude_md' then
    return query execute
      'select jsonb_build_object(
         ''heading'', heading,
         ''content'', content,
         ''similarity'', 1 - (embedding <=> $1)
       ) from claude_md_chunks
       where embedding is not null
       order by embedding <=> $1
       limit $2'
    using p_query_embedding, p_match_count;
  elsif p_collection = 'works' then
    return query execute
      'select jsonb_build_object(
         ''id'', id, ''cr_number'', cr_number, ''title'', title,
         ''date_display'', date_display, ''medium'', medium, ''series'', series,
         ''similarity'', 1 - (embedding <=> $1)
       ) from works
       where embedding is not null
       order by embedding <=> $1
       limit $2'
    using p_query_embedding, p_match_count;
  elsif p_collection = 'staged_works' then
    return query execute
      'select jsonb_build_object(
         ''id'', id, ''title'', title, ''date_display'', date_display,
         ''medium'', medium, ''suggested_series'', suggested_series, ''status'', status,
         ''similarity'', 1 - (embedding <=> $1)
       ) from staged_works
       where embedding is not null
       order by embedding <=> $1
       limit $2'
    using p_query_embedding, p_match_count;
  elsif p_collection = 'source_materials' then
    return query execute
      'select jsonb_build_object(
         ''id'', id, ''filename'', filename, ''kind'', kind,
         ''notes'', left(coalesce(notes,''''), 500),
         ''similarity'', 1 - (embedding <=> $1)
       ) from source_materials
       where embedding is not null
       order by embedding <=> $1
       limit $2'
    using p_query_embedding, p_match_count;
  else
    raise exception 'Unknown collection: %', p_collection;
  end if;
end;
$$;
