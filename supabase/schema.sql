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
  ('publications',          'Publications',    false, 9)
on conflict (slug) do nothing;

-- ═══ WORKS ═══
create table if not exists works (
  id           uuid primary key default gen_random_uuid(),
  cr_number    integer not null unique,          -- "MOD CR 6" -> 6
  title        text not null,
  date_display text,                             -- e.g. "c. 1975", "Date pending"
  year         integer,                          -- null if genuinely unknown
  medium       text,                             -- descriptive free text, e.g. "Raku ceramic"
  tag          text check (tag in (               -- nullable: a work with no clean single
                 'paper','ceramic','bronze','gold','silver','diamonds','stone', -- Medium value
                 'organic-material','glass','steel','canvas','painting',        -- (see CLAUDE.md
                 'photography','video'                                          -- "Known open item")
               )),                                                              -- stays unset, not guessed
  series       text not null references series(slug),
  secondary_series text references series(slug),  -- optional: work also belongs under a
                                                    -- second series filter (e.g. a jewelry
                                                    -- piece that's also part of a limited
                                                    -- edition run), in addition to its
                                                    -- primary `series` above.
  dimensions   text,
  description  text,
  provenance   text,
  exhibitions  text,                             -- free text for now, one entry per line
  literature   text,                             -- free text for now, one entry per line
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
-- (tag was `not null` and the check list didn't cover every value actually used
-- in the migration below — 'jewelry' and 'installation' — which would have made
-- the works insert fail as a whole). Safe to re-run: no-ops once already fixed.
alter table works alter column tag drop not null;
alter table works drop constraint if exists works_tag_check;
alter table works add constraint works_tag_check check (tag in (
  'paper','ceramic','bronze','gold','silver','diamonds','stone',
  'organic-material','glass','steel','canvas','painting',
  'photography','video'
));

-- Self-healing: add secondary_series to a works table created before this column existed.
alter table works add column if not exists secondary_series text references series(slug);

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
  created_at        timestamptz not null default now()
);
create index if not exists work_annotations_work_id_idx on work_annotations(work_id);

-- ═══ ROW LEVEL SECURITY ═══
-- Public (anon) visitors can read only works whose series is published.
-- Authenticated (the admin, once real auth is wired up) can read/write everything.
alter table series enable row level security;
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

drop policy if exists "works_public_read" on works;
create policy "works_public_read" on works for select
  using (
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
    or auth.role() = 'authenticated'
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
        s.published = true
        or (w.secondary_series is not null and exists (select 1 from series ss where ss.slug = w.secondary_series and ss.published = true))
        or (w.tag = 'ceramic' and w.year < 2000 and exists (select 1 from series es where es.slug = 'early-clay' and es.published = true))
        or auth.role() = 'authenticated'
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
        s.published = true
        or (w.secondary_series is not null and exists (select 1 from series ss where ss.slug = w.secondary_series and ss.published = true))
        or (w.tag = 'ceramic' and w.year < 2000 and exists (select 1 from series es where es.slug = 'early-clay' and es.published = true))
        or auth.role() = 'authenticated'
      )
    )
  );
