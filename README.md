# Brave Answers Retail Assistant

A sample app that shows how a retailer can answer shoppers' buying questions with **current, cited web information** using the [Brave Search API](https://api-dashboard.search.brave.com/). A fictional store, Lionheart Electronics, adds a help widget to its product page. A shopper asks, "Should I upgrade from my iPhone 16?" and gets pros, cons, and a bottom line, with every claim linked to its source.

## How it works

```
Browser (public/index.html)
   │  POST /api/ask
   ▼
Netlify Function (netlify/functions/ask.mjs)   ← holds the Brave key
   │  POST https://api.search.brave.com/res/v1/chat/completions
   ▼
Brave Answers API: searches Brave's index, writes a cited answer, streams it back
```

The page never sees the API key. The function reads it from Netlify's environment variables.

## Brave components used

| Component | Endpoint | Used for |
|---|---|---|
| Answers API | `POST /res/v1/chat/completions` | Search and cited answer in one OpenAI-compatible call |
| Web Search API | `GET /res/v1/web/search` | Goggles comparison panel; alternate path in the local Python version |
| LLM Context API | `GET /res/v1/llm/context` | "Bring your own model" engine: Goggle-filtered, recent page content for Claude to answer from |
| Goggles | `goggles` parameter on Web Search and LLM Context | Re-ranks results: removes forums and complaint sites, boosts established review publications |

## Project layout

| Path | What it is |
|---|---|
| `public/` | The website: storefront page, recorded answer (`replay.json`), layout sample (`sample.json`) |
| `netlify/functions/ask.mjs` | Server-side Brave Answers call, access code, rate limit |
| `netlify/functions/llm-answer.mjs` | LLM Context engine: Brave retrieves trusted, recent sources; Claude writes the cited answer |
| `netlify/functions/compare.mjs` | Goggles comparison: the same question through Web Search with and without the Goggle |
| `goggles/trusted-phone-reviews.goggle` | The Goggle's rules, ready to register as a hosted Goggle |
| `netlify.toml` | Tells Netlify where the site and function live |
| `local/` | Python version for running on your own computer |

## Deploy your own copy

**Prerequisites:** a GitHub account, a Netlify account, and a Brave Search API key with the Answers plan active.

1. Fork or clone this repository into your own GitHub account.
2. In Netlify, choose **Add new project → Import an existing project**, and pick the repository. Netlify reads `netlify.toml`, so there's no build setting to change.
3. In Netlify, go to **Project configuration → Environment variables** and add:

| Variable | Required | Value |
|---|---|---|
| `BRAVE_API_KEY` | Yes | Your Brave key (Answers plan) |
| `DEMO_ACCESS_CODE` | Recommended | A code visitors must enter before asking live questions |
| `RATE_LIMIT_PER_MINUTE` | No | Questions allowed per visitor per minute (default 6) |
| `DEMO_MODE` | No | Set to `replay` to serve only the recorded answer |
| `ANTHROPIC_API_KEY` | For LLM Context mode | Claude key; the engine switch appears only when this and a Search key are set |
| `ANTHROPIC_MODEL` | No | Claude model for LLM Context mode (default `claude-sonnet-5`) |
| `CLAUDE_INPUT_PRICE_PER_M`, `CLAUDE_OUTPUT_PRICE_PER_M`, `BRAVE_SEARCH_PRICE_PER_REQUEST` | No | Prices used for the LLM Context cost estimate (defaults 2, 10, 0.005) |
| `CLAUDE_MAX_TOKENS` | No | Longest answer Claude may write in LLM Context mode (default 600) |
| `LLM_FRESHNESS` | No | LLM Context freshness filter (default `pm`, past month; empty for any date) |
| `BRAVE_SEARCH_API_KEY` | Recommended | A Search-plan key for the Goggles comparison, if different from `BRAVE_API_KEY` |
| `GOGGLE_URL` | No | Raw GitHub URL of the registered hosted Goggle. If unset, the rules are sent inline |

