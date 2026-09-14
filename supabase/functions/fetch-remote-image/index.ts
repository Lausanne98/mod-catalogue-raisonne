// MOD Catalogue Raisonné — fetch-remote-image Edge Function.
//
// Exists because a browser-side fetch() of a draft's source image (an
// auction-house/gallery hotlink) fails silently for nearly every real-world
// source: none of them send Access-Control-Allow-Origin, so the browser's
// CORS policy blocks the request before it even reaches the network tab as
// an error the code can usefully react to -- confirmed by hand against
// bonhams/phillips/rago/toomey source URLs, all missing the header. CORS is
// enforced by browsers, not servers, so the same fetch works fine from here.
//
// Used by the intake form's preloadDraftPhoto() (see catalogue_intake_*):
// given a draft's image_url, this fetches the bytes server-side and returns
// them as base64 for the client to turn back into a File and drop into the
// existing pendingPhotos upload flow -- nothing about how photos get
// attached to a work changes, only how the bytes for this one pre-fill
// convenience are obtained.
//
// Deploy: supabase functions deploy fetch-remote-image
// Gated to authenticated admin sessions, same reasoning as agent-chat: a
// per-call cost (and, here, a server-initiated fetch of a caller-influenced
// URL) that a public/unauthenticated page must never be able to trigger.

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

// research_finds accepts an anonymous insert (see the researcher skill) --
// its image_url, and therefore a staged_works row derived from it, is
// caller-influenced data, not something only a trusted admin ever wrote.
// This function fetches that URL from inside Supabase's own network, so
// block the obvious SSRF targets (loopback, link-local, and the RFC1918
// private ranges) by hostname/literal-IP pattern before ever calling fetch.
// This is a pattern check, not a DNS-rebinding-proof resolver -- reasonable
// given this only ever fetches an image to preview, never anything a
// response is trusted to act on.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

const MAX_BYTES = 15 * 1024 * 1024; // matches the artifact-style sanity cap used elsewhere in this project

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { url } = body;
  if (!url || typeof url !== "string") return jsonResponse({ error: "url is required" }, 400);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return jsonResponse({ error: "Malformed URL" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return jsonResponse({ error: "Only http/https URLs are allowed" }, 400);
  }
  if (isBlockedHost(parsed.hostname)) {
    return jsonResponse({ error: "That host cannot be fetched" }, 400);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: {
        // Some auction-house CDNs 403 a request with no browser-like UA
        // even though CORS was never the reason -- match what a real
        // browser sends since that's exactly the request this replaces.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "image/*",
      },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return jsonResponse({ error: `Source returned ${resp.status}` }, 502);
    }
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return jsonResponse({ error: `Not an image (got ${contentType || "unknown content-type"})` }, 415);
    }
    const contentLength = resp.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BYTES) {
      return jsonResponse({ error: "Image too large" }, 413);
    }

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return jsonResponse({ error: "Image too large" }, 413);
    }

    return jsonResponse({ base64: toBase64(buffer), contentType });
  } catch (err) {
    console.error("fetch-remote-image failed:", err);
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    return jsonResponse(
      { error: timedOut ? "Timed out fetching the source image" : "Could not fetch the source image" },
      502,
    );
  }
});