drop policy if exists "annotations_admin_write" on work_annotations;
create policy "annotations_admin_write" on work_annotations for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ═══ STORAGE BUCKETS ═══
insert into storage.buckets (id, name, public)
values ('work-photos', 'work-photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('work-audio', 'work-audio', true)
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

-- ═══ MIGRATE EXISTING 28 WORKS ═══
-- Images point at the already-hosted GitHub Pages files for now (legacy_image_url)
-- rather than re-uploading into Storage in this pass — new intake uploads going
-- forward use work_photos + the work-photos bucket properly.
insert into works (cr_number, title, date_display, year, medium, tag, series, legacy_image_url, flag) values
  (1, 'Tattooed Torso', '1966', 1966, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/TattooedTorso1966-icon.png', null),
  (13, 'Ceramic Seeds', 'c. 1971', 1971, 'Glazed ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/TwoCeramicSeeds-icon-1.png', null),
  (2, 'Germinating Seeds', 'c. 1972', 1972, 'Bronze', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/GerminatingSeeds-icon-223x200.png', null),
  (18, 'Tattooed Relic', 'c. 1974', 1974, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Tatoed_Relic.jpg', null),
  (14, 'Death Masks', 'c. 1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/DeathMasks-Icon.png', null),
  (15, 'Descending Torsos', '1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/DescendingTorsos1975-icon.png', null),
  (16, 'Wings II', '1975', 1975, 'Raku ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/WaveFigures-Icon.png', null),
  (20, 'Seeds & Pods', 'c. 1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/SeadPods-icon.png', null),
  (17, 'Triads', 'c. 1976', 1976, 'Raku ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Tortoises-icon.png', null),
  (21, 'Tattooed Dolls', 'c. 1975', 1975, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Totems-icon.png', null),
  (19, 'Figures with Staffs', 'c. 1978', 1978, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Figures-Icon.png', null),
  (3, 'Burning Branches', '1975', 1975, 'Bronze', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/BurningBranches-Icon.png', null),
  (4, 'Soul Catchers', '1977', 1977, 'Bronze', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/SoulCatchers_Clay-Icon.png', null),
  (5, 'Pictographs', 'c. 1979', 1979, 'Ceramic', 'ceramic', 'early-clay', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Pictograph_icon.png', null),
  (7, 'Celestial Plaza', '1986', 1986, 'Bronze — permanent public install.', 'bronze', 'public-installations', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/AMNH_installation-icon.png', null),
  (9, 'Radiant Disk', '1988', 1988, 'Bronze with patina', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/RadiantDiskIceRing.png', null),
  (6, 'A Walk on the Beach', '1995', 1995, 'Bronze — permanent public install.', 'bronze', 'public-installations', null, 'icon mismatch — sourced image did not depict this work, removed pending correct image'),
  (10, 'Blueprint of Eden', '1999', 1999, 'Cyanotype, natural specimens', 'paper', 'works-on-paper', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/BluePrintOfEden-IconV3-1-213x223.png', null),
  (11, 'Thorn Man', 'c. 2000', 2000, 'Bronze with silver', 'bronze', 'bronze-works', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Thornmen3_studio-photos_Dirk-Bakker-R_iconV2-177x223.png', null),
  (8, 'Into the Mysterium', '2003', 2003, 'Mixed media installation', null, 'public-installations', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Mysterium-Icon.png', 'Medium classification undecided — mixed media installation, no clean single Medium value in the taxonomy (see CLAUDE.md known open item)'),
  (12, 'Talisman', '2019', 2019, 'Bronze — permanent public install.', 'bronze', 'public-installations', 'https://lausanne98.github.io/mod-catalogue-raisonne/Entry%20Images/Talisman_Icon-142x223.png', null),
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
-- Post-2000 pieces (Caio, the Telchine group, Fe, One Fluid Stroke) are ceramic but
-- not series=early-clay — Early Clay represents the artist's early-period ceramic
-- work specifically, not "ceramic at any date" (see CLAUDE.md).
insert into works (cr_number, title, date_display, year, medium, tag, series, legacy_image_url, flag) values
  (100, 'Wave Torsos', 'c. 1969', 1969, 'Clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2022/03/WaveTorsos.jpg', null),
  (101, 'Caio', '2008', 2008, 'Iron-glazed porcelain', 'ceramic', 'bronze-works', 'https://micheleokadoner.com/wp-content/uploads/2018/09/Caio-Consumed-by-Fire-2ViewsMOD.jpg', null),
  (102, 'Disarming Images', '1985', 1985, 'Clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/09/DisarmingImages-Icon.png', null),
  (103, 'Labyrinth', '1977', 1977, 'Handmade basalt clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/06/Labyrinth1977-icon_lighter-copy_no-bg_REFINED_COLOR-155x146.jpg', null),
  (104, 'Telchine, Gaia, Rhea & Ur', 'c. 2009–2010', 2010, 'Earthenware (Nymphenburg Porcelain Manufactory)', 'ceramic', 'bronze-works', 'https://micheleokadoner.com/wp-content/uploads/2018/02/Telchine.jpg', 'Legacy page bundles four named pieces (Telchine, Gaia, Rhea, Ur) under one photo/entry — may need splitting into separate catalogue works.'),
  (105, 'Tribe', 'c. 1982', 1982, 'Clay', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/01/TribeDB.jpg', null),
  (106, 'Scapula', '1977', 1977, 'Raku', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2017/12/Scalpula_PorcelainSculptureMODoner-f-2.jpg', null),
  (107, 'Radiant Site', '1990', 1990, 'Gold-luster Pewabic ceramic tile (MTA installation)', 'ceramic', 'early-clay', null, 'Image URL from legacy site was truncated/unconfirmed during research — needs sourcing before display.'),
  (108, 'Tattooed Torsos', '1968', 1968, 'Clay ("Six Totems")', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2018/01/Tatooed-Toros-68.jpg', 'Name closely echoes MOD CR 1 "Tattooed Torso" (1966) — appears distinct per date/description (a group of six totems vs. a single 1966 piece) but flagged for curatorial confirmation it isn''t a duplicate.'),
  (109, 'Burial Pieces', 'c. 1974–1975', 1975, 'Raku, high-fired porcelain, smoked stoneware (group work)', 'ceramic', 'early-clay', 'https://micheleokadoner.com/wp-content/uploads/2017/12/Burial-Pieces-Master-2.jpg', 'Group photo names ~8 sub-pieces; some (Triad, Descending Torso, Wings II) overlap existing MOD CR 15/16/17 — needs curatorial review on whether to split into individual works.'),
  (110, 'Fe', '2010', 2010, null, 'ceramic', 'bronze-works', null, 'No image or explicit medium confirmation found on the legacy site — classified ceramic per curatorial direction; needs source verification.'),
  (111, 'Early Torsos', 'c. 1967', 1967, null, 'ceramic', 'early-clay', null, 'Bundles several named sub-works (Wave Figures, Coiled Figure, Early Figures, Open Mouth); no image found; likely overlaps with Wave Torsos/Tribe — needs curatorial review.'),
  (112, 'One Fluid Stroke', '2014', 2014, 'Ceramic ("Fifty Plates" — 50 unique numbered plates)', 'ceramic', 'editions', null, 'No photo found on the legacy site to verify — medium confirmed as ceramic via page text only.'),
  (113, 'Fossil & Volcanic Bowl', '1964', 1964, 'Clay (two bowls: "Fossil Bowl" and "Volcanic Bowl")', 'ceramic', 'early-clay', null, 'No image found; may represent two separate bowls bundled as one legacy entry — needs curatorial review.'),
  (114, 'Prophecy', 'Date pending', null, 'Bronze', 'bronze', 'public-installations', 'https://micheleokadoner.com/wp-content/uploads/2021/07/Prophesy_Icon_bw.png', null)
on conflict (cr_number) do nothing;

-- Frond Necklace is also part of a limited-edition run, in addition to being jewelry.
update works set secondary_series = 'editions' where cr_number = 22;

-- Prophecy (MOD CR 114) has a verified process photo — "Patina at Talix," the artist
-- applying patina at the Talix foundry — self-hosted (uploaded to the work-photos
-- bucket) rather than linked to the legacy site, matching how new intake works.
-- No natural unique key on work_photos to use "on conflict", so guard with NOT EXISTS
-- instead to keep this safe to re-run.
insert into work_photos (work_id, storage_path, photo_type, caption)
select w.id, w.id || '/patina-at-talix.jpg', 'process', 'Patina at Talix'
from works w
where w.cr_number = 114
and not exists (
  select 1 from work_photos wp where wp.work_id = w.id and wp.storage_path = w.id || '/patina-at-talix.jpg'
);
