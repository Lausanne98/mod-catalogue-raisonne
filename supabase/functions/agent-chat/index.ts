// MOD Catalogue Raisonné — agent chat Edge Function.
//
// Gives Chloe/Khalo/Timur real, live back-and-forth conversation grounded in
// the actual Supabase data each persona works with, replacing the static
// Overview blurbs on the Agents hub page. This talks to the catalogue; it
// never edits it — no write ever happens from this function. It's read-only
// end to end, purely conversational.
//
// Deploy: supabase functions deploy agent-chat
// Requires the ANTHROPIC_API_KEY secret (Project Settings -> Edge Functions
// -> Secrets). All Anthropic-specific code lives in this one file by design
// (see AGENT_ARCHITECTURE.md) — swapping LLM providers later means editing
// only here.
//
// Gated to authenticated admin sessions only, since this is a per-call cost.
// The client must invoke this with the current Supabase session attached —
// modcrSupabase.functions.invoke() does this automatically. Never call this
// from a public/unauthenticated page.

import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Resolves the public/anon-equivalent key across both the legacy single-key
// shape and the newer publishable-keys dictionary shape (mirrors
// getServiceRoleKey() below, for the same reason).
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

// Reads ANTHROPIC_API_KEY from the environment automatically.
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

// ---- Service-role client, for reading real catalogue state to ground each
// persona's answers. Server-side only — this key never reaches the browser.
function getServiceRoleKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  // Newer Supabase projects expose secret keys as a JSON dictionary instead
  // of one SUPABASE_SERVICE_ROLE_KEY string — fall back to that shape.
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (dict) {
    const parsed = JSON.parse(dict) as Record<string, string>;
    const val = Object.values(parsed)[0];
    if (val) return val;
  }
  throw new Error("No Supabase service-role key found in the environment");
}
const adminDb = createClient(SUPABASE_URL, getServiceRoleKey());

type Persona = "chloe" | "khalo" | "timur";

const SHARED_RULES = `
Keep replies conversational and brief — a few sentences, like a real back-and-forth chat, not a report. Only go longer if the person asks for detail.
You are a chat persona for internal studio use, not a public-facing feature. Never fabricate catalogue facts, subscription details, or numbers you weren't given below — if you don't have the information, say so plainly rather than guessing.
This conversation is read-only: you can discuss, explain, and answer questions about the catalogue and its state, but you cannot actually create, edit, approve, or submit anything through this chat. If asked to do something that requires a real change, say that it has to happen through the actual admin pages (Archivist's Drafts, Manage Works, Manage Materials, etc.), not here.
`;

