// netlify/functions/ask.mjs
// The website's server-side piece. It holds the Brave key (from Netlify's
// environment variables), calls the Brave Answers API, and returns the
// answer, citations, and cost to the page. Same logic as local/app.py.
//
//   POST /api/ask     { question, code }  -> answer JSON
//   GET  /api/status                      -> which features are on

const BRAVE_ANSWERS_URL =
  env("BRAVE_ANSWERS_URL") || "https://api.search.brave.com/res/v1/chat/completions";
const MAX_QUESTION = 500;
const RATE_LIMIT = Number(env("RATE_LIMIT_PER_MINUTE") || 6);

function env(name) {
  try { if (globalThis.Netlify?.env) return Netlify.env.get(name); } catch {}
  return process.env[name];
}
const braveKey = () => env("BRAVE_ANSWERS_API_KEY") || env("BRAVE_API_KEY");

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// ---------- Answer format (same rule as app.py) ----------
const DECISION_WORDS = /\b(upgrade|pros?|cons?|worth|should i|switch|wait)\b/i;
const FORMAT_DECISION =
  "\n\nAnswer for a shopper using an electronics store's app. Use this format: " +
  "a two-sentence summary; a heading 'Reasons to upgrade' with 3-5 bullet points; " +
  "a heading 'Reasons to wait' with 3-5 bullet points; then one line starting " +
  "'Bottom line:'. Base it on independent reviews and current reporting.";
const FORMAT_GENERAL =
  "\n\nAnswer for a shopper using an electronics store's app. Keep it short: " +
  "a two-sentence summary, then up to 5 bullet points, then one line starting " +
  "'Bottom line:'. Base it on independent reviews and current reporting.";
const answersFormat = (q) => (DECISION_WORDS.test(q) ? FORMAT_DECISION : FORMAT_GENERAL);

// ---------- Best-effort rate limit ----------
// Serverless instances come and go, so this only slows bursts. The real
// spending protection is the monthly credit limit in your Brave account.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

// ---------- Parse Brave's tagged stream text ----------
export function parseAnswersStream(full) {
  let usage = {};
  const u = full.match(/<usage>([\s\S]*?)<\/usage>/);
  if (u) { try { usage = JSON.parse(u[1]); } catch {} }
  full = full.replace(/<usage>[\s\S]*?<\/usage>/g, "");

  const citations = new Map();
  let text = full.replace(/<citation>([\s\S]*?)<\/citation>/g, (_, body) => {
    try {
      const c = JSON.parse(body);
      if (c.number == null) return "";
      if (!citations.has(c.number)) citations.set(c.number, c);
      return `[${c.number}]`;
    } catch { return ""; }
  });
  text = text.replace(/(\[(\d+)\])(?:\s*\[\2\])+/g, "$1"); // collapse [1][1]
  const sorted = [...citations.keys()].sort((a, b) => a - b).map((k) => citations.get(k));
  return { text: text.trim(), citations: sorted, usage };
}

// ---------- Call Brave Answers ----------
async function braveAnswer(question) {
  const body = {
    model: "brave",
    stream: true,               // citations require streaming
    enable_citations: true,
    country: env("BRAVE_COUNTRY") || "us",
    language: "en",
    messages: [{ role: "user", content: question + answersFormat(question) }],
  };
  const started = Date.now();
  const resp = await fetch(BRAVE_ANSWERS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-subscription-token": braveKey() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55_000), // Netlify allows 60 s
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Brave Answers refused the key (HTTP ${resp.status}). ` +
      "Check that the key in Netlify is enabled for the Answers plan.");
  }
  if (!resp.ok) {
    throw new Error(`Brave Answers HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }

  // Read the Server-Sent Events stream: lines of "data: {json}", ending with [DONE]
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", parts = [], done = false;
  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();                       // keep a partial last line
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { done = true; break; }
      try {
        for (const ch of JSON.parse(payload).choices || []) {
          if (ch.delta?.content) parts.push(ch.delta.content);
        }
      } catch {}
    }
  }
  const elapsed = Date.now() - started;

  const { text, citations, usage } = parseAnswersStream(parts.join(""));
  if (!text) throw new Error("Brave Answers returned an empty answer.");
  const sources = citations.map((c) => {
    const host = (c.url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    return { number: c.number, title: host || c.url, url: c.url || "",
             description: (c.snippet || "").slice(0, 240), site: host };
  });
  const cleanUsage = Object.fromEntries(
    Object.entries(usage).map(([k, v]) => [k.replace("X-Request-", ""), v]));
  return {
    text, sources,
    meta: {
      endpoint: "POST /res/v1/chat/completions",
      query: question,
      params: { model: body.model, stream: body.stream,
                enable_citations: body.enable_citations, country: body.country },
      latency_ms: elapsed,
      result_count: sources.length,
      usage: cleanUsage,
    },
  };
}

// ---------- HTTP handler ----------
export default async (req, context) => {
  const url = new URL(req.url);
  const accessCode = env("DEMO_ACCESS_CODE");

  if (req.method === "GET" && url.pathname.endsWith("/status")) {
    return json(200, {
      mode: env("DEMO_MODE") === "replay" ? "replay" : "live",
      engine: "brave",
      brave_key: Boolean(braveKey()),
      access_code_required: Boolean(accessCode),
    });
  }
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  let payload = {};
  try { payload = await req.json(); } catch {}
  const question = String(payload.question || "").trim().slice(0, MAX_QUESTION);
  if (!question) return json(400, { error: "Type a question first." });
  if (accessCode && payload.code !== accessCode) {
    return json(401, { error: "Enter the demo access code to ask live questions." });
  }
  if (!braveKey()) return json(500, { error: "The site's Brave key isn't set in Netlify." });
  if (rateLimited(context?.ip || "unknown")) {
    return json(429, { error: "Too many questions in a minute. Wait a moment and try again." });
  }

  const started = Date.now();
  try {
    const { text, sources, meta } = await braveAnswer(question);
    return json(200, {
      mode: "live", engine: "brave-answers", question,
      answer: null, answer_text: text, answer_note: null,
      sources, brave: meta, total_ms: Date.now() - started,
    });
  } catch (err) {
    return json(502, { error: err.message || "The Brave request failed." });
  }
};

export const config = { path: ["/api/ask", "/api/status"] };