4. Redeploy so the function picks up the variables.
5. Protect your credits: set a monthly credit limit in your Brave dashboard.

## Two answer engines

The help widget has an **Answer engine** switch:

| Engine | How it works | Keys |
|---|---|---|
| **Brave Answers** | Brave searches its index and its own model writes the cited answer | `BRAVE_API_KEY` (Answers plan) |
| **LLM Context + Claude** | Brave LLM Context returns page content filtered by the Goggle and limited to recent pages; Claude writes the cited answer from only those sources | `BRAVE_SEARCH_API_KEY` (Search plan, which includes LLM Context) + `ANTHROPIC_API_KEY` |

Answers is the fastest path to a cited answer. LLM Context lets the retailer choose its own model and voice, and it's where Goggles shape the written answer, because Goggles don't apply to the Answers API. If no recent pages match, the function retries without the freshness filter and says so under **Under the hood**.

In LLM Context mode, Claude's answer **streams**: words appear as they're written, then the finished answer (citations, sources, cost) replaces the draft. Answers are kept short (at most three bullets per section) for speed. **Under the hood** shows the time to first word and the total model time.

## ROI calculator

`public/roi.html` (linked as **ROI calculator** in the store header) turns cost per answer into business value:

- **Headline:** how many answers one kept sale pays for (profit per sale / cost per answer).
- **Monthly picture:** answer cost, extra orders and gross profit, returns avoided, support savings, net benefit, and return on answer spend.
- **Break-even:** how many extra sales a month cover the answer cost.

Cost presets: **Brave Answers** uses a measured live run ($0.0539: 1 search, 9,512 tokens in, 476 out, at $4 per 1,000 queries plus $5 per million tokens). **LLM Context + Claude** is estimated from one Search-plan request ($5 per 1,000) plus Claude Sonnet 5 tokens at $2 / $10 per million. Every answer's **Under the hood** panel links to the calculator with that answer's cost filled in. Traffic, conversion, return, and support defaults are illustrative assumptions; replace them with real data, and check current pricing before quoting.

## Goggles

Goggles re-rank Brave's results with simple rules. Under each answer, **Compare sources with Goggles** runs the shopper's question through Web Search twice, with and without the "Trusted Phone Reviews" Goggle, and shows the two source lists side by side.

Goggles work with the Web Search, LLM Context, and News Search APIs, not the Answers API. The comparison panel uses Web Search (two calls with the shopper's exact question) to show the effect side by side, and it is separate from the answer engine; the LLM Context engine applies the same Goggle to the answer itself.

Web Search powers the comparison because a ranked list makes the Goggle's effect easy to see. In a production retail assistant, the shopper-facing answer would use LLM Context (or Answers); Web Search would serve internal tools such as Goggle tuning.

The rules live in `goggles/trusted-phone-reviews.goggle`:

```
$discard,site=quora.com
$discard,site=trustpilot.com
$discard,site=consumeraffairs.com
$boost=4,site=gsmarena.com
$boost=4,site=theverge.com
...
```

By default the function sends these rules inline, which works immediately. To use the hosted file instead:

1. Register its raw GitHub URL at https://search.brave.com/goggles/create.
2. Set `GOGGLE_URL` in Netlify to that URL and redeploy.

If you change the rules, update the `.goggle` file and `GOGGLE_RULES` in both `compare.mjs` and `llm-answer.mjs`.

## Run it on your own computer

```bash
cd local
python3 -m pip install -r requirements.txt
export BRAVE_API_KEY="your-key"
python3 app.py
```

Open http://127.0.0.1:8000. The Goggles comparison runs on the website version only. Successful answers are saved to `local/cache/last_response.json`. Copy that file to `public/replay.json` to update the site's recorded answer.

## Notes

- Brave only returns citations when streaming, so the function reads the stream and assembles the answer before replying.
- Each answer includes Brave's usage data. The "Under the hood" panel shows the searches run, tokens, and cost.
- Lionheart Electronics is fictional. Review content comes live from Brave at the time of each question.
