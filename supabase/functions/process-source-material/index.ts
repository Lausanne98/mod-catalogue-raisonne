// MOD Catalogue Raisonné — process-source-material Edge Function.
//
// The real, standing implementation of Khalo's Mode B (see
// .claude/skills/associate-archivist/SKILL.md) as a live, tool-using agent
// instead of something only a Claude Code session can run. Triggered from
// Researcher's Desk's "Process" button on an uploaded source_materials row
// (a catalog PDF, or a batch of extracted catalog images sharing a label
// from scripts/catalog_pdf_extractor.py). Reads the actual document via
// Claude's native PDF/image support, then works through a deliberately
// narrow, staging-only tool set -- no tool here can write to `works`
// directly, publish anything, delete anything, or assign a cr_number, so
// Khalo's hard rules are enforced structurally, not just by the system
// prompt.
//
// Runs in the background via EdgeRuntime.waitUntil() -- a real pass over a
// full catalog can take several minutes, well past what the initial HTTP
// response can wait for. The caller gets an immediate "started" response
// and polls source_materials.status for progress (unreviewed -> processing
// -> matched/flagged/rejected); the run's own summary lands in that row's
// notes when it finishes.
//
// Deploy: supabase functions deploy process-source-material
// Requires the ANTHROPIC_API_KEY secret (Project Settings -> Edge Functions
// -> Secrets), same as agent-chat. All Anthropic-specific code lives in
// this one file by design (see AGENT_ARCHITECTURE.md).
//
// Gated to authenticated admin sessions only, since a real pass costs real
// tokens and makes real (staged) database writes. Never call this from a
// public/unauthenticated page.

import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import jpeg from "npm:jpeg-js@0.4.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Resolves the public/anon-equivalent key across both the legacy single-key
// shape and the newer publishable-keys dictionary shape (mirrors
// getServiceRoleKey() below, for the same reason). Same helper as agent-chat.
function getPublicKey(): string {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacy) return legacy;
  const dict = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (dict) {
    const parsed = JSON.parse(dict) as Record<string, string>;
    const val = Object.values(parsed)[0];
    if (val) return val;
  }
  throw new Error("No Supabase publishable/anon key found in the environment");
}
const SUPABASE_ANON_KEY = getPublicKey();

function getServiceRoleKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (dict) {
    const parsed = JSON.parse(dict) as Record<string, string>;
    const val = Object.values(parsed)[0];
    if (val) return val;
  }
  throw new Error("No Supabase service-role key found in the environment");
}
// Service-role client -- this function needs to write staged/pending-review
// rows regardless of who's watching, and only ever touches the same tables
// a human admin can already reach through Archivist's Drafts. Never exposed
// to the browser.
const adminDb = createClient(SUPABASE_URL, getServiceRoleKey());

const anthropic = new Anthropic();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Narrative/citation fields only. modcrApproveRevision (HTMLs/modcr-client.js)
// applies an approved revision by appending proposed_text to the field's
// current value with a newline -- exactly right for a dated citation line,
// exactly wrong for a singular-value field (dimensions, medium, tag, series,
// date_display), which it would corrupt into two values glued together. A
// singular-value fact goes through log_work_source + the final summary
// instead, for a human to type directly into Manage Works.
const REVISABLE_FIELDS = [
  "exhibitions",
  "literature",
  "provenance",
  "remarks",
  "flag",
  "revisions",
] as const;

