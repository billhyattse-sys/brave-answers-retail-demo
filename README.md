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
| Goggles | `goggles` parameter on Web Search | Re-ranks results: removes forums and complaint sites, boosts established review publications |

## Project layout

| Path | What it is |
|---|---|
| `public/` | The website: storefront page, recorded answer (`replay.json`), layout sample (`sample.json`) |
| `netlify/functions/ask.mjs` | Server-side Brave Answers call, access code, rate limit |
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
| `BRAVE_SEARCH_API_KEY` | No | A Search-plan key for the Goggles comparison, if different from `BRAVE_API_KEY` |
| `GOGGLE_URL` | No | Raw GitHub URL of the registered hosted Goggle. If unset, the rules are sent inline |

4. Redeploy so the function picks up the variables.
5. Protect your credits: set a monthly credit limit in your Brave dashboard.

## Goggles

Goggles re-rank Brave's results with simple rules. Under each answer, **Compare sources with Goggles** runs the shopper's question through Web Search twice, with and without the "Trusted Phone Reviews" Goggle, and shows the two source lists side by side.

Goggles work with the Web Search, LLM Context, and News Search APIs, not the Answers API, which is why the comparison uses Web Search.

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

If you change the rules, update both the `.goggle` file and `GOGGLE_RULES` in `compare.mjs`.

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
