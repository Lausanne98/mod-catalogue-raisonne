#!/usr/bin/env python3
"""
MOD Catalogue Raisonné — raw photo archive indexer.

Solves for: a photographer's shoot sits in a folder of 500MB-4GB TIFF
masters on an external drive at the studio, and there are many such
folders. The masters should stay exactly where they are — never bulk
uploaded — but the studio still needs the archive to be *browsable* from
the admin site (Researcher's Desk), and an easy way to convert just one
file to JPG and upload it, only when it's actually needed for a work.

This script runs LOCALLY, on whatever machine has the drive attached (the
Studio Mac) — it is never run by a Claude Code cloud session, which has no
access to that drive. Two things it does:

  index    Walk a folder tree and record filename/size/type into the
           archive_index table — metadata only, no image bytes leave the
           drive. Safe to re-run: matching (archive_label, relative_path)
           rows are updated in place, not duplicated.

  convert  Convert ONE specific file to JPG (via macOS's built-in `sips` —
           no extra install needed) and upload just that JPG to
           source_materials, then mark the matching archive_index row
           'converted' and link it to the new source_materials row.

Setup (run once):
    python3 -m venv archive-env
    source archive-env/bin/activate
    pip install supabase

Usage:
    python3 archive_indexer.py index "/Volumes/Drive/XYZ Photographer 2019" --label "XYZ Photographer — 2019 Shoot"
    python3 archive_indexer.py index "/Volumes/Drive/XYZ Photographer 2019" --label "XYZ Photographer — 2019 Shoot" --dry-run

    python3 archive_indexer.py convert --label "XYZ Photographer — 2019 Shoot" --path "raw/DSC001.tif" --root "/Volumes/Drive/XYZ Photographer 2019"

You'll be prompted for your MOD CR admin email/password each run — this
authenticates the script as your real admin account (same login as the
website), which is what the database's row-level security checks against.
Nothing is stored; you type it fresh every run. Never share this script
with your password embedded in it.

macOS only (uses `sips`, which ships with the OS). On another platform,
swap the `convert_to_jpeg()` function for Pillow or ImageMagick instead.
"""
import argparse
import getpass
import os
import subprocess
import sys
import tempfile

SUPABASE_URL = "https://kuyyrygvaotsrhbyjyjw.supabase.co"
# Public by design -- see supabase/PROGRESS.md. Access control is RLS, not
# key secrecy; this script still has to sign in as an admin to write anything.
SUPABASE_ANON_KEY = "sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"

# Skip macOS/Windows junk files that aren't real archive content.
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}

# Resize convention matches Source Materials' own existing pipeline (the
# browser-based upload on catalogue_admin_sources / catalogue_admin_researcher).
MAX_DIM = 2000
JPEG_QUALITY = 85


def get_client():
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("Missing dependency. Run: pip install supabase")

    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    email = input("MOD CR admin email: ").strip()
    password = getpass.getpass("Password: ")
    client.auth.sign_in_with_password({"email": email, "password": password})
    return client


def cmd_index(args):
    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        sys.exit(f"Not a directory: {root}")

    rows = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name in SKIP_NAMES:
                continue
            full_path = os.path.join(dirpath, name)
            rel_path = os.path.relpath(full_path, root)
            try:
                size = os.path.getsize(full_path)
            except OSError:
                size = None
            ext = os.path.splitext(name)[1].lstrip(".").lower() or None
            rows.append({
                "archive_label": args.label,
                "relative_path": rel_path,
                "filename": name,
                "file_size_bytes": size,
                "file_type": ext,
            })

    if not rows:
        print("No files found under that root.")
        return

    total_gb = sum(r["file_size_bytes"] or 0 for r in rows) / (1024 ** 3)
    print(f"Found {len(rows)} files under {root} ({total_gb:.2f} GB total).")

    if args.dry_run:
        print("Dry run -- nothing written. Sample of what would be indexed:")
        for r in rows[:10]:
            print(f"  {r['relative_path']}  ({r['file_size_bytes'] or '?'} bytes)")
        if len(rows) > 10:
            print(f"  ... and {len(rows) - 10} more")
        return

    client = get_client()
    print("Uploading index (metadata only -- no image files are touched)...")
    # upsert on the (archive_label, relative_path) unique constraint so
    # re-running this over the same folder updates existing rows instead of
    # duplicating them.
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        client.table("archive_index").upsert(
            batch, on_conflict="archive_label,relative_path"
        ).execute()
        print(f"  {min(i + batch_size, len(rows))}/{len(rows)}")
    print("Done. Browse it on the Researcher's Desk admin page.")


def convert_to_jpeg(src_path, dst_path):
    subprocess.run(
        [
            "sips",
            "-s", "format", "jpeg",
            "-s", "formatOptions", str(JPEG_QUALITY),
            "--resampleHeightWidthMax", str(MAX_DIM),
            src_path,
            "--out", dst_path,
        ],
        check=True,
        capture_output=True,
    )


def cmd_convert(args):
    src_path = os.path.join(args.root, args.path)
    if not os.path.isfile(src_path):
        sys.exit(f"File not found: {src_path}")

    client = get_client()

    existing = (
        client.table("archive_index")
        .select("id,status")
        .eq("archive_label", args.label)
        .eq("relative_path", args.path)
        .maybe_single()
        .execute()
    )
    if not existing.data:
        sys.exit(
            "No matching archive_index row for that label/path -- run `index` on this "
            "folder first so the row exists to link against."
        )
    archive_row_id = existing.data["id"]

    filename = os.path.splitext(os.path.basename(args.path))[0] + ".jpg"
    with tempfile.TemporaryDirectory() as tmp:
        jpg_path = os.path.join(tmp, filename)
        print(f"Converting {args.path} -> JPEG (max {MAX_DIM}px)...")
        convert_to_jpeg(src_path, jpg_path)

        with open(jpg_path, "rb") as f:
            jpg_bytes = f.read()

        storage_path = f"archive-converted-{archive_row_id}-{filename}"
        print("Uploading JPEG to source-materials...")
        client.storage.from_("source-materials").upload(
            storage_path, jpg_bytes, {"content-type": "image/jpeg"}
        )

    inserted = (
        client.table("source_materials")
        .insert({
            "kind": "image",
            "filename": filename,
            "storage_path": storage_path,
            "notes": f"Converted from archive: {args.label} / {args.path}",
        })
        .execute()
    )
    source_material_id = inserted.data[0]["id"]

    client.table("archive_index").update({
        "status": "converted",
        "linked_source_material_id": source_material_id,
    }).eq("id", archive_row_id).execute()

    print(f"Done. Now visible in Source Materials / Researcher's Desk as: {filename}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="Record filenames/sizes for a folder tree -- no image bytes uploaded.")
    p_index.add_argument("root", help="Path to the folder to index (e.g. a mounted external drive path).")
    p_index.add_argument("--label", required=True, help='Human label for this archive, e.g. "XYZ Photographer — 2019 Shoot".')
    p_index.add_argument("--dry-run", action="store_true", help="Preview what would be indexed without writing to Supabase.")
    p_index.set_defaults(func=cmd_index)

    p_convert = sub.add_parser("convert", help="Convert one file to JPEG and upload it, only when actually needed.")
    p_convert.add_argument("--label", required=True, help="The archive_label this file was indexed under.")
    p_convert.add_argument("--path", required=True, help="The relative_path shown in the index for this file.")
    p_convert.add_argument("--root", required=True, help="The same root folder used for `index`, so the file can be found on disk.")
    p_convert.set_defaults(func=cmd_convert)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