const SYSTEM_PROMPT = `You are Khalo, the Associate Archivist for the Michele Oka Doner Catalogue Raisonné project, running your automated Mode B pass: given one uploaded source document (a catalog PDF, a set of page images extracted from one, or the extracted text of a single pasted web page — an auction lot, gallery, or press page — all sharing one citation anchor), find every MOD work it mentions or depicts and write findings into draft/staging records — never into a live work directly, never published.

## What you were given
The first user message contains: the citation anchor (a real URL, when this source is a pasted link, or a publication/document name otherwise) to use for every citation from this document, a full current listing of the \`works\` table and the \`staged_works\` table (id, CR#/title, date, medium, tag/series, status) to match against, the valid \`materials.slug\` and \`series.slug\` taxonomy values, and then the actual source content — either native PDF/image content (read all of it, every page, not just the cover or index) or the extracted text of a single web page, marked with [IMAGE #N] where a photo appeared in the page's own markup — a downloaded candidate for some of those numbers may follow as its own image content block (see rule 8 below), when the page had real photos worth fetching. A single pasted link is exactly one page's worth of content — treat it the same as Mode A researching a lead, not as a multi-page catalog to mine exhaustively.

## Write as you go — do not save it all for one big summary at the end
Read, then act, work by work — never read the entire document first and only describe what you found afterward. The moment you're confident about one work, call the tool for it immediately (get_work/get_staged_work to check, then log_work_source/propose_work_revision/create_staged_work/update_staged_work to record it), then move to the next work. A message that only narrates candidates in prose without calling the matching tool has not accomplished anything — narrating "CR 12 should get a citation" is not the same as calling log_work_source for CR 12, and this run will explicitly reject a finish call that describes findings you never actually logged. If the document is long, that's fine — you have many tool-call turns; use them to work through it incrementally, not to produce one exhaustive essay before you've written a single row.

## For every work the document names or depicts
1. Try to match it against BOTH the \`works\` listing and the \`staged_works\` listing given to you (title, date, medium — confirm a fuzzy title match against date/medium before treating it as the same work, never on title alone). Checking \`works\` alone and missing an existing staged draft is exactly how a duplicate New Entries row happens. When a candidate feels like it MIGHT already exist under a different title/phrasing (a re-listed lot, a nickname vs. formal title, a near-identical sibling piece) and the plain listing doesn't settle it, call search_similar_works with a short description of the piece before deciding it's genuinely new.
2. **Matches an existing work, confidently** — call get_work to see its full current fields and existing citations (don't re-cite something already logged, and don't propose text that contradicts what's already there — if it would contradict, log a flagged work_source instead and leave the field alone). Log every extracted fact with log_work_source. For append-safe narrative facts (see REVISABLE_FIELDS in the propose_work_revision tool), also call propose_work_revision so it reaches a human via the Revisions tab. For a singular-value fact (a dimension, a medium/tag/series correction, a date), log it via log_work_source only — mention it by CR number in your final summary so a human can enter it directly in Manage Works.
3. **Matches an existing staged_works draft** (status new/reviewing) — call get_staged_work, then call update_staged_work with whatever new facts this document adds and an append_note carrying a dated, cited addition. Never create a second staged row for something already staged.
4. **Matches, but ambiguously** (close title, nothing to confirm date/medium against, or the document doesn't clearly distinguish two similarly-named works) — log_work_source only, confidence: flagged, and propose_work_revision with field: flag pointing at the ambiguity (e.g. "Possible [publication] citation, unverified — see Work Sources"). Never propose a revision to the real content field for a flagged match.
5. **Not in either table at all** — call create_staged_work. This is the New Entries tab; never invent a cr_number.
6. **Every work touched in steps 2-5 — matched or newly staged — gets this document logged as a Publications/Literature citation too**, not just whatever field prompted the match. Format every citation uniformly: publication/document title, and a page number whenever you have one (a page-image row's own filename/notes tag it directly — never drop it when it's right there). "Mentioned in [document]" is not a citation; "[Publication/Document], p. [N]" is, same shape every time.
7. **Read each page's own text for what it says, not just what it's attached to.** A catalog entry's prose routinely references OTHER exhibitions or publications this same work has appeared in ("previously exhibited at...", "as illustrated in..."). Treat each such mention as its own citable fact for that work — log and, where append-safe, propose it too. A single page can legitimately add several citations to one work.
8. **Photos**:
   - *Pasted-link source*: a downloaded candidate photo (when one was found and fetched) appears as its own image content block right after the extracted text, each one labeled with which [IMAGE #N] marker it corresponds to and the real URL it came from — look at it the same way you'd look at a PDF page image. Position near a lot's description is a hint about which work a candidate belongs to, never proof by itself: confirm the picture actually matches the work's medium/form/other stated details before treating it as verified, and ignore a candidate that's clearly page furniture (a logo, an unrelated thumbnail, a different lot) rather than assuming the nearest marker number is automatically right. When a candidate IS a confirmed, real photo of the specific work, its own URL (not a marker number) goes directly into image_url (create_staged_work/update_staged_work). A full extracted image that's already a tight, clean crop of just the work is fine to set directly this way — but "tight crop" and "good enough quality" are two separate checks, do both. A phone photo of a printed catalog page (visible halftone dots, moiré pattern, blur, glare, or generally low resolution) is real, common source material — usable, never silently discarded — but flag the quality issue (see below) rather than attaching it silently as if it were a clean source. When a candidate is merely plausible — near the right lot's text but not confirmed, or ambiguous among more than one nearby image — pass it as candidate_photo_url (with candidate_photo_note explaining the uncertainty) instead of guessing it into image_url; this logs it to that draft's review bullpen for a human to check rather than silently discarding a real maybe. Ignore anything clearly unrelated entirely — don't log that as a candidate either.
   - *Catalog/PDF source (native PDF read, or pre-extracted page images from scripts/catalog_pdf_extractor.py, each its own source_materials row with kind:'image')*: there is no separately-hosted URL for a work's photo here — it only exists as pixels on a page. Use attach_staged_work_photo, pointed at the specific source_materials image row (its id is given to you alongside that page's content). This only works against a kind:'image' row — a raw kind:'pdf' row's pages haven't been extracted yet and can't be cropped by this tool; if extraction hasn't happened, treat it exactly like having no photo at all (flag "Needs a source image:", below). Always crop tightly around just the artwork — never leave a caption strip, a second unrelated work sharing the page, or a border/mat/page background in frame; omit crop entirely only when the whole image is already nothing but the work. Use confidence:'confirmed' ONLY for an explicit, unambiguous signal: a caption directly naming this exact work next to its photo, or a table-of-contents/List-of-Works page mapping this exact title to this exact page number together with a clear photo on that page. Use confidence:'candidate' for anything short of that but still plausible (same page/spread as the work's mentioned, no explicit caption, ambiguous among several images on the page) — it lands in the draft's review bullpen instead of being silently discarded or wrongly auto-placed. Never call this tool at all for an image that's clearly unrelated to any work (decoration, a logo, a different already-placed work) — skip it entirely rather than logging noise as a candidate.
   - *Either path, for an EXISTING (already-published) work*: any candidate photo is still just a candidate regardless of source or quality — never set image_url on a live work yourself and never call attach_staged_work_photo or pass candidate_photo_url for one (both only ever touch staged_works); note it for human review via a flagged work_source instead.
   - Whenever a work ends up with no usable photo at all — nothing confirmed, not even a candidate — propose_work_revision on field: flag with a line starting exactly "Needs a source image:" plus what's missing and why (or append_note with that same line, for a staged candidate). Whenever a photo IS attached/set but isn't a clean tight crop, or is usable but visibly low-quality (blurry, low-resolution, moiré/halftone pattern from photographing a printed page, glare), use a line starting exactly "Needs a cleaner photo:" describing specifically which issue applies — same placement rules as the source-image note. Never attach a genuinely wrong-work or unverifiable image just to fill the field — an unset image renders as a clean placeholder on purpose — but a verified-correct, merely-lower-quality image is worth keeping (with the flag), not something to withhold.
9. **Not a priority for now: exhaustively mining essay prose for every incidental title or other-exhibition mention.** Call log_citation when a title has some concrete anchor to this document (its own captioned plate, a List of Works/checklist line, a figure number) — not for a bare name floating in a curatorial essay's prose with nothing pinning it to a specific page/plate/photo. That kind of broad, low-signal essay-mining is a real capacity (log_citation and the citation index exist for exactly this), but it's bracketed for a later pass, not this one — the core job here is identifying and photographing the artworks this document actually depicts and citing this document for each one (rule 6); don't spend tool calls chasing a passing essay mention at the expense of working through the actual plates/photos. Still call log_citation for a work you're already confidently handling in steps 2-5, same as always (that's not extra essay-mining, it's just recording the anchor you already have).

## Field extraction protocol
Extract into structured fields, never leave a fact sitting only in prose: Title (an auction/gallery listing routinely comes as one compound string like \`"Faucet," 1986, cast bronze\` — the title field gets ONLY the name, \`Faucet\`, with the date and medium pulled out into date_display/year/medium instead; a trailing year or material after a comma, in parentheses, or after the closing quote is exactly the pattern to strip, every time, not just when it's convenient. An object-first listing puts the real name in quotes instead, with the object type or edition/gallery info wrapped around it — \`Chaise 'For Eve', edition David Gill Gallery\` or \`"Coral Wave" chair\`: the title is ONLY the quoted phrase (\`For Eve\`, \`Coral Wave\`), and everything outside the quotes — the object type, edition/gallery info — moves into medium instead, never left in title. Only pull this apart when the quotes clearly wrap a proper name distinct from the surrounding description; a lone apostrophe (a possessive like "Horace's Muse") is not this pattern and title stays as-is. If the source gives no real name at all — only a bare material/date description like "cast bronze and crystal work, c. 2005" — do not carry that description into title as if it were a name; use \`Untitled\` for title and put the real description in medium/notes instead), Date (date_display as the source states it, year as a plain number), Material (medium = descriptive label — including any object-type/edition text pulled out of the title per the rule above, folded in rather than dropped — tag = the matching materials.slug — never invent one, see the tag/series rules below), Dimensions (as stated), Series (the most specific series.slug that fits — a named sub-series before a broad bucket; never set a work's own series to early-clay unless its tag is literally ceramic, per the cross-categorization rule: a ceramic work dated before 2000 shows under Early Clay automatically via live filter logic, it does not need series set to early-clay directly), Provenance (dated ownership chain; for a museum listing, state plainly whether it's a permanent-collection holding or a past loan/exhibition, and record acquisition year/method if given), Exhibitions (venue, exhibition title, city, date, and curator name if listed), Publications/Literature (see citation format above).

## Title source and photo matching
A title is a sourced claim, never inferred from an image — always set title_source alongside title on create_staged_work/update_staged_work (which document, and where on it: "auction lot heading, [sale]", "caption beneath plate, [catalog] p.[N]"). Recognize a title by its position in the source, not just how it reads: an auction/lot listing's bolded heading above/below the lot number is the title, never the medium/dimensions/estimate line below it; a gallery/museum page's largest heading is the title, body prose explaining meaning or history is description even when it's the only text present; a printed catalog's title sits under/beside its own plate/figure number, and a later prose mention of that same title elsewhere is a citation of it, not an independent second source. When two sources genuinely disagree on a title, don't silently pick one — set title/title_source from the primary one and record the disagreement in notes/append_note as "Alternate title: '[X]' per [source]". Anchor every photo match to the source document (same page, same lot, same plate) never to visual similarity — MOD's body of work includes many visually related pieces, so a look-alike match is exactly how the wrong photo lands on the wrong entry; an image that merely shows a work incidentally (an installation shot, an archival photo with several pieces visible) is not that work's own photo.

## Tag and series classification rules
Headlines only — the full rules (and every future addition to them) live in CLAUDE.md's "Tag/series inference rules" section and are kept queryable via search_classification_rules rather than repeated here in full every time: tag is always the base material alone, never a compound phrase (organic-material is last resort, never preferred over a more specific match in the same medium string); a wearable metal object (necklace, brooch, pendant, ring, bracelet, earring, cuff) is jewelry, everything else metal is bronze-works (Sculpture) regardless of the material being precious; all clay/ceramic work defaults to bronze-works unless a more specific named sub-series clearly fits; never invent a tag for a material not in the taxonomy given to you — leave tag/suggested_series unset and flag it for a human decision instead. **Call search_classification_rules whenever a material/series call isn't obviously covered by this summary** (an unfamiliar material, an edge case, a series question) rather than guessing from the headline alone.

## Hard rules
- Never write to a \`works\` row directly, never set published, never assign a cr_number. Your only writes are work_sources, staged_works (via the tools), and work_revisions (pending, for a human to approve).
- Never attach a third-party image without confirming it actually depicts this specific work.
- Never invent a source. If nothing turns up on a page, that's a valid, honest result — log nothing rather than a plausible-sounding guess.
- Cite specifically — the actual page/document and the actual claim, not "found in the catalog."

## Confidence
confirmed = a primary/authoritative statement unambiguously about this exact work. flagged = plausible but unverified, or an ambiguous match. rejected = checked and ruled out (log it anyway so a future pass doesn't reinvestigate the same dead end).

## Finishing
When you have gone through every page/image given to you, call the finish tool exactly once with an honest outcome and a per-work summary (which CR numbers were confirmed/updated, which flagged, which staged as new, and any singular-value facts a human needs to enter directly) — never a bare total count, and never claim the document is "fully mined": archival research is current as of this pass, not complete.`;

