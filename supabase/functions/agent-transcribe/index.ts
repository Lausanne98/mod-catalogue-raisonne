// MOD Catalogue Raisonné — agent transcribe Edge Function.
//
// Speech-to-text for the Intake page's Voice Intake feature (conversational,
// field-by-field form filling — see catalogue_intake's viTranscribe()).
// Deliberately NOT the browser's Web Speech API: that was tried once already
// for dictating straight into form fields and removed (see the "Voice
// annotation" comment in catalogue_intake) because iOS Safari/Brave/Chrome
// never reliably support it, since every iOS browser is required to run on
// WebKit under the hood. Recording audio with MediaRecorder and sending it
// here for transcription is the same proven-cross-browser approach this
// project already uses for voice annotations — this function just adds a
// transcript on top of that, via ElevenLabs' speech-to-text (Scribe) API
// rather than a browser API that silently fails on a third of visitors.
//
// Thin proxy, same shape as agent-voice but in reverse: audio bytes in,
// transcript text out. No catalogue data, no writes.
//
// Deploy: supabase functions deploy agent-transcribe
// Reuses the ELEVENLABS_API_KEY secret already configured for agent-voice —
// no new secret needed.
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

// A Voice Intake answer is one short spoken phrase (a title, a date, a
// materials list) -- never a full recorded session. This is a sanity
// ceiling against something absurd, not a real-world limit.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

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

  const contentType = req.headers.get("Content-Type") || "audio/webm";
  if (!contentType.startsWith("audio/")) {
    return jsonResponse({ error: "Request body must be an audio recording (Content-Type: audio/*)." }, 400);
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return jsonResponse({ error: "No audio data received." }, 400);
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return jsonResponse({ error: "That recording is too long — try a shorter answer." }, 400);
  }

  const ext = contentType.split("/")[1]?.split(";")[0] || "webm";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), `answer.${ext}`);
  form.append("model_id", "scribe_v1");

  // Same bare-fetch-has-no-timeout concern as agent-voice -- transcription
  // is usually quick for a short clip, but a stalled network path would
  // otherwise hang until the platform's own execution ceiling kills it.
  const ELEVENLABS_TIMEOUT_MS = 30_000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), ELEVENLABS_TIMEOUT_MS);

  try {
    let elevenResponse: Response;
    try {
      elevenResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_API_KEY },
        body: form,
        signal: timeoutController.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!elevenResponse.ok) {
      const detail = await elevenResponse.text();
      console.error("ElevenLabs speech-to-text error:", elevenResponse.status, detail);
      return jsonResponse(
        { error: `The transcription service returned an error (${elevenResponse.status}). Try again.` },
        502,
      );
    }

    const result = await elevenResponse.json();
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    return jsonResponse({ text });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`ElevenLabs speech-to-text request timed out after ${ELEVENLABS_TIMEOUT_MS}ms`);
      return jsonResponse({ error: "Transcription took too long. Try again." }, 504);
    }
    console.error("Transcription failed:", err);
    return jsonResponse({ error: "Couldn't transcribe that recording. Try again." }, 502);
  }
});
