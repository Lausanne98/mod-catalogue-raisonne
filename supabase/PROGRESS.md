# Backend status

Historical build narrative (schema bugs found/fixed, the original migration,
early smoke tests) lives in git history for this file — this doc tracks
current state only, not how we got here.

## MCP access
A Supabase MCP server is connected with direct `execute_sql` / `apply_migration`
tools against the live project (`kuyyrygvaotsrhbyjyjw`). Use it directly for
queries and schema changes instead of asking the user to paste SQL into the
Supabase SQL Editor — that workaround is no longer necessary. This is a scoped
project-access path, separate from the `service_role` secret key below (still
never shared with Claude). Creating an admin user is still dashboard-only
(Authentication → Users) with no MCP equivalent.

## Project
- Supabase project URL: `https://kuyyrygvaotsrhbyjyjw.supabase.co`
- Publishable (anon) key: `sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx`
  (safe to be public — this is the client-side key by design — access control
  is enforced by the RLS policies in `schema.sql`, not by keeping this secret)
- The `service_role` secret key was never shared with Claude and must stay
  that way — full unrestricted DB access, private only.

## Current state (verified live, 2026-08-19)
`supabase/schema.sql` is applied and the backend is working end-to-end —
public pages, admin pages, and intake all read/write the live DB. Every
migration in the file is a self-healing `alter table ... add column if not
exists`, safe to re-run.

## Supabase auto-pause keepalive
Supabase's free tier auto-pauses a project after 7 days with zero API
activity. This site has no server of its own (static HTML on GitHub Pages,
no Vercel/Node build to hang a cron-triggered API route off of), so instead
`.github/workflows/supabase-keepalive.yml` is a GitHub Actions scheduled
workflow (`schedule: cron '0 8 * * *'`, plus `workflow_dispatch` for a manual
run) that does one read-only request a day (`select=slug&limit=1` against
the public `series` table, using the anon key above) to keep the project
active. Costs nothing — free GitHub Actions minutes, no new infra. Not
verified against the live project this session — this sandbox's egress
proxy blocks `*.supabase.co` outright (see "Not yet independently verified"
below), same known limitation, so confirm the workflow actually succeeds
from the Actions tab after it's merged.

If the daily ping fails, the workflow opens a GitHub issue (labeled
`supabase-keepalive-failure`, deduplicated so a run of consecutive failures
doesn't open a new one each day) rather than relying on anyone's GitHub
email-notification settings — a failure likely means the project auto-paused
or the API/key changed, either of which is worth knowing about right away.

Live row count is **not fully knowable via the anon key** — RLS only
surfaces published series (plus the ceramic-pre-2000 Early Clay
cross-categorization). A same-session anon query returned 21 rows visible
under current publish settings; the true total, including unpublished
series, requires dashboard/service-role access this session doesn't have.
Don't trust a specific total in this file going forward — query live
instead (see below).

## Known open items
- **MOD CR 8** ("Into the Mysterium," mixed media installation) still has no
  resolved `tag` — genuinely undecided taxonomy per CLAUDE.md, not an
  oversight. Flagged via its `flag` field for a real decision.
- Pictographs medium description still needs the real source text.
- Full image-mismatch audit of works beyond MOD CR 6 (see CLAUDE.md's
  "Pulling media from the legacy site" section) not done yet.
- Legal terms text is still a placeholder draft, needs attorney review.
- Voice annotations not yet tested on real hardware (Snowball USB mic) —
  only a fake-device round-trip has passed so far.

## How to verify current state instead of trusting this file
```
curl "https://kuyyrygvaotsrhbyjyjw.supabase.co/rest/v1/works?select=cr_number,title,series,tag,flag&order=cr_number" \
  -H "apikey: sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"
```
This only returns rows RLS allows the anon key to see (published series +
cross-categorized Early Clay). Full-table visibility, publish-state changes,
and admin user management all require the Supabase Dashboard (service-role
access), which no Claude session has.