// ---- Tool schemas ---------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_work",
    description:
      "Fetch one live `works` row in full, plus its existing work_sources citations, so you can confirm a candidate match against real detail (dates, current provenance/exhibitions text, current flag) before deciding confirmed vs. flagged, and so you don't re-log something already cited.",
    input_schema: {
      type: "object",
      properties: {
        work_id: { type: "string", description: "The works.id (uuid) to fetch." },
      },
      required: ["work_id"],
    },
  },
  {
    name: "get_staged_work",
    description:
      "Fetch one staged_works row in full, so you can check its current fields/notes before deciding whether this document adds anything new to it.",
    input_schema: {
      type: "object",
      properties: {
        staged_id: { type: "string", description: "The staged_works.id (uuid) to fetch." },
      },
      required: ["staged_id"],
    },
  },
  {
    name: "log_work_source",
    description:
      "Log one specific, cited finding about an EXISTING live work to work_sources. Use this for every fact you extract about a work already in `works` — including facts you also propose as a revision (log first, then pass its returned id as source_id) and facts you are NOT proposing as a revision (a flagged/ambiguous match, or a singular-value fact like a dimension or medium correction a human should type in directly rather than have auto-appended).",
    input_schema: {
      type: "object",
      properties: {
        work_id: { type: "string" },
        url: {
          type: "string",
          description:
            'A real URL, or for a document with no URL, the citation anchor: the publication/document name plus a page number if you have one, e.g. "PAMM exhibition catalog, 2019, p. 14".',
        },
        source_type: {
          type: "string",
          enum: ["auction", "gallery", "museum", "press", "publication", "other"],
        },
        field: {
          type: "string",
          description:
            "Which kind of fact this is, e.g. exhibitions, literature, provenance, dimensions, medium, date_display, tag, series — whatever it actually is.",
        },
        finding: {
          type: "string",
          description: "The specific claim, formatted as a real citation per the field extraction protocol — not a vague summary.",
        },
        confidence: { type: "string", enum: ["confirmed", "flagged", "rejected"] },
      },
      required: ["work_id", "url", "source_type", "field", "finding", "confidence"],
    },
  },
  {
    name: "propose_work_revision",
    description:
      `Propose an addition to an EXISTING work's narrative field, for a human to approve in the Revisions tab. Only for these append-safe fields: ${REVISABLE_FIELDS.join(", ")} — approving a revision appends proposed_text to the field's current text with a newline, which is correct for a dated citation/note and would corrupt a singular-value field (title, dimensions, medium, tag, series, date_display) by gluing two values together. For any singular-value fact, use log_work_source instead and name it in your final summary. Never call this to propose text that contradicts what's already on the work — log a flagged work_source and leave the field alone instead.`,
    input_schema: {
      type: "object",
      properties: {
        work_id: { type: "string" },
        field: { type: "string", enum: [...REVISABLE_FIELDS] },
        proposed_text: {
          type: "string",
          description:
            'A complete, dated, human-readable line ready to append as-is, e.g. "2019: Exhibited in [Exhibition Title], Perez Art Museum Miami (PAMM exhibition catalog, 2019, p. 14)."',
        },
        source_id: {
          type: "string",
          description: "The work_sources.id returned by your log_work_source call for this same finding.",
        },
      },
      required: ["work_id", "field", "proposed_text", "source_id"],
    },
  },
  {
    name: "create_staged_work",
    description:
      "Stage a brand-new candidate work this document depicts/names that isn't in `works` or `staged_works` yet. Lands in Archivist's Drafts > New Entries for human review. Never assign a cr_number — that only happens on import.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        title_source: {
          type: "string",
          description: "Which document produced this title, and where on it -- e.g. \"auction lot heading, Wright sale #487\", \"caption beneath plate, PAMM catalog p.19\". A title is a sourced claim, never inferred from an image -- always set this alongside title.",
        },
        date_display: { type: "string" },
        year: { type: "integer" },
        medium: { type: "string" },
        tag: { type: "string", description: "Must match a real materials.slug from the taxonomy given to you — never invent one." },
        suggested_series: {
          type: "string",
          description: "Must match a real series.slug from the taxonomy given to you, the most specific tier that genuinely fits.",
        },
        dimensions: { type: "string" },
        image_url: {
          type: "string",
          description:
            "Only set this if you have a real, verified, tightly-cropped, right-work image already sized per this project's convention (72dpi, max 2200px) -- for a pasted-link source's own confirmed photo (see rule 8). Leave unset otherwise — a source-image request note in notes is correct instead of a guess, or use candidate_photo_url below for a plausible-but-unconfirmed pasted-link photo. For a catalog/PDF source, use attach_staged_work_photo after creating this draft instead — a PDF page's photo has no hostable URL to put here directly.",
        },
        candidate_photo_url: {
          type: "string",
          description: "A plausible-but-unconfirmed pasted-link photo's URL (see rule 8) -- logged to this draft's review bullpen instead of guessed into image_url. Pair with candidate_photo_note.",
        },
        candidate_photo_note: { type: "string", description: "Briefly, why this candidate photo isn't confirmed." },
        source_url: { type: "string", description: "Citation anchor for this document (filename/label + page number if known)." },
        notes: { type: "string", description: "Why this reads as a genuine, previously uncatalogued work — cite specifically." },
      },
      required: ["title", "notes", "source_url"],
    },
  },
  {
    name: "update_staged_work",
    description:
      "Update an EXISTING staged_works draft this document adds to — never create a second staged row for something already staged. Pass only the fields you're changing; append_note is added as a new dated line to notes, never replacing what's there.",
    input_schema: {
      type: "object",
      properties: {
        staged_id: { type: "string" },
        title_source: { type: "string", description: "Same as create_staged_work's title_source -- set/correct this whenever this document adds or clarifies where the title came from." },
        date_display: { type: "string" },
        year: { type: "integer" },
        medium: { type: "string" },
        tag: { type: "string" },
        suggested_series: { type: "string" },
        dimensions: { type: "string" },
        image_url: { type: "string" },
        candidate_photo_url: {
          type: "string",
          description: "A plausible-but-unconfirmed pasted-link photo's URL (see rule 8) -- appended to this draft's review bullpen instead of guessed into image_url. Pair with candidate_photo_note.",
        },
        candidate_photo_note: { type: "string", description: "Briefly, why this candidate photo isn't confirmed." },
        append_note: { type: "string", description: "A new dated, cited line to add to this draft's notes." },
      },
      required: ["staged_id"],
    },
  },
  {
    name: "log_citation",
    description:
      "Log a work mention into the standing citation index — call this for EVERY MOD work this document names or depicts, not just the one(s) confidently matched/staged in this pass. This builds a searchable record so a later entry for that title (created manually on Intake, or staged separately in a future pass) arrives already primed with everything ever said about it, even a passing mention that wasn't itself confident enough to match or stage a work. Always call this IN ADDITION TO, never instead of, the get_work/get_staged_work/log_work_source/create_staged_work/update_staged_work calls for a confident match — this is a supplementary index, not a replacement for those.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The work's title exactly as it appears in this source." },
        citation_kind: { type: "string", enum: ["publication", "exhibition", "provenance", "auction", "other"] },
        citation_text: {
          type: "string",
          description: "The actual citation content, formatted as a real citation -- a provenance line, an exhibition line, a literature reference, an auction record.",
        },
        source_url: { type: "string", description: "Citation anchor for this document (filename/label + page number if known), or a real URL." },
        work_id: { type: "string", description: "Set only if this title is confidently matched to a live work you've already confirmed via get_work." },
        staged_work_id: { type: "string", description: "Set only if this title is confidently matched to an existing staged draft you've already confirmed via get_staged_work." },
      },
      required: ["title", "citation_kind", "citation_text", "source_url"],
    },
  },
  {
    name: "attach_staged_work_photo",
    description:
      "Attach a photo to a staged_works draft, cropped from an already-extracted catalog page image (a source_materials row with kind:'image' -- e.g. from scripts/catalog_pdf_extractor.py). Does NOT work on a raw kind:'pdf' row directly -- extraction must already have produced individual page images. Crop out anything that isn't the work itself before attaching. confidence:'confirmed' sets the draft's real photo directly -- use ONLY for an explicit, unambiguous signal (a caption naming this exact work next to its photo, or a table-of-contents/List-of-Works page number match). confidence:'candidate' logs it to the draft's review bullpen instead -- use for anything plausible but short of that bar. See rule 8 for the full guidance.",
    input_schema: {
      type: "object",
      properties: {
        staged_work_id: { type: "string" },
        source_material_id: { type: "string", description: "The source_materials.id (kind:'image') holding the page image to crop from." },
        crop: {
          type: "object",
          description: "Normalized (0-1) crop box within that image, tightly around just the artwork. Omit only when the whole image is already nothing but the work.",
          properties: {
            x: { type: "number", description: "Left edge, 0-1 fraction of image width." },
            y: { type: "number", description: "Top edge, 0-1 fraction of image height." },
            width: { type: "number", description: "0-1 fraction of image width." },
            height: { type: "number", description: "0-1 fraction of image height." },
          },
        },
        confidence: { type: "string", enum: ["confirmed", "candidate"] },
        note: { type: "string", description: "For confidence:'candidate' only -- briefly, why this is a maybe, not a certainty." },
      },
      required: ["staged_work_id", "source_material_id", "confidence"],
    },
  },
  {
    name: "search_classification_rules",
    description:
      "Semantic search over CLAUDE.md's full tag/series classification rules (the Tag and series classification rules section above is headlines only). Call this whenever a material/series call isn't obviously covered by those headlines -- an unfamiliar material, a series edge case, anything you're not confident about -- with a short natural-language description of the situation, e.g. 'brass material with no known slug' or 'post-2000 ceramic series bucket'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short description of the material/series situation you need a rule for." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_similar_works",
    description:
      "Semantic search across works and/or staged_works by meaning (title, date, medium, series, notes) rather than exact/fuzzy title matching -- use this before create_staged_work when a candidate feels like it MIGHT already exist under a different title or phrasing (a duplicate lot re-listed, a nickname vs. formal title, a near-identical sibling piece), or when checking whether a similar work has already been classified a certain way. Complements, never replaces, the works/staged_works listing already given to you.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short natural-language description of the candidate work (title, medium, date, distinguishing details)." },
        collection: { type: "string", enum: ["works", "staged_works", "both"], description: "Defaults to both." },
      },
      required: ["query"],
    },
  },
  {
    name: "finish",
    description:
      "Call this exactly once, when you are done processing every page/image given to you. Ends the run and writes your summary to the source_materials row(s).",
    input_schema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["matched", "flagged", "rejected"],
          description: "matched = at least one confirmed/updated/newly-staged finding. flagged = only ambiguous matches. rejected = no MOD works found in it after all.",
        },
        summary: {
          type: "string",
          description:
            'Per-work outcomes across the whole document, e.g. "confirmed on CR 12 and CR 47 (page-cited literature entries added), flagged on CR 9 (ambiguous title match), one new candidate staged (\'Untitled bronze form\', p. 22, needs a source image)." Not a vague total count.',
        },
      },
      required: ["outcome", "summary"],
    },
    // Last tool in the array -- a cache_control breakpoint here caches the
    // entire (large, static) tool schema list, same rationale as the system
    // prompt breakpoint in runPass(). Anthropic's prompt caching caches
    // everything up to and including the marked block.
    // deno-lint-ignore no-explicit-any
    cache_control: { type: "ephemeral" } as any,
  },
];

