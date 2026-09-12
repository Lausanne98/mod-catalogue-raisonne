#!/usr/bin/env python3
"""
MOD Catalogue Raisonné — pull a real thumbnail for a research finding.

Solves for a real structural limit: a Claude Code CLOUD session's network
egress is blocked (by this repo's own environment policy) for essentially
every auction-house/marketplace domain -- Phillips, Bonhams, Sotheby's,
Rago, Wright, Doyle, Toomey, Invaluable, LiveAuctioneers, etc. WebSearch can
still find and corroborate a lot page there, but nothing in that session can
fetch the page's HTML to pull an actual photo. This script is the fix: it
runs LOCALLY on your own machine, which has ordinary internet access, same
"a cloud session can't reach this, a local script can" pattern already used
by archive_indexer.py and backup_archive.py.

What it does: for every research_finds row missing an image_url (default:
gallery/auction-house findings that have a url), fetches that page and pulls
its `og:image` meta tag -- the single photo a site's own page markup already
designates as "the one image that represents this listing," the same tag
used when a link unfurls on social media. That's a much more reliable signal
than guessing which <img> on the page is the right one, and it's exactly the
kind of admin-only review thumbnail this project's rules allow (see the
"image_url" section in .claude/skills/researcher/SKILL.md) -- it is NOT a
substitute for the full image-rights verification a work's own public `img`
field still needs if this finding is ever promoted into a real work.

This does not GUESS: if a page has no og:image (or blocks the request, or
the request fails for any reason), that row is left alone and reported as
not found -- never a fabricated or best-guess URL.

Setup (run once, reusing the same venv backup_archive.py uses if you already
made one):
    python3 -m venv archive-env
    source archive-env/bin/activate
    pip install supabase

Usage:
    python3 fetch_lot_image.py                 # gallery/auction-house findings missing an image
    python3 fetch_lot_image.py --dry-run        # preview only, writes nothing
    python3 fetch_lot_image.py --category press # widen beyond the default two categories
    python3 fetch_lot_image.py --id <uuid> ...  # target specific findings only

You'll be prompted for your MOD CR admin email/password (or it'll use
~/.modcr_backup_credentials if that file already exists from setting up
backup_archive.py -- same file, same account, nothing new to set up).
"""
import argparse
import getpass
import html
import os
import re
import sys
import time
import urllib.error
import urllib.request

SUPABASE_URL = "https://kuyyrygvaotsrhbyjyjw.supabase.co"
# Public by design -- see supabase/PROGRESS.md. Access control is RLS, not
# key secrecy; this script still has to sign in as an admin to write
# image_url (research_finds UPDATE is admin-only).
SUPABASE_ANON_KEY = "sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"

CREDENTIALS_FILE = os.path.expanduser("~/.modcr_backup_credentials")

DEFAULT_CATEGORIES = ["gallery", "auction-house"]

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

OG_IMAGE_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
# Some sites emit content= before property=/name= -- same tag, reversed
# attribute order, so a second pass with attributes swapped catches those.
OG_IMAGE_RE_REV = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\']',
    re.IGNORECASE,
)


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
            sys.exit(f"{CREDENTIALS_FILE} exists but is missing an email/password line.")
        email, password = lines[0], lines[1]
        print(f"Using stored credentials from {CREDENTIALS_FILE}.")
    else:
        email = input("MOD CR admin email: ").strip()
        password = getpass.getpass("Password: ")

    client.auth.sign_in_with_password({"email": email, "password": password})
    return client


def fetch_og_image(page_url):
    """Returns the og:image URL, or None if not found/unreachable. Never
    raises -- a failure here just means 'not found', logged by the caller."""
    req = urllib.request.Request(page_url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read(1_500_000)  # a lot page's <head> is well within this
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:
        return None, f"fetch failed ({e})"

    try:
        text = raw.decode("utf-8", errors="ignore")
    except Exception:
        return None, "could not decode response"

    match = OG_IMAGE_RE.search(text) or OG_IMAGE_RE_REV.search(text)
    if not match:
        return None, "no og:image/twitter:image tag found"

    image_url = html.unescape(match.group(1)).strip()
    if not image_url.startswith(("http://", "https://")):
        return None, f"og:image was relative/malformed ({image_url!r})"
    return image_url, "ok"


def cmd_run(args):
    client = get_client()

    query = client.table("research_finds").select("id,title,category,url,image_url")
    if args.id:
        query = query.in_("id", args.id)
    else:
        query = query.in_("category", args.category).is_("image_url", "null").not_.is_("url", "null")
    rows = query.execute().data or []

    if not rows:
        print("Nothing to do -- no matching findings without an image_url.")
        return

    print(f"{len(rows)} finding(s) to check{' (dry run, writing nothing)' if args.dry_run else ''}:\n")
    found, skipped = 0, 0
    for row in rows:
        image_url, status = fetch_og_image(row["url"])
        label = row["title"]
        if image_url:
            found += 1
            print(f"  FOUND    {label}\n           -> {image_url}")
            if not args.dry_run:
                client.table("research_finds").update({"image_url": image_url}).eq("id", row["id"]).execute()
        else:
            skipped += 1
            print(f"  NOT FOUND {label}\n           ({status}) -- {row['url']}")
        time.sleep(1.5)  # be a polite, low-rate visitor, not a scraper

    print(f"\nDone. {found} image(s) found" + ("" if args.dry_run else " and written") + f", {skipped} not found.")
    print("Spot-check a few on Researcher's Desk before trusting the rest -- ")
    print("og:image is reliable but not infallible (a site can point it at a generic banner).")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--category", nargs="+", default=DEFAULT_CATEGORIES, help=f"Categories to include (default: {DEFAULT_CATEGORIES}).")
    parser.add_argument("--id", nargs="+", help="Only process these specific research_finds ids, ignoring --category.")
    parser.add_argument("--dry-run", action="store_true", help="Preview what would be found without writing image_url.")
    parser.set_defaults(func=cmd_run)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
