// netlify/functions/compare.mjs
// Runs the shopper's question through Brave Web Search twice, once as-is
// and once with the "Trusted Phone Reviews" Goggle, so the page can show
// how the Goggle changes which sources come back.
//
//   POST /api/compare   { question, code }  -> { standard, goggled, goggle }
//
// Goggles work with the Web Search, LLM Context, and News Search APIs
// (not the Answers API), so this panel uses Web Search.

const WEB_SEARCH_URL =
  env("BRAVE_WEB_SEARCH_URL") || "https://api.search.brave.com/res/v1/web/search";
const RESULT_COUNT = 10;
const RATE_LIMIT = Number(env("RATE_LIMIT_PER_MINUTE") || 6);

// Keep these rules in sync with goggles/trusted-phone-reviews.goggle.
// Inline rules work immediately; a hosted file must first be registered at
// https://search.brave.com/goggles/create. Once it is, set GOGGLE_URL in
// Netlify to its raw GitHub URL and this function will send the URL instead.
export const GOGGLE_NAME = "Trusted Phone Reviews";
export const GOGGLE_RULES = [
  "$discard,site=quora.com",
  "$discard,site=trustpilot.com",
  "$discard,site=consumeraffairs.com",
  "$discard,site=alibaba.com",
  "$discard,site=facebook.com",
  "$downrank=3,site=reddit.com",
  "$boost=4,site=gsmarena.com",
  "$boost=4,site=theverge.com",
  "$boost=4,site=cnet.com",
  "$boost=4,site=tomsguide.com",
  "$boost=3,site=macrumors.com",
  "$boost=3,site=techradar.com",
].join("\n");

function env(name) {
  try { if (globalThis.Netlify?.env) return Netlify.env.get(name); } catch {}
  return process.env[name];
}
const searchKey = () => env("BRAVE_SEARCH_API_KEY") || env("BRAVE_API_KEY");

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

// Which sites the rules discard or boost, so the page can label results
export function ruleSites(rules) {
  const out = { discard: [], boost: [] };
  for (const line of rules.split("\n")) {
    const m = line.trim().match(/^\$(discard|boost)(?:=\d+)?,site=([^\s,]+)/);
    if (m) out[m[1]].push(m[2].toLowerCase());
  }
  return out;
}

const hostOf = (url) => (url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0].toLowerCase();

async function webSearch(query, goggle) {
  const url = new URL(WEB_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(RESULT_COUNT));
  if (goggle) url.searchParams.set("goggles", goggle);

  const started = Date.now();
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": searchKey(),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Brave Web Search refused the key (HTTP ${resp.status}). ` +
      "Check that the key is enabled for the Search plan.");
  }
  if (!resp.ok) {
    throw new Error(`Brave Web Search HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const results = (data.web?.results || []).map((r, i) => ({
    rank: i + 1,
    title: r.title || "",
    url: r.url || "",
    site: r.meta_url?.hostname?.replace(/^www\./, "") || hostOf(r.url),
  }));
  return {
    results,
    latency_ms: Date.now() - started,
    // Diagnostics: what Brave actually sent back
    diagnostics: {
      http_status: resp.status,
      response_type: data.type || null,
      top_level_keys: Object.keys(data),
      web_results: data.web?.results?.length ?? null,
      query_sent: data.query?.original ?? query,
      query_altered: data.query?.altered ?? null,
    },
  };
}

export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  let payload = {};
  try { payload = await req.json(); } catch {}
  // Brave Web Search accepts queries up to 400 characters
  const question = String(payload.question || "").trim().slice(0, 400);
  if (!question) return json(400, { error: "There's no question to compare." });

  const accessCode = env("DEMO_ACCESS_CODE");
  if (accessCode && payload.code !== accessCode) {
    return json(401, { error: "Enter the demo access code to compare sources." });
  }
  if (!searchKey()) return json(500, { error: "The site's Brave key isn't set in Netlify." });
  if (rateLimited(context?.ip || "unknown")) {
    return json(429, { error: "Too many requests in a minute. Wait a moment and try again." });
  }

  // Send the shopper's exact question: Web Search handles full questions well
  const searchQuery = question;
  const hosted = env("GOGGLE_URL");
  const goggle = hosted || GOGGLE_RULES;
  try {
    // Both searches run at the same time
    const [standard, goggled] = await Promise.all([
      webSearch(searchQuery, null),
      webSearch(searchQuery, goggle),
    ]);
    return json(200, {
      question,
      search_query: searchQuery,
      standard,
      goggled,
      goggle: {
        name: GOGGLE_NAME,
        source: hosted ? "hosted" : "inline",
        url: hosted || null,
        rules: GOGGLE_RULES,
        sites: ruleSites(GOGGLE_RULES),
      },
      endpoint: "GET /res/v1/web/search",
    });
  } catch (err) {
    return json(502, { error: err.message || "The Brave request failed." });
  }
};

export const config = { path: "/api/compare" };