// ---- Tool execution ---------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function execTool(name: string, input: any, sourceMaterialId: string | null): Promise<unknown> {
  switch (name) {
    case "get_work": {
      const { data: work, error } = await adminDb.from("works").select("*").eq("id", input.work_id).maybeSingle();
      if (error) throw error;
      if (!work) return { error: "No work with that id." };
      const { data: sources } = await adminDb
        .from("work_sources")
        .select("url, source_type, field, finding, confidence, accessed_at")
        .eq("work_id", input.work_id)
        .order("accessed_at", { ascending: false });
      return { work, existing_sources: sources ?? [] };
    }
    case "get_staged_work": {
      const { data, error } = await adminDb.from("staged_works").select("*").eq("id", input.staged_id).maybeSingle();
      if (error) throw error;
      return data ? { staged_work: data } : { error: "No staged_works row with that id." };
    }
    case "log_work_source": {
      const { data, error } = await adminDb
        .from("work_sources")
        .insert({
          work_id: input.work_id,
          url: input.url,
          source_type: input.source_type,
          field: input.field,
          finding: input.finding,
          confidence: input.confidence,
        })
        .select()
        .single();
      if (error) throw error;
      return { work_source_id: data.id };
    }
    case "propose_work_revision": {
      if (!(REVISABLE_FIELDS as readonly string[]).includes(input.field)) {
        return { error: `field must be one of: ${REVISABLE_FIELDS.join(", ")}` };
      }
      const { data, error } = await adminDb
        .from("work_revisions")
        .insert({
          work_id: input.work_id,
          field: input.field,
          proposed_text: input.proposed_text,
          source_id: input.source_id ?? null,
          status: "pending",
        })
        .select()
        .single();
      if (error) throw error;
      return { work_revision_id: data.id };
    }
    case "create_staged_work": {
      const { data, error } = await adminDb
        .from("staged_works")
        .insert({
          title: input.title,
          title_source: input.title_source ?? null,
          date_display: input.date_display ?? null,
          year: input.year ?? null,
          medium: input.medium ?? null,
          tag: input.tag ?? null,
          suggested_series: input.suggested_series ?? null,
          dimensions: input.dimensions ?? null,
          image_url: input.image_url ?? null,
          candidate_photos: input.candidate_photo_url
            ? [{ url: input.candidate_photo_url, note: input.candidate_photo_note ?? null, added_at: new Date().toISOString() }]
            : [],
          source_url: input.source_url,
          source_type: "publication",
          confidence: "candidate",
          status: "new",
          notes: input.notes,
          // So Researcher's Desk can show "this document produced N drafts"
          // directly, instead of that only being discoverable by reading the
          // row's own prose summary -- see the migration for why this is a
          // column on staged_works (one source can stage many works) rather
          // than the reverse.
          source_material_id: sourceMaterialId,
        })
        .select()
        .single();
      if (error) throw error;
      return { staged_work_id: data.id };
    }
    case "update_staged_work": {
      // deno-lint-ignore no-explicit-any
      const patch: Record<string, any> = {};
      for (const k of ["title_source", "date_display", "year", "medium", "tag", "suggested_series", "dimensions", "image_url"]) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (input.append_note || input.candidate_photo_url) {
        const { data: current, error: fetchErr } = await adminDb
          .from("staged_works")
          .select("notes, candidate_photos")
          .eq("id", input.staged_id)
          .single();
        if (fetchErr) throw fetchErr;
        if (input.append_note) {
          patch.notes = current?.notes ? `${current.notes}\n\n${input.append_note}` : input.append_note;
        }
        if (input.candidate_photo_url) {
          const existing = Array.isArray(current?.candidate_photos) ? current.candidate_photos : [];
          patch.candidate_photos = [
            ...existing,
            { url: input.candidate_photo_url, note: input.candidate_photo_note ?? null, added_at: new Date().toISOString() },
          ];
        }
      }
      patch.updated_at = new Date().toISOString();
      const { error } = await adminDb.from("staged_works").update(patch).eq("id", input.staged_id);
      if (error) throw error;
      return { ok: true };
    }
    case "log_citation": {
      const { data, error } = await adminDb
        .from("work_citations")
        .insert({
          title_raw: input.title,
          normalized_title: String(input.title).toLowerCase().trim(),
          citation_kind: input.citation_kind,
          citation_text: input.citation_text,
          source_url: input.source_url,
          source_material_id: sourceMaterialId,
          work_id: input.work_id ?? null,
          staged_work_id: input.staged_work_id ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      return { citation_id: data.id };
    }
    case "attach_staged_work_photo": {
      const { data: sourceRow, error: srcErr } = await adminDb
        .from("source_materials")
        .select("kind, storage_path")
        .eq("id", input.source_material_id)
        .maybeSingle();
      if (srcErr) throw srcErr;
      if (!sourceRow || sourceRow.kind !== "image" || !sourceRow.storage_path) {
        return {
          error:
            "source_material_id must reference an existing source_materials row with kind:'image' and a storage_path -- a raw kind:'pdf' row can't be cropped directly by this tool; extraction (scripts/catalog_pdf_extractor.py) must produce page images first.",
        };
      }
      const { data: fileBlob, error: dlErr } = await adminDb.storage.from("source-materials").download(sourceRow.storage_path);
      if (dlErr || !fileBlob) return { error: `Could not download source image: ${dlErr?.message ?? "unknown error"}` };
      let bytes = new Uint8Array(await fileBlob.arrayBuffer());
      if (input.crop) {
        try {
          bytes = cropJpeg(bytes, input.crop);
        } catch (err) {
          // Fail open -- attach the full, uncropped image rather than lose
          // the photo entirely over a crop error. Surfaced in the return
          // value so the model can mention it wasn't cropped as requested.
          console.error("attach_staged_work_photo: crop failed, using full image:", err);
        }
      }
      const path = `${input.staged_work_id}/${crypto.randomUUID()}.jpg`;
      const { error: upErr } = await adminDb.storage.from("staged-work-photos").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (upErr) return { error: `Could not upload photo: ${upErr.message}` };
      const { data: pub } = adminDb.storage.from("staged-work-photos").getPublicUrl(path);
      const publicUrl = pub.publicUrl;

      if (input.confidence === "confirmed") {
        const { error } = await adminDb
          .from("staged_works")
          .update({ image_url: publicUrl, updated_at: new Date().toISOString() })
          .eq("id", input.staged_work_id);
        if (error) throw error;
        return { attached: true, image_url: publicUrl };
      } else {
        const { data: current, error: fetchErr } = await adminDb
          .from("staged_works")
          .select("candidate_photos")
          .eq("id", input.staged_work_id)
          .single();
        if (fetchErr) throw fetchErr;
        const candidates = Array.isArray(current?.candidate_photos) ? current.candidate_photos : [];
        candidates.push({ url: publicUrl, note: input.note ?? null, source_material_id: input.source_material_id, added_at: new Date().toISOString() });
        const { error } = await adminDb
          .from("staged_works")
          .update({ candidate_photos: candidates, updated_at: new Date().toISOString() })
          .eq("id", input.staged_work_id);
        if (error) throw error;
        return { logged_as_candidate: true, image_url: publicUrl };
      }
    }
    case "search_classification_rules": {
      const result = await callKnowledgeIndex("search", { collection: "claude_md", query: input.query, top_k: 3 });
      if (result.error) return { error: result.error };
      return { rules: result.matches };
    }
    case "search_similar_works": {
      const collections = input.collection === "works" || input.collection === "staged_works" ? [input.collection] : ["works", "staged_works"];
      const results: Record<string, unknown> = {};
      for (const c of collections) {
        const result = await callKnowledgeIndex("search", { collection: c, query: input.query, top_k: 5 });
        results[c] = result.error ? { error: result.error } : result.matches;
      }
      return results;
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function appendNote(existing: string | null | undefined, line: string): string {
  return existing ? `${existing}\n\n${line}` : line;
}

// Pure-JS JPEG decode/crop/re-encode -- no native bindings, safe to run in
// the Edge Function's sandboxed Deno runtime (which can't load an arbitrary
// native PDF/image library the way a local script running PyMuPDF/Pillow
// could -- see scripts/catalog_pdf_extractor.py's own docstring on exactly
// this constraint). Only ever called on an already-extracted, already-flat
// page image -- never asked to rasterize a PDF page itself, which is a much
// harder problem this function deliberately does not attempt.
function cropJpeg(bytes: Uint8Array, crop: { x: number; y: number; width: number; height: number }): Uint8Array {
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const srcW = decoded.width, srcH = decoded.height;
  const x = Math.max(0, Math.min(srcW - 1, Math.round(crop.x * srcW)));
  const y = Math.max(0, Math.min(srcH - 1, Math.round(crop.y * srcH)));
  const w = Math.max(1, Math.min(srcW - x, Math.round(crop.width * srcW)));
  const h = Math.max(1, Math.min(srcH - y, Math.round(crop.height * srcH)));
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOffset = ((y + row) * srcW + x) * 4;
    out.set(decoded.data.subarray(srcOffset, srcOffset + w * 4), row * w * 4);
  }
  const encoded = jpeg.encode({ data: out, width: w, height: h }, 88);
  return new Uint8Array(encoded.data);
}

// (Reverted -- see below) A prior fix here decoded/resampled/re-encoded
// each JPEG server-side to dodge Anthropic's many-image size cap. Confirmed
// via function_logs that this is exactly what killed a real 56-page batch:
// "CPU Time exceeded" a few seconds after boot, well before the first
// Anthropic call -- Supabase's per-invocation CPU budget, not its wall-clock
// ceiling (the thing runPass's own batching already protects against), and
// nothing in buildInitialCheckpoint's pre-loop phase has any protection
// against that at all. A pure-JS pixel-by-pixel resample, run synchronously
// dozens of times in one invocation, is exactly the kind of CPU-bound work
// that blows a strict CPU quota in seconds even though it's fast in wall-clock
// terms. The real fix now lives where the images are actually produced --
// modcrExtractPdfPages (modcr-client.js) renders each page at a resolution
// already safe for Anthropic's many-image cap, so no server-side resize step
// is needed here at all.

// ---- The actual pass, run in the background --------------------------------

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// A real lot/listing photo's URL is routinely disqualified by nothing more
// than being a logo, icon, or 1x1 tracking pixel sitting elsewhere on the
// same page -- filter those out before ever spending a fetch on them.
// Deliberately conservative (a false negative just means one fewer
// candidate; a false positive wastes a fetch and a look, not a mistake).
function looksLikeSiteChrome(url: string): boolean {
  return /\b(logo|icon|favicon|sprite|spinner|loading|placeholder|avatar|badge|pixel|blank|1x1|tracking|social)\b/i.test(url);
}

// Same "strip tags to plain text" pass as before, except an <img> tag is
// replaced with an inline [IMAGE #N] marker instead of just vanishing --
// this is the only positional signal Khalo gets for matching a downloaded
// candidate photo (pushed as a separate image content block, see
// buildInitialCheckpoint) back to the specific lot/work description it
// appeared next to on the page. No DOM parser, so "next to" is approximate
// (reading order of the raw markup, not rendered layout) -- exactly why the
// system prompt requires confirming the match against the surrounding text,
// never trusting position alone.
function extractTextAndImages(html: string, baseUrl: string): { text: string; candidates: { n: number; url: string }[] } {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const candidates: { n: number; url: string }[] = [];
  let n = 0;
  const withMarkers = noScripts.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\b(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["']/i);
    const srcsetMatch = tag.match(/\bsrcset\s*=\s*["']([^"'\s]+)/i);
    const raw = srcMatch?.[1] ?? srcsetMatch?.[1];
    if (!raw || raw.startsWith("data:")) return " ";
    let resolved: string;
    try {
      resolved = new URL(raw, baseUrl).toString();
    } catch {
      return " ";
    }
    if (looksLikeSiteChrome(resolved)) return " ";
    n++;
    candidates.push({ n, url: resolved });
    return ` [IMAGE #${n}] `;
  });
  const noTags = withMarkers.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(noTags);
  return { text: decoded.replace(/\s+/g, " ").trim(), candidates };
}

// Edge Functions have a hard wall-clock ceiling regardless of
// EdgeRuntime.waitUntil() -- 150s on the Free plan, 400s on paid (see
// https://supabase.com/docs/guides/troubleshooting/edge-function-wall-clock-time-limit-reached-Nk38bW).
// A real agentic pass over a full document routinely exceeds that: the
// first live run got silently killed mid-flight, stuck at status
// 'processing' forever with no chance for any cleanup code to run. Rather
// than fight the platform limit, this batches the loop -- each invocation
// runs for a bounded time/iteration budget, then checkpoints its full
// conversation state and hands off to a fresh invocation of itself to
// continue, repeating until finish is actually called or a hard safety
// cap is hit. BATCH_WALL_CLOCK_BUDGET_MS is deliberately conservative
// (well under even the Free-plan ceiling) to leave room for the checkpoint
// write and handoff call themselves to complete before the platform kills
// the invocation.
const BATCH_WALL_CLOCK_BUDGET_MS = 100_000;
const MAX_BATCH_ITERATIONS = 30;
// Circuit breaker across the WHOLE checkpoint chain, not just one batch --
// bounds worst-case cost if a document is pathological and never converges
// on calling finish.
const MAX_TOTAL_ITERATIONS = 200;

type Checkpoint = {
  // deno-lint-ignore no-explicit-any
  messages: any[];
  totalIterations: number;
  writeCount: number;
};

// Tracks real writes (not get_work/get_staged_work reads, not finish
// itself) so a `finish` call describing findings it never actually
// logged/proposed/staged can be caught and rejected rather than accepted
// at face value -- a prose summary of what COULD be written is not the
// same as it having been written.
const WRITE_TOOLS = new Set([
  "log_work_source",
  "propose_work_revision",
  "create_staged_work",
  "update_staged_work",
  "log_citation",
  "attach_staged_work_photo",
]);

async function buildInitialCheckpoint(
  rows: { id: string; kind: string; filename: string; storage_path: string | null; url: string | null; notes: string | null }[],
): Promise<Checkpoint | null> {
  const [{ data: works }, { data: staged }, { data: materials }, { data: series }] = await Promise.all([
    adminDb.from("works").select("id, cr_number, title, date_display, year, medium, tag, series, flag").order("cr_number"),
    adminDb.from("staged_works").select("id, title, date_display, year, medium, tag, status, source_type"),
    adminDb.from("materials").select("slug, label"),
    adminDb.from("series").select("slug, label, parent_slug"),
  ]);

  const groundingLines: string[] = [];
  groundingLines.push(`Valid materials.slug values (tag field): ${(materials ?? []).map((m) => `${m.slug} ("${m.label}")`).join(", ")}`);
  groundingLines.push(`Valid series.slug values: ${(series ?? []).map((s) => `${s.slug} ("${s.label}")`).join(", ")}`);
  groundingLines.push(`\nCurrent works table (${(works ?? []).length} rows) — id | CR# | title | date | medium | tag | series | flag:`);
  for (const w of works ?? []) {
    groundingLines.push(
      `- ${w.id} | CR ${w.cr_number} | ${w.title} | ${w.date_display ?? w.year ?? "no date"} | ${w.medium ?? "?"} | tag:${w.tag ?? "?"} | series:${w.series}${w.flag ? ` | FLAGGED: ${w.flag}` : ""}`,
    );
  }
  groundingLines.push(`\nCurrent staged_works table (${(staged ?? []).length} rows, New Entries not yet imported) — id | title | date | medium | tag | status:`);
  for (const s of staged ?? []) {
    groundingLines.push(`- ${s.id} | ${s.title ?? "(untitled)"} | ${s.date_display ?? s.year ?? "no date"} | ${s.medium ?? "?"} | tag:${s.tag ?? "?"} | status:${s.status}`);
  }

  // deno-lint-ignore no-explicit-any
  const docBlocks: any[] = [];
  for (const row of rows) {
    if (row.kind === "url") {
      if (!row.url) {
        groundingLines.push(`\n(source_materials row ${row.id} is kind:url but has no url set — skipped.)`);
        continue;
      }
      try {
        const resp = await fetch(row.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MOD-CR-Archivist/1.0)" },
          signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok) {
          groundingLines.push(`\n(Could not fetch ${row.url}: HTTP ${resp.status} — skipped.)`);
          continue;
        }
        const html = await resp.text();
        // A generous but bounded cap -- real lot/press pages are a few KB
        // to a few hundred KB of markup; this keeps one bad page from
        // blowing the whole run's context budget.
        const { text: rawText, candidates } = extractTextAndImages(html, row.url);
        const text = rawText.slice(0, 60000);
        docBlocks.push({
          type: "text",
          text: `source_materials row id ${row.id} — pasted link: ${row.url}\n\nExtracted page text (an [IMAGE #N] marker shows where a photo appeared in the page's own markup -- reading-order position only, not verified layout; a downloaded candidate for some of these numbers follows below when one was fetched):\n${text}${row.notes ? `\n\nExisting notes already on this row: ${row.notes}` : ""}`,
        });

        // Download a bounded number of candidate photos so Khalo can
        // actually SEE them and verify a match, the same way it already
        // does for a PDF page -- previously a pasted link could never
        // produce a real photo at all, since the plain-text extraction
        // discarded every <img> tag before Khalo ever saw the page.
        // Deliberately conservative: a handful of real auction/gallery
        // photos is the common case, not dozens, and every download eats
        // into this batch's wall-clock budget.
        const MAX_IMAGE_CANDIDATES = 10;
        const IMAGE_FETCH_BUDGET_MS = 30_000;
        const imageFetchStart = Date.now();
        let fetchedImages = 0;
        for (const c of candidates.slice(0, MAX_IMAGE_CANDIDATES)) {
          if (Date.now() - imageFetchStart > IMAGE_FETCH_BUDGET_MS) {
            groundingLines.push(`\n(Stopped fetching candidate images for ${row.url} after ${fetchedImages} — ran out of time budget for this page.)`);
            break;
          }
          try {
            const imgResp = await fetch(c.url, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
              signal: AbortSignal.timeout(8000),
            });
            if (!imgResp.ok) continue;
            const contentType = imgResp.headers.get("content-type") ?? "";
            if (!contentType.startsWith("image/")) continue;
            const imgBuffer = await imgResp.arrayBuffer();
            // 8MB/image -- generous for a real lot photo, small enough that
            // a handful of these can't blow the request's own size limits.
            if (imgBuffer.byteLength > 8 * 1024 * 1024) continue;
            docBlocks.push({
              type: "image",
              source: { type: "base64", media_type: contentType.split(";")[0], data: encodeBase64(new Uint8Array(imgBuffer)) },
            });
            docBlocks.push({
              type: "text",
              text: `The image immediately above is candidate [IMAGE #${c.n}] (${c.url}) from ${row.url}. Only use it as a work's image_url if you can actually confirm from this picture that it depicts that specific work -- its reading-order position near a lot's text is a hint about which work it might belong to, never proof. If it's clearly unrelated (site chrome, an unrelated work, a different lot), ignore it.`,
            });
            fetchedImages++;
          } catch {
            // Same treatment as a failed page fetch -- skip silently, this
            // is expected often enough (dead links, hotlink protection,
            // timeouts) not to be worth a grounding-line note per image.
          }
        }
      } catch (err) {
        groundingLines.push(`\n(Could not fetch ${row.url}: ${String(err)} — skipped.)`);
      }
      continue;
    }

    if (!row.storage_path) {
      groundingLines.push(`\n(source_materials row ${row.id} (${row.filename}) has no storage_path — skipped.)`);
      continue;
    }
    const { data: fileBlob, error: dlErr } = await adminDb.storage.from("source-materials").download(row.storage_path);
    if (dlErr || !fileBlob) {
      groundingLines.push(`\n(Could not download ${row.filename}: ${dlErr?.message ?? "unknown error"} — skipped.)`);
      continue;
    }
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    const base64 = encodeBase64(bytes);
    if (row.kind === "pdf") {
      docBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
        title: row.filename,
      });
      if (row.notes) {
        docBlocks.push({ type: "text", text: `Existing notes already on this source_materials row (id ${row.id}): ${row.notes}` });
      }
    } else {
      const ext = row.filename.split(".").pop()?.toLowerCase();
      const mediaType = ext === "png" ? "image/png" : "image/jpeg";
      docBlocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
      docBlocks.push({
        type: "text",
        text: `source_materials row id ${row.id} (use this exact id as source_material_id if you call attach_staged_work_photo against this image), filename "${row.filename}". Notes/page text for this image:\n${row.notes ?? "(none)"}`,
      });
    }
  }

  if (docBlocks.length === 0) return null;

  const citationAnchor = rows[0].filename;
  const initialUserContent = [
    {
      type: "text",
      text:
        `Process the following source document${rows.length > 1 ? "s (all one batch, sharing one citation anchor)" : ""} per Mode B. Citation anchor / URL / publication name to use: "${citationAnchor}"${rows.length > 1 ? ` (batch of ${rows.length} pages/images)` : ""}.\n\nCurrent catalogue state for matching:\n${groundingLines.join("\n")}`,
    },
    ...docBlocks,
  ];

  return { messages: [{ role: "user", content: initialUserContent }], totalIterations: 0, writeCount: 0 };
}

// Hands off to a fresh invocation of this same function to continue from a
// saved checkpoint -- an ordinary function-to-function fetch() call
// (Supabase explicitly supports this pattern, budgeted generously at
// 5,000 requests/min per chain -- see "Recursive / Nested Function Calls"
// in their docs), authenticated as the service role rather than a user
// session since nothing about this call goes through a browser. Retries a
// couple of times before giving up, since a failed handoff would otherwise
// strand the row at 'processing' forever with no one watching for it.
async function continueViaSelfInvoke(ids: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/process-source-material`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceRoleKey()}` },
        body: JSON.stringify({ source_material_ids: ids, __internal_resume: true }),
      });
      if (resp.ok) return true;
      console.error(`continueViaSelfInvoke attempt ${attempt + 1} failed: HTTP ${resp.status}`, await resp.text());
    } catch (err) {
      console.error(`continueViaSelfInvoke attempt ${attempt + 1} threw:`, err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return false;
}

// deno-lint-ignore no-explicit-any
type KnowledgeIndexResult = { error?: string; matches?: any };

// Server-to-server call into the knowledge-index Edge Function (see
// supabase/functions/knowledge-index) -- same service-role-bearer pattern as
// continueViaSelfInvoke, since Khalo's automated pass has no browser session
// of its own. Failures (e.g. VOYAGE_API_KEY not yet configured) come back as
// {error} rather than throwing, so a search tool call degrades to "no rules
// found" instead of aborting the whole run.
// deno-lint-ignore no-explicit-any
async function callKnowledgeIndex(action: string, body: Record<string, any>): Promise<KnowledgeIndexResult> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/knowledge-index`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceRoleKey()}` },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error ?? `HTTP ${resp.status}` };
    return data;
  } catch (err) {
    return { error: String(err) };
  }
}

