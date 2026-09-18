// MOD Catalogue Raisonné — knowledge-index Edge Function.
//
// Builds and queries the semantic search index backing Khalo & co's
// "sorting protocols" -- see CLAUDE.md's "Backend" section. Three things
// live in this one index, all embedded with Voyage AI's voyage-3 model
// (1024 dims, requires a VOYAGE_API_KEY secret -- Project Settings -> Edge
// Functions -> Secrets, never committed to the repo):
//   1. claude_md_chunks -- CLAUDE.md's classification rules, chunked by
//      "## " heading, so a rule can be retrieved by meaning instead of
//      always being pasted in full into process-source-material's system
//      prompt.
//   2. works / staged_works embeddings -- so a candidate work can be
//      compared against similar existing entries by meaning (title + medium
//      + series + notes), not only exact/fuzzy title matching.
//   3. source_materials embeddings -- a kind='image' row's `notes` already
//      holds that page's extracted text (see scripts/catalog_pdf_extractor.py);
//      embedding it lets a new source be checked against prior source text.
//
// Actions (POST body: { action, ... }):
//   sync_claude_md      { markdown }                         -- full replace
//   backfill             { collection?: 'works'|'staged_works'|'source_materials'|'all', limit? }
//   search               { collection, query, top_k? }
//
// Auth: an authenticated admin session (same as every other admin-only
// table here), OR the service-role bearer token for server-to-server calls
// from process-source-material (mirrors that function's own
// __internal_resume check) -- Khalo's automated pass has no browser session
// of its own to satisfy the first check.

import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

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
const adminDb = createClient(SUPABASE_URL, getServiceRoleKey());

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const VOYAGE_MODEL = "voyage-3"; // 1024 dims -- must match the `vector(1024)` columns in schema.sql