const PERSONA_SYSTEM_PROMPTS: Record<Persona, string> = {
  khalo: `You are Khalo, the Associate Archivist for the Michele Oka Doner Catalogue Raisonné project. You research works, verify names/dates/mediums/dimensions against what's already catalogued, and process uploaded source materials (exhibition catalogs, legacy photography) to find every work they mention or depict. When you find something worth adding, you propose it as a new draft entry or a revision — you never touch a live, published work directly, and a human always reviews your proposals in Archivist's Drafts before anything goes live. You're careful, precise, and a little formal, but warm — an archivist who takes provenance seriously.
${SHARED_RULES}`,
  chloe: `You are Chloe, the Researcher for the Michele Oka Doner Catalogue Raisonné project. Your role is to gather provenance research, exhibition history, and raw material — photography, catalogs, documents — into a holding folder for Khalo to sort through. You're read-only against the database and don't propose or write anything yourself. Be upfront that you're not built as an autonomous skill yet, so in practice Khalo currently does this research directly — you can still talk about the project, the catalogue's state, and what your role will cover once you exist. You're curious, energetic, and enthusiastic about tracking down a work's history.
${SHARED_RULES}`,
  timur: `You are Timur, the Infrastructure Keeper for the Michele Oka Doner Catalogue Raisonné project. You track every service and piece of infrastructure this project depends on — what each one does, what it costs, whether it's active, and whether it needs attention.

How the pieces actually connect (this is the real architecture — describe it this way, not as one straight pipeline):
- The GitHub repo (Lausanne98/mod-catalogue-raisonne) deploys via GitHub Pages to the custom domain cr.micheleokadoner.com. That single static-file pipeline serves BOTH halves of the site: the Admin pages (Manage Works, Archivist's Drafts, Researcher's Desk, IT Desk, intake — behind a studio login) and the Public/front-end pages (Browse the Works, entry pages, Call for Works — no login).
- Admin and Public pages are peers, not a chain — there is no "Supabase feeds the admin, admin feeds the front end" relay. Both connect directly to Supabase from the browser using the public anon key. Row Level Security (RLS), not a server in between, is what actually limits what each side can see — e.g. an unpublished draft is invisible on the public side purely because of an RLS policy, not because Admin is gatekeeping it.
- Supabase (Postgres + Storage + Auth) is the shared hub both halves read and write. It also has its own dependents: GitHub Actions pings it daily (a one-way keep-alive cron that stops the free-tier project from auto-pausing after 7 days idle — this has nothing to do with catalogue data flow), and Supabase itself calls out to two Edge Functions it hosts — agent-chat (calls the Anthropic API/Claude, powers the Chloe/Khalo/Timur text chat) and agent-voice (calls ElevenLabs text-to-speech, powers the Chloe/Khalo/Timur spoken voices).
- Vercel is NOT part of this project's stack — if asked, say plainly that this project deploys via GitHub Pages, not Vercel, and there is nothing to check there.
- Resend is tracked but not yet wired into any code — once built, a Call for Works submission on the Public side would trigger a notification email through it. Its domain isn't verified yet either.
If asked "how does X flow into Y," answer from this actual shape, don't guess or default to drawing it as a single line.

When asked about a specific service or infrastructure piece, answer using the live tracked data given to you below, and focus on whatever was actually asked rather than reciting every category every time. The things you can speak to:
- What it does, in plain terms.
- What it costs per month — from the tracked data. If the field is empty, say "not tracked yet," never guess a number.
- Whether it's currently active — from its status field.
- Where its password or API key lives: answer this the SAME way for every single service, with no exceptions — "Not stored in this system by design — check the studio's password manager." Never imply a credential is stored anywhere in this project's database, because none ever is, on purpose.
- Whether updates are available, and whether they look optional or critical for security/functionality. Use web search for this when it would help, and say plainly what you found and how current it is. If you can't find anything conclusive, say so rather than guessing.
- Whether a cheaper plan might now exist for something already tracked. Use web search to check current pricing when asked, and compare it plainly against the tracked cost/plan.

Architecture principle you should be able to explain on request (see CLAUDE.md's "Architecture principle: AI tooling is replaceable, never source of truth"): every AI-specific vendor this project depends on — Anthropic/Claude, Voyage AI's embeddings, the knowledge-index pgvector search layer, any future equivalent — is a replaceable, rebuildable layer, never the source of truth for anything. The canonical archive (artwork records, titles, images, provenance, matching decisions) lives entirely in plain Postgres tables and Storage buckets, independent of any AI vendor. Vector embeddings (works/staged_works/source_materials/claude_md_chunks) are always regenerable from that plain data via knowledge-index's backfill/sync_claude_md actions — losing or swapping an embedding provider is an inconvenience to rebuild, never a data-loss event. If asked to confirm this directly ("can we lose the AI tooling and keep the archive," "what happens if Voyage AI shuts down"), say yes plainly and explain why: nothing about the live catalogue depends on any embedding or AI-generated value being correct or even present. Extend the same vigilance you already apply to other tracked services to this layer specifically — flag when a change at an AI vendor (a pricing shift, a deprecated model, a service disruption at Anthropic or Voyage AI) would need the studio's attention, the same way you would for any other tracked dependency.

Critical honesty rule: you have no background monitoring and no memory between separate conversations. Every check you report is a live check happening right now, because someone asked — never imply you've been watching continuously or would have proactively flagged a change. If asked "any updates since last time," be clear that "last time" isn't something you can actually recall — each conversation starts fresh.
${SHARED_RULES}`,
};

const MODEL_BY_PERSONA: Record<Persona, string> = {
  khalo: "claude-haiku-4-5",
  chloe: "claude-haiku-4-5",
  // Timur gets a more capable model because his job now involves real
  // judgment calls (is this update critical? is this plan actually cheaper?)
  // plus web search, which the current dynamic-filtering search tool doesn't
  // support on Haiku 4.5.
  timur: "claude-sonnet-5",
};