// deno-lint-ignore no-explicit-any
type ContentBlock = { type: string; cache_control?: unknown; [k: string]: any };

// Applies rolling prompt-caching breakpoints to the conversation before each
// API call. Without this, every single iteration of the tool loop -- and
// every batch a checkpoint hands off to (see continueViaSelfInvoke) --
// resent and fully reprocessed the entire original PDF/image content from
// scratch, which for a large catalog is slow enough to risk exceeding
// Supabase's hard Edge Function wall-clock ceiling mid-request (the
// diagnosed cause of a run getting killed mid-flight with no chance to
// checkpoint or log an error). The initial user message (the huge
// PDF/grounding-data content built in buildInitialCheckpoint, identical on
// every call for the life of this document) gets a permanent breakpoint.
// The last message in the conversation gets a second, rolling breakpoint so
// the ever-growing tool-call history is cached too -- each call's prefix
// (everything up to the newest content) matches what the previous call
// already cached, the standard pattern for an agentic tool-use loop. System
// + tools each hold one fixed breakpoint of their own (see runPass/TOOLS),
// so this uses the remaining two of Anthropic's 4-breakpoint-per-request
// cap -- any marker left over from an earlier iteration (when a
// since-superseded message was "last") is stripped first so the total never
// exceeds that cap.
function applyCacheControl(messages: { role: string; content: unknown }[]): void {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as ContentBlock[]) delete block.cache_control;
  }
  const first = messages[0]?.content;
  if (Array.isArray(first) && first.length > 0) {
    (first[first.length - 1] as ContentBlock).cache_control = { type: "ephemeral" };
  }
  const last = messages[messages.length - 1]?.content;
  if (Array.isArray(last) && last.length > 0) {
    (last[last.length - 1] as ContentBlock).cache_control = { type: "ephemeral" };
  }
}

