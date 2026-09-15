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
| Web Search API | `GET /res/v1/web/search` | Alternate path in the local Python version (`local/`) |

## Project layout

| Path | What it is |
|---|---|
| `public/` | The website: storefront page, recorded answer (`replay.json`), layout sample (`sample.json`) |
| `netlify/functions/ask.mjs` | Server-side Brave call, access code, rate limit |
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

4. Redeploy so the function picks up the variables.
5. Protect your credits: set a monthly credit limit in your Brave dashboard.

## Run it on your own computer

```bash
cd local
python3 -m pip install -r requirements.txt
export BRAVE_API_KEY="your-key"
python3 app.py
```

Open http://127.0.0.1:8000. Successful answers are saved to `local/cache/last_response.json`. Copy that file to `public/replay.json` to update the site's recorded answer.

## Notes

- Brave only returns citations when streaming, so the function reads the stream and assembles the answer before replying.
- Each answer includes Brave's usage data. The "Under the hood" panel shows the searches run, tokens, and cost.
- Lionheart Electronics is fictional. Review content comes live from Brave at the time of each question.
