#!/usr/bin/env python3
"""
MOD Catalogue Raisonné — exhibition/auction catalog PDF extractor.

Solves for: a real exhibition or auction catalog PDF (an e-cat, a printed
catalogue scan) is far too large to hand to Khalo (the associate-archivist
skill, Mode B) directly -- Supabase's own upload limit rejects anything
over ~50MB outright, and even under that limit, uploading a 100+MB source
PDF just to let a Claude Code session read a few pages of it is wasteful.
Same "a local script does the heavy lifting, only the small derived output
gets uploaded" pattern already used by archive_indexer.py (raw TIFF masters)
and fetch_lot_image.py (auction-site thumbnails) -- this is that pattern
applied to catalog PDFs specifically.

This script runs LOCALLY, on whatever machine has the PDF -- it is never
run by a Claude Code cloud session, which can't read your local drive. It:

  1. Opens the PDF and walks every page.
  2. Extracts each page's real embedded images (not a full-page screenshot)
     when the PDF actually contains separable images -- true for most
     professionally laid-out e-cats and printed-catalogue exports, since
     the images are placed as distinct objects, not baked into one flat
     page scan. Extracted images below --min-px on both sides are skipped
     (logos, bullets, decorative rules -- not artwork).
  3. Resizes each kept image so its longer side is at most --max-px
     (default 2200, per this project's convention for catalog-sourced
     photos), re-encodes as JPEG, and tags it 72 DPI in the file's own
     metadata.
  4. If a page has NO separable images at all (a flattened full-page scan,
     common in older printed catalogs), falls back to rendering the whole
     page as one image instead of silently skipping it -- clearly labeled
     in its notes as unseparated, since it likely still has a full page of
     surrounding layout in it and may need manual cropping later. Never
     silently drops a page that might have a work on it.
  5. Uploads only the resulting small JPEGs (never the source PDF) to the
     source_materials table/bucket, one row per image, each carrying that
     page's full extracted TEXT in its own notes -- so Khalo can read a
     specific photo's page text directly, without cross-referencing a
     separate dump, when it runs Mode B on these rows afterward.

This script does NOT decide which photo belongs to which work, or crop an
image down to just the artwork within a busy page layout -- both are
judgment calls better made by Khalo actually reading the page text next to
each image (see the associate-archivist skill's "Processing a catalog PDF
extraction batch" section), not something this script guesses at.

Setup (run once, reusing the same venv the other scripts/ use if you
already made one):
    python3 -m venv archive-env
    source archive-env/bin/activate
    pip install supabase pymupdf pillow

Usage:
    python3 catalog_pdf_extractor.py "/path/to/Christies_Oka Doner_ecat high res.pdf" \\
        --label "Christie's, [sale name], [date]"

    python3 catalog_pdf_extractor.py "/path/to/file.pdf" --label "..." --dry-run
    python3 catalog_pdf_extractor.py "/path/to/file.pdf" --label "..." --pages 12-40
    python3 catalog_pdf_extractor.py "/path/to/file.pdf" --label "..." --max-px 2200 --min-px 200

You'll be prompted for your MOD CR admin email/password each run -- same
authentication as the website, nothing stored. Never share this script
with a password embedded in it.

Cross-platform (PyMuPDF + Pillow, not tied to macOS like archive_indexer.py's
`sips` step is for TIFFs).
"""
import argparse
import getpass
import io
import sys
import tempfile
import os

SUPABASE_URL = "https://kuyyrygvaotsrhbyjyjw.supabase.co"
# Public by design -- see supabase/PROGRESS.md. Access control is RLS, not
# key secrecy; this script still has to sign in as an admin to write anything.
SUPABASE_ANON_KEY = "sb_publishable_s1HGNRWL1LbiCXzFDK4igg_41mnArJx"

# This project's stated convention for catalog-sourced photos specifically
# (distinct from archive_indexer.py's MAX_DIM=2000 for raw-archive
# conversions -- both are reasonable, they just came from two different asks).
DEFAULT_MAX_PX = 2200
DEFAULT_MIN_PX = 150  # below this on either side, almost certainly a logo/bullet/rule, not artwork
JPEG_QUALITY = 88
DPI = 72


def get_client():
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("Missing dependency. Run: pip install supabase pymupdf pillow")
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    email = input("MOD CR admin email: ").strip()
    password = getpass.getpass("Password: ")
    client.auth.sign_in_with_password({"email": email, "password": password})
    return client


def parse_page_range(spec, page_count):
    if not spec:
        return range(page_count)
    start, _, end = spec.partition("-")
    start = int(start) - 1
    end = int(end) if end else start + 1
    start = max(0, start)
    end = min(page_count, end)
    return range(start, end)


def resize_and_encode(pil_image, max_px):
    pil_image = pil_image.convert("RGB")
    w, h = pil_image.size
    scale = min(1.0, max_px / max(w, h))
    if scale < 1.0:
        pil_image = pil_image.resize((round(w * scale), round(h * scale)), resample=1)  # 1 = Image.LANCZOS
    buf = io.BytesIO()
    pil_image.save(buf, format="JPEG", quality=JPEG_QUALITY, dpi=(DPI, DPI))
    return buf.getvalue()


