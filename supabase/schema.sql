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
