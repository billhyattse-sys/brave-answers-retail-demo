// netlify/functions/llm-answer.mjs
// "Bring your own model": Brave LLM Context retrieves Goggle-filtered,
// recent page content, and the retailer's own model (Claude) writes the
// cited answer.
//
//   POST /api/llm-answer   { question, code }  -> same shape as /api/ask
//
// Keys (Netlify environment variables):
//   BRAVE_SEARCH_API_KEY  Search plan (includes LLM Context)
//   ANTHROPIC_API_KEY     Claude
// Optional: ANTHROPIC_MODEL (default claude-sonnet-5), LLM_FRESHNESS (default pm),
//           GOGGLE_URL (hosted Goggle instead of the inline rules)

const LLM_CONTEXT_URL =
  env("BRAVE_LLM_CONTEXT_URL") || "https://api.search.brave.com/res/v1/llm/context";
const ANTHROPIC_URL = env("ANTHROPIC_URL") || "https://api.anthropic.com/v1/messages";
const MODEL = env("ANTHROPIC_MODEL") || "claude-sonnet-5";
const FRESHNESS = env("LLM_FRESHNESS") ?? "pm"; // pages from the past month
const RATE_LIMIT = Number(env("RATE_LIMIT_PER_MINUTE") || 6);

// Same rules as goggles/trusted-phone-reviews.goggle and compare.mjs
const GOGGLE_RULES = [
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

const hostOf = (url) => (url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0].toLowerCase();

// ---------- Step 1: Brave LLM Context ----------
async function llmContext(question, freshness) {
  const url = new URL(LLM_CONTEXT_URL);
  url.searchParams.set("q", question.slice(0, 600));
  url.searchParams.set("count", "20");
  url.searchParams.set("maximum_number_of_urls", "10");
  url.searchParams.set("maximum_number_of_tokens", "6000");
  url.searchParams.set("goggles", env("GOGGLE_URL") || GOGGLE_RULES);
  if (freshness) url.searchParams.set("freshness", freshness);

  const started = Date.now();
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": searchKey(),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 401 || resp.status === 403 || resp.status === 422) {
    const detail = (await resp.text()).slice(0, 200);
    throw new Error(`Brave LLM Context refused the key (HTTP ${resp.status}). ` +
      `Check that BRAVE_SEARCH_API_KEY is a Search-plan key. ${detail}`);
  }
  if (!resp.ok) {
    throw new Error(`Brave LLM Context HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const items = (data.grounding?.generic || [])
    .filter((g) => g.url && (g.snippets || []).length)
    .map((g, i) => ({
      number: i + 1,
      url: g.url,
      title: g.title || hostOf(g.url),
      site: hostOf(g.url),
      snippets: g.snippets,
    }));
  return { items, latency_ms: Date.now() - started };
}

// ---------- Step 2: Claude writes the answer ----------
const DECISION_WORDS = /\b(upgrade|pros?|cons?|worth|should i|switch|wait)\b/i;

function systemPrompt(question) {
  const format = DECISION_WORDS.test(question)
    ? "Format: a two-sentence summary; a heading line 'Reasons to upgrade' followed by 3-5 bullet points starting with '- '; a heading line 'Reasons to wait' followed by 3-5 bullet points; then one line starting 'Bottom line:'."
    : "Format: a two-sentence summary, then up to 5 bullet points starting with '- ', then one line starting 'Bottom line:'.";
  return [
    "You are the in-app shopping assistant for Lionheart Electronics.",
    "Answer ONLY from the numbered sources provided. Do not use outside knowledge.",
    "After each claim, cite its source number in square brackets, like [2]. Cite only numbers that appear in the sources.",
    "If the sources don't answer the question, say so plainly and summarize what they do cover.",
    "Write for a shopper: clear, balanced, no hype. Use plain text; headings are plain lines, not markdown symbols.",
    format,
  ].join("\n");
}

async function claudeAnswer(question, items) {
  const sourcesText = items.map((s) =>
    `[${s.number}] ${s.title} (${s.site})\n${s.snippets.join("\n").slice(0, 3000)}`).join("\n\n");
  const started = Date.now();
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt(question),
      messages: [{ role: "user", content: `Shopper question: ${question}\n\nSources:\n\n${sourcesText}` }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (resp.status === 401) throw new Error("Claude refused the key (HTTP 401). Check ANTHROPIC_API_KEY in Netlify.");
  if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { text, usage: data.usage || {}, latency_ms: Date.now() - started, model: data.model || MODEL };
}

// ---------- HTTP handler ----------
export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  let payload = {};
  try { payload = await req.json(); } catch {}
  const question = String(payload.question || "").trim().slice(0, 500);
  if (!question) return json(400, { error: "Type a question first." });

  const accessCode = env("DEMO_ACCESS_CODE");
  if (accessCode && payload.code !== accessCode) {
    return json(401, { error: "Enter the demo access code to ask live questions." });
  }
  if (!searchKey()) return json(500, { error: "BRAVE_SEARCH_API_KEY isn't set in Netlify." });
  if (!env("ANTHROPIC_API_KEY")) return json(500, { error: "ANTHROPIC_API_KEY isn't set in Netlify." });
  if (rateLimited(context?.ip || "unknown")) {
    return json(429, { error: "Too many questions in a minute. Wait a moment and try again." });
  }

  const started = Date.now();
  try {
    // Recent pages first; if nothing recent matches, widen to any date
    let freshnessUsed = FRESHNESS;
    let ctx = await llmContext(question, FRESHNESS);
    if (!ctx.items.length && FRESHNESS) {
      freshnessUsed = "any date (no recent pages matched)";
      ctx = await llmContext(question, "");
    }
    if (!ctx.items.length) {
      return json(200, {
        mode: "live", engine: "llm-context+claude", question, answer: null,
        answer_text: null, answer_note: "Brave LLM Context returned no sources for this question.",
        sources: [], brave: { endpoint: "GET /res/v1/llm/context", query: question, params: {}, latency_ms: ctx.latency_ms, result_count: 0 },
        total_ms: Date.now() - started,
      });
    }

    const answer = await claudeAnswer(question, ctx.items);

    // Show only the sources Claude actually cited (keeping their numbers)
    const cited = new Set([...answer.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const shown = ctx.items.filter((s) => cited.has(s.number));
    const sources = (shown.length ? shown : ctx.items).map((s) => ({
      number: s.number, title: s.title, url: s.url, site: s.site,
      description: s.snippets[0]?.slice(0, 240) || "",
    }));

    return json(200, {
      mode: "live",
      engine: "llm-context+claude",
      question,
      answer: null,
      answer_text: answer.text,
      answer_note: null,
      sources,
      brave: {
        endpoint: "GET /res/v1/llm/context",
        query: question,
        params: { goggles: env("GOGGLE_URL") ? "hosted" : "inline Trusted Phone Reviews",
                  freshness: freshnessUsed, maximum_number_of_urls: 10, maximum_number_of_tokens: 6000 },
        latency_ms: ctx.latency_ms,
        result_count: ctx.items.length,
        usage: { "Tokens-In": answer.usage.input_tokens, "Tokens-Out": answer.usage.output_tokens },
        extra: {
          "Answer model": answer.model,
          "Model time": answer.latency_ms + " ms",
          "Sources retrieved / cited": `${ctx.items.length} / ${shown.length}`,
        },
      },
      total_ms: Date.now() - started,
    });
  } catch (err) {
    return json(502, { error: err.message || "The request failed." });
  }
};

export const config = { path: "/api/llm-answer" };
