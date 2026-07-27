// ---------------------------------------------------------------------------
// Shared preset library — a Vercel Serverless Function backed by Vercel KV.
//
// This replaces the old localStorage-only preset store (which was scoped to
// one person's browser) with a single shared JSON blob everyone on the team
// reads from and writes to, so a preset one person saves shows up for
// everyone else without emailing a .json file around.
//
// Deliberately minimal: ONE key holding the whole { [presetName]: values }
// object (same shape main.js already used for localStorage), read/replaced
// wholesale — no per-preset rows, no auth, no versioning/conflict handling.
// Good enough for a small team's internal design tool; see README "Live /
// shared preset library" for the known trade-offs (last-write-wins, no
// access control) and what to add if you outgrow this.
//
// Setup required before this works (see README): a Vercel KV database must
// be provisioned and connected to this project in the Vercel dashboard,
// which auto-injects the KV_REST_API_URL / KV_REST_API_TOKEN env vars this
// import reads at runtime.
// ---------------------------------------------------------------------------
import { kv } from "@vercel/kv";

const STORE_KEY = "ilabs-ascii-sandbox-presets-v1";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const store = (await kv.get(STORE_KEY)) || {};
      res.status(200).json(store);
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      // req.body is already parsed to an object by Vercel's Node runtime when
      // Content-Type: application/json is sent (see the fetch() calls in
      // main.js) — no manual JSON.parse needed here.
      const body = req.body && typeof req.body === "object" ? req.body : {};
      await kv.set(STORE_KEY, body);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, PUT, POST");
    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    // Most likely cause: KV isn't provisioned/connected yet (missing env
    // vars) — surface a message that points at the README step instead of a
    // bare 500 with no context.
    console.error("[api/presets] failed:", err);
    res.status(500).json({
      error: "Preset store unavailable — is Vercel KV connected to this project? See README 'Live / shared preset library'.",
    });
  }
}
