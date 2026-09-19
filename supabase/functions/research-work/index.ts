// MOD Catalogue Raisonné — research-work Edge Function.
//
// Backs the Intake page's "Run Publication/Exhibition/Citation/Provenance
// Search" (and "Run All") buttons — a single live web-search pass scoped to
// ONE work being entered right now, whether the entry started manually or
// was opened from a Researcher's/Archivist's draft. All four buttons and
// "Run All" call this same endpoint and run the same underlying pass (one
// research call, routed by category into whichever fields it finds
// something for) rather than four separately-scoped searches — cheaper and
// simpler, and a single holistic pass is what a human researcher would do
// anyway rather than four disconnected ones.
//
// Deliberately returns SUGGESTIONS only — it never writes to the database.
// The intake page drops the result into the relevant textarea(s) as
// editable draft text for the human to review, same as every other
// automated finding in this project; nothing here is final until the human
// saves the work themselves.
//
// Deploy: supabase functions deploy research-work
// Requires the ANTHROPIC_API_KEY secret, same as agent-chat/
// process-source-material. Gated to authenticated admin sessions only,
// since a real pass costs real tokens.

import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
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

const SYSTEM_PROMPT = `You are researching ONE specific work by the artist Michele Oka Doner, for a studio admin who is entering it into the catalogue raisonné right now. You are given its title and, if known, its medium and date. Use web search to find real, verifiable information about THIS SPECIFIC WORK — not the artist generally — across auction houses, galleries, museums, press, and publications.

Look for:
- Exhibition history (venue, exhibition title, city, date, curator if known)
- Publications/literature that mention or illustrate it (author, title, publication, year, page if known)
- Provenance / ownership history (dated ownership chain; a museum's permanent-collection holding vs. a past loan should be stated plainly)
- Auction sales (house, sale name/lot, date, estimate/sold price)

Call report_findings exactly once when you're done searching. For each category, either a clean, human-readable set of lines (one finding per line, formatted as a real citation — "[Publication], [Author], [Year], p. [N]" for literature; "[Year], [Exhibition Title], [Venue], [City]" for exhibitions; "[Year] — [owner/event]" for provenance) or an empty string if you found nothing verifiable. Never invent a finding or pad a category with a vague restatement of the title — an honest empty string is the correct result when nothing turns up. Note in your summary if you're not fully confident a found item is definitely this exact work rather than a similarly-titled/dated piece.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "report_findings",
    description: "Report your research findings for this one work. Call exactly once, when you're done searching.",
    input_schema: {
      type: "object",
      properties: {
        exhibitions: { type: "string", description: "One finding per line, or empty string if nothing found." },
        literature: { type: "string", description: "One finding per line, or empty string if nothing found." },
        provenance: { type: "string", description: "One finding per line, or empty string if nothing found." },
        auction: { type: "string", description: "One finding per line, or empty string if nothing found." },
        summary: { type: "string", description: "Brief note on what was searched and any confidence caveats." },
      },
      required: ["exhibitions", "literature", "provenance", "auction", "summary"],
    },
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
  } = await callerClient.auth.getUser();
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { title?: string; medium?: string; date_display?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const title = (body.title ?? "").trim();
  if (!title) return jsonResponse({ error: "title is required" }, 400);

  const userText = `Work title: "${title}"${body.medium ? `\nMedium: ${body.medium}` : ""}${body.date_display ? `\nDate: ${body.date_display}` : ""}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [
        // deno-lint-ignore no-explicit-any
        { type: "web_search_20250305", name: "web_search", max_uses: 8 } as any,
        ...TOOLS,
      ],
      messages: [{ role: "user", content: userText }],
      // deno-lint-ignore no-explicit-any
    } as any);

    // deno-lint-ignore no-explicit-any
    const reportCall = response.content.find((b: any) => b.type === "tool_use" && b.name === "report_findings");
    if (!reportCall) {
      return jsonResponse({
        exhibitions: "",
        literature: "",
        provenance: "",
        auction: "",
        summary: "The research pass didn't return a structured result — try again, or search manually.",
      });
    }
    return jsonResponse(reportCall.input);
  } catch (err) {
    console.error("research-work failed:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
