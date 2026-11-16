// MOD Catalogue Raisonné — transcribe-clipping Edge Function.
//
// Reads a photo or scan of a press clipping / publication page (an image) with
// Claude's vision and returns its text, for the intake form's Publications
// "Convert to text" option. Text-in-image only: no database writes, no
// storage access. The caller saves the result as `extracted_text` with
// text_status = 'unverified' until a person has checked it against the scan.
//
// Deploy: supabase functions deploy transcribe-clipping
// Requires the ANTHROPIC_API_KEY secret (already set for agent-chat).
// Gated to authenticated admin sessions only (spends real tokens).

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

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
// ~5 MB of image once decoded; Claude's own per-image ceiling is the real limit.
const MAX_BASE64_CHARS = 7_000_000;

const PROMPT =
  "This is a photo or scan of a press clipping or published page. Transcribe all of its text exactly as printed, " +
  "in reading order, keeping paragraph breaks. Include the headline, byline, publication name and date if they appear. " +
  "Do not summarize, correct, or add commentary. If a word is unreadable write [illegible]. " +
  "If the image contains no readable text, reply with exactly: [no text found]";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await callerClient.auth.getUser();
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { image_base64?: string; media_type?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request." }, 400); }

  const mediaType = (body.media_type || "image/jpeg").toLowerCase();
  if (!ALLOWED_TYPES.includes(mediaType)) {
    return jsonResponse({ error: "Only JPEG, PNG, GIF or WebP images can be converted to text." }, 400);
  }
  const data = body.image_base64;
  if (!data) return jsonResponse({ error: "No image received." }, 400);
  if (data.length > MAX_BASE64_CHARS) {
    return jsonResponse({ error: "That image is too large to read. Try a smaller photo or scan." }, 400);
  }

  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data } },
          { type: "text", text: PROMPT },
        ],
      }],
    });
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return jsonResponse({ text });
  } catch (err) {
    console.error("transcribe-clipping failed:", err);
    return jsonResponse({ error: "Couldn't read that image. Try again, or type the text in by hand." }, 502);
  }
});
