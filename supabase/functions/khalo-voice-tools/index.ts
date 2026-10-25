// MOD Catalogue Raisonné — khalo-voice-tools Edge Function.
//
// Server-tool backend for Khalo's ElevenLabs Conversational AI Agent (see
// AGENT_ARCHITECTURE.md / ROADMAP.md item 2). ElevenLabs' own LLM runs the
// agentic tool-use loop during a live voice conversation -- this function
// only executes the tool calls it decides to make, one HTTP request per
// call, at a path named after the tool (…/khalo-voice-tools/get_work, etc).
//
// Deliberately the SAME narrow tool surface as agent-chat's KHALO_TOOLS /
// execKhaloTool (get_work, get_staged_work, search_classification_rules,
// search_similar_works, create_staged_work, update_staged_work) -- this is
// a second transport for Khalo's existing live-chat capability, not a new
// capability. Same hard rule as everywhere else Khalo appears: no tool here
// can write to a live `works` row, publish anything, or assign a cr_number
// -- the only write path is a staged_works draft, for a human to review in
// Archivist's Drafts.
//
// Auth: NOT a Supabase user JWT (ElevenLabs can't present one, and we never
// want to hand it the service-role key either). Deployed with
// verify_jwt=false; the ELEVENLABS_TOOL_SECRET header check below is the
// only gate. Scope stays deliberately narrow (this function, not a general
// DB credential) so a leaked ElevenLabs tool config exposes only Khalo's
// existing conversational capability, not raw database access.
//
// Deploy: supabase functions deploy khalo-voice-tools --no-verify-jwt
// Requires SUPABASE_URL / the service-role key (same pattern as every other
// function here) plus ELEVENLABS_TOOL_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

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

const TOOL_SECRET = Deno.env.get("ELEVENLABS_TOOL_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-khalo-tool-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type KnowledgeIndexResult = { error?: string; matches?: any };

// Same server-to-server pattern as agent-chat/process-source-material.
// deno-lint-ignore no-explicit-any
async function callKnowledgeIndex(action: string, body: Record<string, any>): Promise<KnowledgeIndexResult> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 15_000);
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/knowledge-index`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceRoleKey()}` },
      body: JSON.stringify({ action, ...body }),
      signal: timeoutController.signal,
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error ?? `HTTP ${resp.status}` };
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { error: "knowledge-index timed out after 15s" };
    return { error: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

// deno-lint-ignore no-explicit-any
async function execTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "get_work": {
      let query = adminDb.from("works").select("*");
      if (input.cr_number) query = query.eq("cr_number", input.cr_number);
      else if (input.title) query = query.ilike("title", `%${input.title}%`);
      else return { error: "Provide cr_number or title." };
      const { data: work, error } = await query.maybeSingle();
      if (error) throw error;
      if (!work) return { error: "No matching work found." };
      const { data: sources } = await adminDb
        .from("work_sources")
        .select("url, source_type, field, finding, confidence, accessed_at")
        .eq("work_id", work.id)
        .order("accessed_at", { ascending: false });
      return { work, sources: sources ?? [] };
    }
    case "get_staged_work": {
      const { data, error } = await adminDb.from("staged_works").select("*").ilike("title", `%${input.title}%`).maybeSingle();
      if (error) throw error;
      return data ? { staged_work: data } : { error: "No matching draft found." };
    }
    case "search_classification_rules": {
      const result = await callKnowledgeIndex("search", { collection: "claude_md", query: input.query, top_k: 3 });
      return result.error ? { error: result.error } : { rules: result.matches };
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
    case "create_staged_work": {
      const { data, error } = await adminDb
        .from("staged_works")
        .insert({
          title: input.title,
          title_source: "Verbal intake (live conversation with Khalo's voice agent)",
          date_display: input.date_display ?? null,
          year: input.year ?? null,
          medium: input.medium ?? null,
          tag: input.tag ?? null,
          suggested_series: input.suggested_series ?? null,
          dimensions: input.dimensions ?? null,
          source_url: `Verbal intake, ${new Date().toISOString().slice(0, 10)}`,
          source_type: "verbal",
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
      for (const k of ["date_display", "year", "medium", "tag", "suggested_series", "dimensions"]) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (input.append_note) {
        const { data: current, error: fetchErr } = await adminDb
          .from("staged_works").select("notes").eq("id", input.staged_id).single();
        if (fetchErr) throw fetchErr;
        patch.notes = current?.notes ? `${current.notes}\n\n${input.append_note}` : input.append_note;
      }
      patch.updated_at = new Date().toISOString();
      const { error } = await adminDb.from("staged_works").update(patch).eq("id", input.staged_id);
      if (error) throw error;
      return { ok: true, staged_work_id: input.staged_id };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const KNOWN_TOOLS = new Set([
  "get_work",
  "get_staged_work",
  "search_classification_rules",
  "search_similar_works",
  "create_staged_work",
  "update_staged_work",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (req.headers.get("x-khalo-tool-secret") !== TOOL_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // The tool name is the last path segment -- each ElevenLabs webhook tool
  // points at its own URL (…/khalo-voice-tools/get_work, …/create_staged_work,
  // etc.) rather than all six sharing one URL with a body field naming the
  // tool, since that's how ElevenLabs' own webhook tool config works (one
  // fixed URL per tool).
  const toolName = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!KNOWN_TOOLS.has(toolName)) {
    return jsonResponse({ error: `Unknown tool path: ${toolName}` }, 404);
  }

  let input: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) input = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await execTool(toolName, input);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