// Voyage's embeddings endpoint takes a batch of input strings in one call --
// batching here (not one HTTP round-trip per row) is what keeps a backfill
// of the whole works/staged_works tables inside one Edge Function invocation.
async function embedBatch(texts: string[], inputType: "document" | "query"): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const apiKey = Deno.env.get("VOYAGE_API_KEY");
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set (Project Settings -> Edge Functions -> Secrets).");
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
  });
  if (!resp.ok) {
    throw new Error(`Voyage embeddings request failed: HTTP ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  // deno-lint-ignore no-explicit-any
  return (data.data as any[]).map((d) => d.embedding ?? null);
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// ---- sync_claude_md ---------------------------------------------------------

// Splits on lines starting with "## " (a top-level section) -- CLAUDE.md's
// own convention throughout the file. Each chunk keeps its heading text
// prepended to the embedded content so a heading-only query ("versioning
// rule") still matches well, not just a query that echoes the body prose.
function chunkMarkdownByHeading(markdown: string): { heading: string; content: string }[] {
  const lines = markdown.split("\n");
  const chunks: { heading: string; content: string }[] = [];
  let currentHeading = "Untitled section";
  let currentLines: string[] = [];
  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (content) chunks.push({ heading: currentHeading, content });
    currentLines = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && !line.startsWith("###")) {
      flush();
      currentHeading = m[1];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return chunks;
}

async function syncClaudeMd(markdown: string): Promise<{ chunks_written: number }> {
  const chunks = chunkMarkdownByHeading(markdown);
  const embeddings = await embedBatch(
    chunks.map((c) => `${c.heading}\n\n${c.content}`),
    "document",
  );
  // Full replace -- CLAUDE.md is always sent in full, so there's no
  // meaningful "diff" to apply, and a stale removed-section row left behind
  // would silently keep surfacing in search results forever.
  const { error: delErr } = await adminDb.from("claude_md_chunks").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (delErr) throw delErr;
  const rows = chunks.map((c, i) => ({
    heading: c.heading,
    content: c.content,
    embedding: embeddings[i] ? toVectorLiteral(embeddings[i]!) : null,
  }));
  if (rows.length) {
    const { error: insErr } = await adminDb.from("claude_md_chunks").insert(rows);
    if (insErr) throw insErr;
  }
  return { chunks_written: rows.length };
}

// ---- backfill ---------------------------------------------------------------

function buildWorkEmbeddingText(w: Record<string, unknown>): string {
  return [w.title, w.date_display, w.medium, w.series, w.description, w.notes]
    .filter((v) => typeof v === "string" && v.trim())
    .join("\n");
}

const BACKFILL_BATCH_SIZE = 50; // stays well inside one invocation's time budget

async function backfillCollection(collection: "works" | "staged_works" | "source_materials", limit: number) {
  if (collection === "source_materials") {
    const { data: rows, error } = await adminDb
      .from("source_materials")
      .select("id, notes")
      .is("embedding", null)
      .not("notes", "is", null)
      .limit(limit);
    if (error) throw error;
    const candidates = (rows ?? []).filter((r) => (r.notes ?? "").trim());
    if (!candidates.length) return { collection, embedded: 0, remaining_estimate: 0 };
    const embeddings = await embedBatch(candidates.map((r) => r.notes as string), "document");
    for (let i = 0; i < candidates.length; i++) {
      if (!embeddings[i]) continue;
      await adminDb.from("source_materials").update({ embedding: toVectorLiteral(embeddings[i]!) }).eq("id", candidates[i].id);
    }
    const { count } = await adminDb.from("source_materials").select("id", { count: "exact", head: true }).is("embedding", null).not("notes", "is", null);
    return { collection, embedded: candidates.length, remaining_estimate: count ?? 0 };
  }

  const columns = collection === "works"
    ? "id, title, date_display, medium, series, description"
    : "id, title, date_display, medium, suggested_series, notes";
  const { data: rows, error } = await adminDb.from(collection).select(columns).is("embedding", null).limit(limit);
  if (error) throw error;
  if (!rows || rows.length === 0) return { collection, embedded: 0, remaining_estimate: 0 };
  const texts = rows.map((r) =>
    buildWorkEmbeddingText(collection === "works" ? r : { ...r, series: (r as Record<string, unknown>).suggested_series })
  );
  const embeddings = await embedBatch(texts, "document");
  for (let i = 0; i < rows.length; i++) {
    if (!embeddings[i]) continue;
    await adminDb.from(collection).update({ embedding: toVectorLiteral(embeddings[i]!) }).eq("id", (rows[i] as { id: string }).id);
  }
  const { count } = await adminDb.from(collection).select("id", { count: "exact", head: true }).is("embedding", null);
  return { collection, embedded: rows.length, remaining_estimate: count ?? 0 };
}

// ---- search -------------------------------------------------------------

const SEARCH_COLUMNS: Record<string, string> = {
  claude_md: "heading, content, embedding",
  works: "id, cr_number, title, date_display, medium, series, embedding",
  staged_works: "id, title, date_display, medium, suggested_series, status, embedding",
  source_materials: "id, filename, kind, notes, embedding",
};

async function search(collection: string, query: string, topK: number) {
  if (!(collection in SEARCH_COLUMNS)) throw new Error(`Unknown collection: ${collection}`);
  const [embedding] = await embedBatch([query], "query");
  if (!embedding) throw new Error("Failed to embed the search query.");
  const { data, error } = await adminDb.rpc("match_knowledge_index", {
    p_collection: collection,
    p_query_embedding: toVectorLiteral(embedding),
    p_match_count: topK,
  });
  if (error) throw error;
  return data;
}

// ---- HTTP entrypoint ---------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: { action?: string; markdown?: string; collection?: string; limit?: number; query?: string; top_k?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const isServiceRole = authHeader === `Bearer ${getServiceRoleKey()}`;
  if (!isServiceRole) {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    switch (body.action) {
      case "sync_claude_md": {
        if (!body.markdown) return jsonResponse({ error: "markdown is required" }, 400);
        return jsonResponse(await syncClaudeMd(body.markdown));
      }
      case "backfill": {
        const collections = body.collection && body.collection !== "all"
          ? [body.collection as "works" | "staged_works" | "source_materials"]
          : (["works", "staged_works", "source_materials"] as const);
        const results = [];
        for (const c of collections) {
          results.push(await backfillCollection(c, body.limit ?? BACKFILL_BATCH_SIZE));
        }
        return jsonResponse({ results });
      }
      case "search": {
        if (!body.collection || !body.query) return jsonResponse({ error: "collection and query are required" }, 400);
        return jsonResponse({ matches: await search(body.collection, body.query, body.top_k ?? 5) });
      }
      default:
        return jsonResponse({ error: "action must be one of: sync_claude_md, backfill, search" }, 400);
    }
  } catch (err) {
    console.error("knowledge-index error:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
