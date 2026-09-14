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

const SYSTEM_PROMPT = `You are Khalo, the Associate Archivist for the Michele Oka Doner Catalogue Raisonné project, running your automated Mode B pass: given one uploaded source document (a catalog PDF, or a set of page images extracted from one, all sharing one citation anchor), find every MOD work it mentions or depicts and write findings into draft/staging records — never into a live work directly, never published.

## What you were given
The first user message contains: the citation anchor (publication/document name) to use for every citation from this document, a full current listing of the \`works\` table and the \`staged_works\` table (id, CR#/title, date, medium, tag/series, status) to match against, the valid \`materials.slug\` and \`series.slug\` taxonomy values, and then the actual document as native PDF/image content — read all of it, every page, not just the cover or index.

## Write as you go — do not save it all for one big summary at the end
Read, then act, work by work — never read the entire document first and only describe what you found afterward. The moment you're confident about one work, call the tool for it immediately (get_work/get_staged_work to check, then log_work_source/propose_work_revision/create_staged_work/update_staged_work to record it), then move to the next work. A message that only narrates candidates in prose without calling the matching tool has not accomplished anything — narrating "CR 12 should get a citation" is not the same as calling log_work_source for CR 12, and this run will explicitly reject a finish call that describes findings you never actually logged. If the document is long, that's fine — you have many tool-call turns; use them to work through it incrementally, not to produce one exhaustive essay before you've written a single row.

## For every work the document names or depicts
1. Try to match it against BOTH the \`works\` listing and the \`staged_works\` listing given to you (title, date, medium — confirm a fuzzy title match against date/medium before treating it as the same work, never on title alone). Checking \`works\` alone and missing an existing staged draft is exactly how a duplicate New Entries row happens.
2. **Matches an existing work, confidently** — call get_work to see its full current fields and existing citations (don't re-cite something already logged, and don't propose text that contradicts what's already there — if it would contradict, log a flagged work_source instead and leave the field alone). Log every extracted fact with log_work_source. For append-safe narrative facts (see REVISABLE_FIELDS in the propose_work_revision tool), also call propose_work_revision so it reaches a human via the Revisions tab. For a singular-value fact (a dimension, a medium/tag/series correction, a date), log it via log_work_source only — mention it by CR number in your final summary so a human can enter it directly in Manage Works.
3. **Matches an existing staged_works draft** (status new/reviewing) — call get_staged_work, then call update_staged_work with whatever new facts this document adds and an append_note carrying a dated, cited addition. Never create a second staged row for something already staged.
4. **Matches, but ambiguously** (close title, nothing to confirm date/medium against, or the document doesn't clearly distinguish two similarly-named works) — log_work_source only, confidence: flagged, and propose_work_revision with field: flag pointing at the ambiguity (e.g. "Possible [publication] citation, unverified — see Work Sources"). Never propose a revision to the real content field for a flagged match.
5. **Not in either table at all** — call create_staged_work. This is the New Entries tab; never invent a cr_number.
6. **Every work touched in steps 2-5 — matched or newly staged — gets this document logged as a Publications/Literature citation too**, not just whatever field prompted the match. Format every citation uniformly: publication/document title, and a page number whenever you have one (a page-image row's own filename/notes tag it directly — never drop it when it's right there). "Mentioned in [document]" is not a citation; "[Publication/Document], p. [N]" is, same shape every time.
7. **Read each page's own text for what it says, not just what it's attached to.** A catalog entry's prose routinely references OTHER exhibitions or publications this same work has appeared in ("previously exhibited at...", "as illustrated in..."). Treat each such mention as its own citable fact for that work — log and, where append-safe, propose it too. A single page can legitimately add several citations to one work.
8. **Photos**: never attach a full-page render, or any image that still shows a border/mat/page background around the artwork, as a work's photo. A full extracted image that's already a tight, clean crop of just the work is fine to set as a NEW staged work's image_url directly. For an EXISTING work, any candidate photo is still just a candidate — never set image_url on a live work yourself; note it for human review via a flagged work_source instead. Whenever a work has no usable photo at all, propose_work_revision on field: flag with a line starting exactly "Needs a source image:" plus what's missing and why (or append_note with that same line, for a staged candidate). Whenever a photo exists and is the right work but isn't a clean tight crop yet, use a line starting exactly "Needs a cleaner photo:" instead, same placement rules. Never attach a low-confidence, undersized, or uncropped image just to fill the field — an unset image renders as a clean placeholder on purpose.

## Field extraction protocol
Extract into structured fields, never leave a fact sitting only in prose: Title (strip date/material/dimensions back out of a compound title into their own fields), Date (date_display as the source states it, year as a plain number), Material (medium = descriptive label, tag = the matching materials.slug — never invent one), Dimensions (as stated), Series (the most specific series.slug that fits — a named sub-series before a broad bucket; never set a work's own series to early-clay unless its tag is literally ceramic, per the cross-categorization rule: a ceramic work dated before 2000 shows under Early Clay automatically via live filter logic, it does not need series set to early-clay directly), Provenance (dated ownership chain; for a museum listing, state plainly whether it's a permanent-collection holding or a past loan/exhibition, and record acquisition year/method if given), Exhibitions (venue, exhibition title, city, date, and curator name if listed), Publications/Literature (see citation format above).

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
            "Only set this if you have a real, verified, tightly-cropped, right-work image already sized per this project's convention (72dpi, max 2200px). Leave unset otherwise — a source-image request note in notes is correct instead of a guess.",
        },
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
        date_display: { type: "string" },
        year: { type: "integer" },
        medium: { type: "string" },
        tag: { type: "string" },
        suggested_series: { type: "string" },
        dimensions: { type: "string" },
        image_url: { type: "string" },
        append_note: { type: "string", description: "A new dated, cited line to add to this draft's notes." },
      },
      required: ["staged_id"],
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
  },
];

// ---- Tool execution ---------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function execTool(name: string, input: any): Promise<unknown> {
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
          date_display: input.date_display ?? null,
          year: input.year ?? null,
          medium: input.medium ?? null,
          tag: input.tag ?? null,
          suggested_series: input.suggested_series ?? null,
          dimensions: input.dimensions ?? null,
          image_url: input.image_url ?? null,
          source_url: input.source_url,
          source_type: "publication",
          confidence: "candidate",
          status: "new",
          notes: input.notes,
        })
        .select()
        .single();
      if (error) throw error;
      return { staged_work_id: data.id };
    }
    case "update_staged_work": {
      // deno-lint-ignore no-explicit-any
      const patch: Record<string, any> = {};
      for (const k of ["date_display", "year", "medium", "tag", "suggested_series", "dimensions", "image_url"]) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (input.append_note) {
        const { data: current, error: fetchErr } = await adminDb
          .from("staged_works")
          .select("notes")
          .eq("id", input.staged_id)
          .single();
        if (fetchErr) throw fetchErr;
        patch.notes = current?.notes ? `${current.notes}\n\n${input.append_note}` : input.append_note;
      }
      patch.updated_at = new Date().toISOString();
      const { error } = await adminDb.from("staged_works").update(patch).eq("id", input.staged_id);
      if (error) throw error;
      return { ok: true };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function appendNote(existing: string | null | undefined, line: string): string {
  return existing ? `${existing}\n\n${line}` : line;
}

// ---- The actual pass, run in the background --------------------------------

async function runPass(sourceMaterialIds: string[]): Promise<void> {
  let rows: { id: string; kind: string; filename: string; storage_path: string; notes: string | null }[] = [];
  try {
    await adminDb.from("source_materials").update({ status: "processing" }).in("id", sourceMaterialIds);

    const { data: fetchedRows, error: rowsErr } = await adminDb
      .from("source_materials")
      .select("id, kind, filename, storage_path, notes")
      .in("id", sourceMaterialIds);
    if (rowsErr) throw rowsErr;
    if (!fetchedRows || fetchedRows.length === 0) throw new Error("No matching source_materials rows.");
    rows = fetchedRows;

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
          text: `source_materials row id ${row.id}, filename "${row.filename}". Notes/page text for this image:\n${row.notes ?? "(none)"}`,
        });
      }
    }

    if (docBlocks.length === 0) {
      for (const r of rows) {
        await adminDb
          .from("source_materials")
          .update({ status: "flagged", notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass could not download this file — needs a human look.`) })
          .eq("id", r.id);
      }
      return;
    }

    const citationAnchor = rows[0].filename;
    const initialUserContent = [
      {
        type: "text",
        text:
          `Process the following source document${rows.length > 1 ? "s (all one batch, sharing one citation anchor)" : ""} per Mode B. Citation anchor / publication name to use: "${citationAnchor}"${rows.length > 1 ? ` (batch of ${rows.length} pages/images)` : ""}.\n\nCurrent catalogue state for matching:\n${groundingLines.join("\n")}`,
      },
      ...docBlocks,
    ];

    // deno-lint-ignore no-explicit-any
    const messages: any[] = [{ role: "user", content: initialUserContent }];

    let finishResult: { outcome: string; summary: string } | null = null;
    // Tracks real writes (not get_work/get_staged_work reads, not finish
    // itself) so a `finish` call describing findings it never actually
    // logged/proposed/staged can be caught and rejected rather than accepted
    // at face value -- a prose summary of what COULD be written is not the
    // same as it having been written.
    const WRITE_TOOLS = new Set(["log_work_source", "propose_work_revision", "create_staged_work", "update_staged_work"]);
    let writeCount = 0;
    const MAX_ITERATIONS = 60;
    for (let i = 0; i < MAX_ITERATIONS && !finishResult; i++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
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
          const result = await execTool(tu.name, tu.input);
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
    }

    const finalStatus = finishResult?.outcome ?? "flagged";
    const finalSummary =
      finishResult?.summary ??
      "Automated pass hit its iteration limit without calling finish — needs a human look at what was actually written (check Work Sources / New Entries / Revisions for this document's citation).";
    for (const r of rows) {
      await adminDb
        .from("source_materials")
        .update({ status: finalStatus, notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass: ${finalSummary}`) })
        .eq("id", r.id);
    }
  } catch (err) {
    console.error("process-source-material pass failed:", err);
    try {
      const { data: freshRows } = await adminDb.from("source_materials").select("id, notes").in("id", sourceMaterialIds);
      for (const r of freshRows ?? []) {
        await adminDb
          .from("source_materials")
          .update({ status: "flagged", notes: appendNote(r.notes, `[${new Date().toISOString()}] Automated pass failed with an error: ${String(err)}. Needs a human look.`) })
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

  // Defense-in-depth: verify the caller's Supabase session directly, even
  // though this function's own JWT verification (default-on) already blocks
  // unauthenticated calls before this code runs.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
  } = await callerClient.auth.getUser();
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { source_material_ids?: string[]; source_material_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const ids = body.source_material_ids ?? (body.source_material_id ? [body.source_material_id] : []);
  if (!ids.length) return jsonResponse({ error: "source_material_id or source_material_ids is required" }, 400);

  const { data: existing, error: fetchErr } = await adminDb.from("source_materials").select("id, status, filename").in("id", ids);
  if (fetchErr) return jsonResponse({ error: fetchErr.message }, 500);
  if (!existing || existing.length !== ids.length) {
    return jsonResponse({ error: "One or more source_material ids were not found." }, 404);
  }
  const alreadyRunning = existing.filter((r) => r.status === "processing");
  if (alreadyRunning.length) {
    return jsonResponse(
      { error: `Already processing: ${alreadyRunning.map((r) => r.filename).join(", ")}. Wait for it to finish before starting another pass.` },
      409,
    );
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
