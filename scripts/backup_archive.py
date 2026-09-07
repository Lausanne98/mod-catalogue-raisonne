#!/usr/bin/env python3
"""
MOD Catalogue Raisonné — full site backup.

Solves for the periodic-backup ask: a complete snapshot of the database
(every table, as JSON) and every Storage bucket (every file, as-is),
downloaded to an external drive. Meant to run on a schedule (proposed
cadence: every 6 weeks) via a local `launchd` job on the Studio Mac.

This is NOT something "Timur" (the chat persona) can run himself — a chat
agent has no standing process and no access to a physical drive, the same
structural limit already documented for the raw-archive indexer. This
script is the actual mechanism: it runs LOCALLY, on whatever machine has
the drive attached, never by a Claude Code cloud session.

Each run creates a new timestamped folder under --dest, so re-running this
on a schedule naturally keeps a history of past backups rather than
overwriting the previous one.

Setup (run once):
    python3 -m venv archive-env
    source archive-env/bin/activate
    pip install supabase

Usage:
    python3 backup_archive.py --dest "/Volumes/Drive/MOD CR Backups"

You'll be prompted for your MOD CR admin email/password each run -- this
authenticates the script as your real admin account (same login as the
website), which is what the database's row-level security checks against.
Nothing is stored; you type it fresh every run.

To schedule it every 6 weeks on macOS, use `launchd` (cron is deprecated):
create a plist in ~/Library/LaunchAgents/ with a StartInterval of 3628800
seconds (6 weeks) pointing at this script. Ask Claude Code for the exact
plist file when you're ready to set that up -- it's a one-time setup step
on the Studio Mac itself.
"""
import argparse
import getpass
import os
import sys
from datetime import datetime, timezone

SUPABASE_URL = "https://kuyyrygvaotsrhbyjyjw.supabase.co"
# Public by design -- see supabase/PROGRESS.md. Access control is RLS, not
# key secrecy; this script still has to sign in as an admin to read anything
# in the private buckets (source-materials, public-submissions).
SUPABASE_ANON_KEY = "sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"

# Every table in supabase/schema.sql, as of 2026-09-07. If a new table is
# added later, add its name here too -- this list is not auto-discovered.
TABLES = [
    "series",
    "materials",
    "works",
    "work_photos",
    "work_annotations",
    "work_sources",
    "staged_works",
    "agent_settings",
    "work_revisions",
    "it_subscriptions",
    "it_access_settings",
    "public_submissions",
    "source_materials",
    "archive_index",
    "series_photos",
    "chronology_decades",
    "chronology_events",
]

# Every Storage bucket in supabase/schema.sql, as of 2026-09-07.
BUCKETS = [
    "work-photos",
    "work-audio",
    "series-photos",
    "chronology-photos",
    "source-materials",
    "public-submissions",
]

PAGE_SIZE = 1000

# Deliberate, acknowledged exception to this project's "never store a
# credential" practice, made ONLY so an unattended launchd-scheduled run
# doesn't sit forever waiting for a password nobody's there to type. Lives
# outside the repo entirely -- this path is never git-tracked, and this
# script never creates or writes to it, only reads it if it's already there.
#
# To set it up (do this ONCE, on the Studio Mac itself, in a terminal --
# never paste a real password into a Claude Code chat message, cloud or
# local): create the file at this exact path with exactly two lines, the
# admin email on the first and the password on the second, then lock down
# its permissions so only your own account can read it:
#     nano ~/.modcr_backup_credentials
#     chmod 600 ~/.modcr_backup_credentials
# A manual, on-demand run (see the module docstring) works identically
# whether or not this file exists -- if it's missing, this script just
# falls back to the interactive prompt below instead.
CREDENTIALS_FILE = os.path.expanduser("~/.modcr_backup_credentials")


def get_client():
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("Missing dependency. Run: pip install supabase")

    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    if os.path.isfile(CREDENTIALS_FILE):
        with open(CREDENTIALS_FILE) as f:
            lines = [line.strip() for line in f.readlines() if line.strip()]
        if len(lines) < 2:
            sys.exit(
                f"{CREDENTIALS_FILE} exists but doesn't have both an email and a "
                "password line -- fix it or delete it to fall back to the interactive prompt."
            )
        email, password = lines[0], lines[1]
        print(f"Using stored credentials from {CREDENTIALS_FILE} (unattended run).")
    else:
        email = input("MOD CR admin email: ").strip()
        password = getpass.getpass("Password: ")

    client.auth.sign_in_with_password({"email": email, "password": password})
    return client


def backup_table(client, table_name, dest_dir):
    import json

    rows = []
    start = 0
    while True:
        resp = (
            client.table(table_name)
            .select("*")
            .range(start, start + PAGE_SIZE - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        start += PAGE_SIZE

    out_path = os.path.join(dest_dir, f"{table_name}.json")
    with open(out_path, "w") as f:
        json.dump(rows, f, indent=2, default=str)
    return len(rows)


def list_all_files(client, bucket, path=""):
    """Recursively walk a Storage bucket, returning a flat list of file paths.
    Supabase Storage's list() mixes files and "folder" placeholder entries in
    the same response -- a folder entry has no real file id, so we recurse
    into anything that doesn't look like an actual file.
    """
    files = []
    entries = client.storage.from_(bucket).list(path or None)
    for entry in entries or []:
        name = entry.get("name")
        if not name:
            continue
        full_path = f"{path}/{name}" if path else name
        # A real file entry carries metadata (size, mimetype); a folder
        # placeholder does not.
        if entry.get("metadata") is None:
            files.extend(list_all_files(client, bucket, full_path))
        else:
            files.append(full_path)
    return files


def backup_bucket(client, bucket, dest_dir):
    file_paths = list_all_files(client, bucket)
    for file_path in file_paths:
        local_path = os.path.join(dest_dir, file_path)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        data = client.storage.from_(bucket).download(file_path)
        with open(local_path, "wb") as f:
            f.write(data)
    return len(file_paths)


def cmd_run(args):
    dest_root = os.path.abspath(args.dest)
    os.makedirs(dest_root, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%SZ")
    run_dir = os.path.join(dest_root, timestamp)
    tables_dir = os.path.join(run_dir, "tables")
    storage_dir = os.path.join(run_dir, "storage")
    os.makedirs(tables_dir, exist_ok=True)
    os.makedirs(storage_dir, exist_ok=True)

    client = get_client()

    print(f"\nBacking up {len(TABLES)} tables to {tables_dir} ...")
    total_rows = 0
    for table_name in TABLES:
        try:
            count = backup_table(client, table_name, tables_dir)
            total_rows += count
            print(f"  {table_name}: {count} rows")
        except Exception as e:
            print(f"  {table_name}: FAILED -- {e}")

    print(f"\nBacking up {len(BUCKETS)} storage buckets to {storage_dir} ...")
    total_files = 0
    for bucket in BUCKETS:
        bucket_dir = os.path.join(storage_dir, bucket)
        os.makedirs(bucket_dir, exist_ok=True)
        try:
            count = backup_bucket(client, bucket, bucket_dir)
            total_files += count
            print(f"  {bucket}: {count} files")
        except Exception as e:
            print(f"  {bucket}: FAILED -- {e}")

    print(f"\nDone. {total_rows} rows and {total_files} files backed up to:")
    print(f"  {run_dir}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dest", required=True, help='Folder on the external drive to back up into, e.g. "/Volumes/Drive/MOD CR Backups".')
    parser.set_defaults(func=cmd_run)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