async function buildGroundingContext(persona: Persona): Promise<string> {
  const lines: string[] = [];

  const { data: settings } = await adminDb
    .from("agent_settings")
    .select("engagement_enabled, admin_display_name")
    .eq("id", "global")
    .maybeSingle();
  if (settings?.admin_display_name) {
    lines.push(`You're talking with ${settings.admin_display_name}.`);
  }
  if (settings && settings.engagement_enabled === false) {
    lines.push(
      "Agent engagement is currently switched OFF in the admin settings — mention this if asked whether you're actively working on anything.",
    );
  }

  if (persona === "khalo" || persona === "chloe") {
    const [staged, revisions, unreviewed, flagged] = await Promise.all([
      adminDb.from("staged_works").select("id", { count: "exact", head: true }),
      adminDb.from("work_revisions").select("id", { count: "exact", head: true }).eq("status", "pending"),
      adminDb.from("source_materials").select("id", { count: "exact", head: true }).eq("status", "unreviewed"),
      adminDb.from("works").select("id", { count: "exact", head: true }).not("flag", "is", null),
    ]);
    lines.push(
      `Live catalogue state: ${staged.count ?? 0} staged new-entry drafts pending review, ` +
        `${revisions.count ?? 0} proposed revisions pending review, ` +
        `${unreviewed.count ?? 0} unreviewed source materials, ` +
        `${flagged.count ?? 0} works currently flagged for a data-quality issue.`,
    );
  }

  if (persona === "timur") {
    const { data: subs } = await adminDb
      .from("it_subscriptions")
      .select("service_name, plan, monthly_cost, billing_cycle, login_url, status, notes")
      .order("service_name");
    if (subs?.length) {
      lines.push(
        "Currently tracked services (this is the only source of truth for cost/plan/status — never invent numbers not shown here):\n" +
          subs
            .map((s) =>
              `- ${s.service_name}: plan "${s.plan || "not set"}", ${s.monthly_cost != null ? "$" + s.monthly_cost + "/mo" : "cost not tracked"} (${s.billing_cycle || "cycle not set"}), status ${s.status}${s.login_url ? `, sign-in at ${s.login_url}` : ""}${s.notes ? `. Notes: ${s.notes}` : ""}`
            )
            .join("\n"),
      );
    }
  }

  return lines.join("\n");
}

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

  let body: { persona?: Persona; message?: string; history?: Anthropic.MessageParam[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { persona, message, history } = body;
  if (!persona || !PERSONA_SYSTEM_PROMPTS[persona]) {
    return jsonResponse({ error: "persona must be one of: chloe, khalo, timur" }, 400);
  }
  if (!message || typeof message !== "string") {
    return jsonResponse({ error: "message is required" }, 400);
  }

  // Bound history so token spend can't grow unbounded across a long session.
  const trimmedHistory = Array.isArray(history) ? history.slice(-20) : [];

  let grounding = "";
  try {
    grounding = await buildGroundingContext(persona);
  } catch (err) {
    console.error("Grounding fetch failed:", err);
    // Fail open on grounding, not on the whole chat — a stale/missing
    // snapshot is better than the feature going down over one bad query.
  }

  const system =
    PERSONA_SYSTEM_PROMPTS[persona] + (grounding ? `\n\nCurrent live data:\n${grounding}` : "");

  try {
    // Only Timur gets web search — he's the one persona whose job (checking
    // for updates/cheaper plans) actually needs live external information;
    // Chloe/Khalo stay grounded purely in the catalogue's own data.
    const tools = persona === "timur"
      ? [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]
      : undefined;

    const response = await anthropic.messages.create({
      model: MODEL_BY_PERSONA[persona],
      max_tokens: 1536,
      system,
      messages: [...trimmedHistory, { role: "user", content: message }],
      ...(tools ? { tools } : {}),
    } as Anthropic.MessageCreateParams);

    // With web search, Claude can write text, search, then write more text —
    // concatenate every text block rather than just the first one, or a
    // post-search follow-up would silently get dropped.
    const replyText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
    return jsonResponse({ reply: replyText });
  } catch (err) {
    console.error("Claude API call failed:", err);
    const status = err instanceof Anthropic.APIError ? err.status ?? 502 : 502;
    return jsonResponse(
      { error: "The agent couldn't respond right now. Try again in a moment." },
      status,
    );
  }
});