async function runPass(sourceMaterialIds: string[]): Promise<void> {
  const batchStart = Date.now();
  let rows: { id: string; kind: string; filename: string; storage_path: string | null; url: string | null; notes: string | null; checkpoint: Checkpoint | null }[] = [];
  try {
    const { data: fetchedRows, error: rowsErr } = await adminDb
      .from("source_materials")
      .select("id, kind, filename, storage_path, url, notes, checkpoint")
      .in("id", sourceMaterialIds);
    if (rowsErr) throw rowsErr;
    if (!fetchedRows || fetchedRows.length === 0) throw new Error("No matching source_materials rows.");
    rows = fetchedRows;

    // Resuming is keyed purely on a saved checkpoint being present, not on
    // how this invocation was triggered -- a manual Process click on a row
    // that still has a checkpoint (e.g. an automatic handoff previously
    // failed) picks up exactly where it left off, same as the automatic
    // self-invoke path does.
    const existingCheckpoint = rows[0]?.checkpoint ?? null;
    const resuming = !!existingCheckpoint?.messages?.length;

    if (!resuming) {
      await adminDb.from("source_materials").update({ status: "processing", progress: "Starting…", checkpoint: null }).in("id", sourceMaterialIds);
    } else {
      await adminDb.from("source_materials").update({ status: "processing", progress: `Resuming from step ${existingCheckpoint!.totalIterations}…` }).in("id", sourceMaterialIds);
    }

    const checkpoint: Checkpoint = resuming ? existingCheckpoint! : (await buildInitialCheckpoint(rows))!;
    if (!checkpoint) {
      for (const r of rows) {
        await adminDb
          .from("source_materials")
          .update({ status: "flagged", progress: null, checkpoint: null, notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass could not fetch/download this source — needs a human look.`) })
          .eq("id", r.id);
      }
      return;
    }

    const messages = checkpoint.messages;
    let totalIterations = checkpoint.totalIterations;
    let writeCount = checkpoint.writeCount;
    let finishResult: { outcome: string; summary: string } | null = null;
    let batchIterations = 0;

    while (
      !finishResult &&
      totalIterations < MAX_TOTAL_ITERATIONS &&
      batchIterations < MAX_BATCH_ITERATIONS &&
      Date.now() - batchStart < BATCH_WALL_CLOCK_BUDGET_MS
    ) {
      applyCacheControl(messages);
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 8192,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        // deno-lint-ignore no-explicit-any
      } as any);

      messages.push({ role: "assistant", content: response.content });

      // deno-lint-ignore no-explicit-any
      const toolUses = response.content.filter((b: any) => b.type === "tool_use");
      if (toolUses.length === 0) {
        // The model answered in prose without calling anything -- this is
        // exactly how a real pass used to stall out into "I analyzed the
        // whole document but wrote nothing" (see commit history). Push it
        // back to actual tool calls, never toward finishing early.
        messages.push({
          role: "user",
          content:
            "You responded without calling a tool. Do not just describe findings in prose -- call log_work_source / propose_work_revision / create_staged_work / update_staged_work now for the specific findings you just described, one at a time. Only call finish once you've actually made those calls.",
        });
        totalIterations++;
        batchIterations++;
        continue;
      }

      // deno-lint-ignore no-explicit-any
      const toolResults: any[] = [];
      let sawFinish: { outcome: string; summary: string } | null = null;
      for (const tu of toolUses) {
        if (tu.name === "finish") {
          sawFinish = tu.input as { outcome: string; summary: string };
          continue; // handled after the loop, once writeCount for this turn is known
        }
        try {
          const result = await execTool(tu.name, tu.input, sourceMaterialIds[0] ?? null);
          if (WRITE_TOOLS.has(tu.name)) writeCount++;
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
        } catch (err) {
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: String(err) }), is_error: true });
        }
      }
      if (sawFinish) {
        if (writeCount === 0 && sawFinish.outcome !== "rejected") {
          // Caught exactly the failure mode from the first real run: a
          // detailed summary of candidates that were never actually logged.
          // Refuse it and send the model back to do the real writes.
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUses.find((t) => t.name === "finish")!.id,
            content:
              'Rejected: you called finish with outcome "' + sawFinish.outcome +
              '" but made zero log_work_source/propose_work_revision/create_staged_work/update_staged_work calls this entire run. A summary of candidates you identified is not a result -- call the appropriate tool now for each confident finding, then call finish again.',
            is_error: true,
          });
        } else {
          finishResult = sawFinish;
          toolResults.push({
            tool_use_id: toolUses.find((t) => t.name === "finish")!.id,
            type: "tool_result",
            content: "Recorded.",
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      totalIterations++;
      batchIterations++;

      // Real, current step progress -- not a time estimate (there isn't a
      // reliable one for a tool loop of unknown length), just an honest
      // "here's where it actually is" for the Researcher's Desk progress bar.
      if (!finishResult) {
        await adminDb
          .from("source_materials")
          .update({ progress: `Step ${totalIterations} of up to ${MAX_TOTAL_ITERATIONS} — ${writeCount} finding${writeCount === 1 ? "" : "s"} logged so far.` })
          .in("id", sourceMaterialIds);
      }
    }

    if (finishResult) {
      const finalStatus = finishResult.outcome;
      for (const r of rows) {
        await adminDb
          .from("source_materials")
          .update({ status: finalStatus, progress: null, checkpoint: null, notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass: ${finishResult.summary}`) })
          .eq("id", r.id);
      }
      return;
    }

    if (totalIterations >= MAX_TOTAL_ITERATIONS) {
      // Circuit breaker -- this document never converged on calling finish
      // across the whole checkpoint chain. Give up honestly rather than
      // burning cost indefinitely.
      for (const r of rows) {
        await adminDb
          .from("source_materials")
          .update({
            status: "flagged",
            progress: null,
            checkpoint: null,
            notes: appendNote(
              r.notes,
              `[${new Date().toISOString()}] Automated pass hit its ${MAX_TOTAL_ITERATIONS}-step safety cap without calling finish (${writeCount} findings logged) — needs a human look at what was actually written (check Work Sources / New Entries / Revisions for this document's citation).`,
            ),
          })
          .eq("id", r.id);
      }
      return;
    }

    // Ran out of this batch's time/iteration budget without finishing --
    // save exactly where we are and hand off to a fresh invocation.
    const nextCheckpoint: Checkpoint = { messages, totalIterations, writeCount };
    await adminDb
      .from("source_materials")
      .update({ progress: `Paused after step ${totalIterations} of up to ${MAX_TOTAL_ITERATIONS} — continuing automatically…`, checkpoint: nextCheckpoint })
      .in("id", sourceMaterialIds);

    const handedOff = await continueViaSelfInvoke(sourceMaterialIds);
    if (!handedOff) {
      // Leave the checkpoint in place (never discard real progress) but
      // drop status back to 'flagged' so the Process button is clickable
      // again -- a manual re-click resumes from this exact checkpoint.
      for (const r of rows) {
        await adminDb
          .from("source_materials")
          .update({
            status: "flagged",
            progress: null,
            notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass paused at step ${totalIterations} (${writeCount} findings logged) but couldn't hand off to continue automatically — click Process again to resume from here.`),
          })
          .eq("id", r.id);
      }
    }
  } catch (err) {
    console.error("process-source-material pass failed:", err);
    try {
      const { data: freshRows } = await adminDb.from("source_materials").select("id, notes").in("id", sourceMaterialIds);
      for (const r of freshRows ?? []) {
        await adminDb
          .from("source_materials")
          .update({ status: "flagged", progress: null, notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass failed with an error: ${String(err)}. Needs a human look.`) })
          .eq("id", r.id);
      }
    } catch (cleanupErr) {
      console.error("process-source-material: failed to record failure state:", cleanupErr);
    }
  }
}

// ---- HTTP entrypoint ---------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: { source_material_ids?: string[]; source_material_id?: string; __internal_resume?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  // Internal batch-continuation calls (see continueViaSelfInvoke) are this
  // function calling itself server-to-server -- authenticated with the
  // service-role secret, which only this function itself ever holds, not a
  // user session. Everything else goes through the normal admin-session
  // check.
  const isInternalResume = body.__internal_resume === true && authHeader === `Bearer ${getServiceRoleKey()}`;
  if (body.__internal_resume === true && !isInternalResume) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!isInternalResume) {
    // Defense-in-depth: verify the caller's Supabase session directly, even
    // though this function's own JWT verification (default-on) already
    // blocks unauthenticated calls before this code runs.
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await callerClient.auth.getUser();
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const ids = body.source_material_ids ?? (body.source_material_id ? [body.source_material_id] : []);
  if (!ids.length) return jsonResponse({ error: "source_material_id or source_material_ids is required" }, 400);

  const { data: existing, error: fetchErr } = await adminDb.from("source_materials").select("id, status, filename").in("id", ids);
  if (fetchErr) return jsonResponse({ error: fetchErr.message }, 500);
  if (!existing || existing.length !== ids.length) {
    return jsonResponse({ error: "One or more source_material ids were not found." }, 404);
  }
  // A resume call is expected to find these rows still 'processing' (that's
  // exactly the state a mid-run checkpoint leaves them in) -- only a fresh
  // user-triggered start needs to guard against double-starting a run
  // that's already genuinely in flight.
  if (!isInternalResume) {
    const alreadyRunning = existing.filter((r) => r.status === "processing");
    if (alreadyRunning.length) {
      return jsonResponse(
        { error: `Already processing: ${alreadyRunning.map((r) => r.filename).join(", ")}. Wait for it to finish before starting another pass.` },
        409,
      );
    }
  }

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(runPass(ids));
  } else {
    // Local/dev runtime without EdgeRuntime -- fire and forget instead.
    runPass(ids).catch((err) => console.error("runPass (no EdgeRuntime) failed:", err));
  }

  return jsonResponse({
    started: true,
    source_material_ids: ids,
    filenames: existing.map((r) => r.filename),
    message:
      "Processing started. This can take a few minutes — poll source_materials.status for this row (processing -> matched/flagged/rejected) to see when it's done; the result summary lands in its notes.",
  });
});