def extract_page_images(doc, page, fitz, Image, min_px):
    """Returns a list of (jpeg_bytes, width, height) for this page's real
    embedded images that clear the min-size floor. Empty list if the page
    has no separable images worth keeping (caller falls back to a full-page
    render in that case)."""
    out = []
    seen_xrefs = set()
    for img in page.get_images(full=True):
        xref = img[0]
        if xref in seen_xrefs:
            continue
        seen_xrefs.add(xref)
        try:
            pix = fitz.Pixmap(doc, xref)
            if pix.n - pix.alpha >= 4:  # CMYK or other non-RGB -- convert first
                pix = fitz.Pixmap(fitz.csRGB, pix)
            if pix.width < min_px or pix.height < min_px:
                continue
            mode = "RGBA" if pix.alpha else "RGB"
            pil_image = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
            out.append((pil_image, pix.width, pix.height))
        except Exception as e:
            print(f"    (skipped one image on this page: {e})")
    return out


def cmd_run(args):
    try:
        import fitz  # PyMuPDF
        from PIL import Image
    except ImportError:
        sys.exit("Missing dependency. Run: pip install supabase pymupdf pillow")

    if not os.path.isfile(args.pdf_path):
        sys.exit(f"File not found: {args.pdf_path}")

    doc = fitz.open(args.pdf_path)
    page_indices = parse_page_range(args.pages, doc.page_count)
    print(f"{args.pdf_path}: {doc.page_count} pages total, processing {len(list(page_indices))}.")

    plan = []  # (page_num, jpeg_bytes, page_text, is_fallback_full_page)
    for i in page_indices:
        page = doc[i]
        text = page.get_text().strip()
        images = extract_page_images(doc, page, fitz, Image, args.min_px)
        if images:
            for pil_image, w, h in images:
                jpeg_bytes = resize_and_encode(pil_image, args.max_px)
                plan.append((i + 1, jpeg_bytes, text, False))
        else:
            # No separable images -- likely a flattened full-page scan, or a
            # text-only page. Only fall back to a full-page render if the
            # page actually has substantial content worth keeping.
            if len(text) > 40 or True:  # render regardless -- a photo-only scanned page has little/no text
                pix = page.get_pixmap(dpi=150)
                pil_image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                jpeg_bytes = resize_and_encode(pil_image, args.max_px)
                plan.append((i + 1, jpeg_bytes, text, True))

    real_count = sum(1 for _, _, _, fallback in plan if not fallback)
    fallback_count = sum(1 for _, _, _, fallback in plan if fallback)
    print(f"Extracted {real_count} separable image(s), {fallback_count} full-page fallback(s).")

    if args.dry_run:
        print("Dry run -- nothing uploaded. Per-page breakdown:")
        for page_num, jpeg_bytes, text, fallback in plan:
            kind = "FULL-PAGE FALLBACK" if fallback else "image"
            preview = (text[:80] + "...") if len(text) > 80 else text
            print(f"  p.{page_num}  {kind}  ({len(jpeg_bytes)//1024} KB)  text: {preview!r}")
        return

    client = get_client()
    print(f"Uploading {len(plan)} JPEG(s) to source-materials, labeled '{args.label}'...")
    for n, (page_num, jpeg_bytes, text, fallback) in enumerate(plan, 1):
        filename = f"{args.label.replace(' ', '-').replace(',', '')}-p{page_num}-{n}.jpg"
        storage_path = f"catalog-pdf-{args.label[:30].replace(' ', '_')}-p{page_num}-{n}.jpg"
        client.storage.from_("source-materials").upload(
            storage_path, jpeg_bytes, {"content-type": "image/jpeg"}
        )
        note_prefix = (
            "FULL PAGE (no separable embedded photo found on this page -- "
            "may still need manual cropping before use as a work photo). "
            if fallback else ""
        )
        notes = f"{note_prefix}From catalog: {args.label}, page {page_num}.\n\nPage text:\n{text}"
        client.table("source_materials").insert({
            "kind": "image",
            "filename": filename,
            "storage_path": storage_path,
            "notes": notes,
        }).execute()
        print(f"  {n}/{len(plan)} (page {page_num}){' [fallback]' if fallback else ''}")

    print(
        "Done. Now visible in Source Materials for the associate-archivist "
        "skill (Mode B) to process -- run it against these new rows, giving "
        f"it the publication reference: \"{args.label}\"."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf_path", help="Path to the catalog PDF on your local machine.")
    parser.add_argument("--label", required=True, help='Publication reference to cite, e.g. "Christie\'s, [sale name], [date]".')
    parser.add_argument("--pages", help="Page range to process, e.g. 12-40 (1-indexed, inclusive). Default: all pages.")
    parser.add_argument("--max-px", type=int, default=DEFAULT_MAX_PX, help=f"Max longer-side pixel dimension (default {DEFAULT_MAX_PX}).")
    parser.add_argument("--min-px", type=int, default=DEFAULT_MIN_PX, help=f"Skip embedded images smaller than this on either side (default {DEFAULT_MIN_PX}).")
    parser.add_argument("--dry-run", action="store_true", help="Preview what would be extracted/uploaded without writing anything.")
    parser.set_defaults(func=cmd_run)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
