// MOD Catalogue Raisonné — agent voice Edge Function.
//
// Replaces the browser's built-in speechSynthesis (robotic OS voices) with a
// real ElevenLabs text-to-speech call, so Chloe/Khalo/Timur's Play buttons on
// the Agents hub sound like an actual voice instead of a default TTS engine.
// This is a thin proxy: text in, MP3 bytes out. No catalogue data, no writes.
//
// Deploy: supabase functions deploy agent-voice
// Requires these Edge Function secrets (Project Settings -> Edge Functions ->
// Secrets):
//   ELEVENLABS_API_KEY     — from elevenlabs.io (Starter tier or above for
//                             commercial use; Free works for beta/internal
//                             testing per the project's current plan).
//   ELEVENLABS_VOICE_CHLOE — a voice_id from your own ElevenLabs Voice
//   ELEVENLABS_VOICE_KHALO   Library. Deliberately NOT hardcoded here: voice
//   ELEVENLABS_VOICE_TIMUR   availability varies by account/tier, and a wrong
//                             guessed ID would fail silently at call time
//                             rather than at review time. Pick one voice per
//                             persona in the ElevenLabs dashboard (Voice
//                             Library -> click a voice -> copy its Voice ID)
//                             matching the tone in AGENT_ARCHITECTURE.md's
//                             "Voices" section (Chloe: curious/energetic;
//                             Khalo: measured/precise/formal; Timur: plain,
//                             technical, low-drama), then set these three.
//
// Gated to authenticated admin sessions only, since every call spends real
// ElevenLabs credits. Never call this from a public/unauthenticated page.

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

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY")!;

type Persona = "chloe" | "khalo" | "timur";

const VOICE_ID_BY_PERSONA: Record<Persona, string | undefined> = {
  chloe: Deno.env.get("ELEVENLABS_VOICE_CHLOE"),
  khalo: Deno.env.get("ELEVENLABS_VOICE_KHALO"),
  timur: Deno.env.get("ELEVENLABS_VOICE_TIMUR"),
};

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

// Free-tier ElevenLabs text is capped fairly low per request in practice;
// this is a sanity ceiling to stop a runaway call from burning credits on
// something absurd (an admin bio line, not a full source-material transcript).
const MAX_TEXT_LENGTH = 2000;

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

  let body: { agentKey?: Persona; text?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { agentKey, text } = body;
  if (!agentKey || !(agentKey in VOICE_ID_BY_PERSONA)) {
    return jsonResponse({ error: "agentKey must be one of: chloe, khalo, timur" }, 400);
  }
  if (!text || typeof text !== "string") {
    return jsonResponse({ error: "text is required" }, 400);
  }

  const voiceId = VOICE_ID_BY_PERSONA[agentKey];
  if (!voiceId) {
    return jsonResponse(
      { error: `No ElevenLabs voice configured for ${agentKey} yet (ELEVENLABS_VOICE_${agentKey.toUpperCase()} secret is unset).` },
      500,
    );
  }

  const trimmedText = text.slice(0, MAX_TEXT_LENGTH);

  try {
    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text: trimmedText,
          model_id: "eleven_flash_v2_5",
        }),
      },
    );

    if (!elevenResponse.ok) {
      const detail = await elevenResponse.text();
      console.error("ElevenLabs API error:", elevenResponse.status, detail);
      return jsonResponse(
        { error: "The voice service couldn't generate audio right now. Try again in a moment." },
        502,
      );
    }

    const audioBytes = await elevenResponse.arrayBuffer();
    return new Response(audioBytes, {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "audio/mpeg" },
    });
  } catch (err) {
    console.error("Voice generation failed:", err);
    return jsonResponse(
      { error: "The voice service couldn't generate audio right now. Try again in a moment." },
      502,
    );
  }
});
