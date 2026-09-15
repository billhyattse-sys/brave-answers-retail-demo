"""
app.py  —  Retail shopping-assistant demo grounded by the Brave Search API.

Answer engines (ANSWER_ENGINE env var):
  brave   (default) Brave Answers API — Brave searches AND writes the cited
          answer in one call to /res/v1/chat/completions. Brave key only.
  claude  Brave Web Search (brave_client.py) retrieves results, then Claude
          writes the pros/cons. Needs ANTHROPIC_API_KEY too.
  none    Brave Web Search results only, no written answer.

Modes (DEMO_MODE env var):
  live    (default) call the APIs;
          every successful live answer is saved to cache/last_response.json
  replay  serve local/cache/last_response.json — a real answer recorded earlier,
          so the demo still works if the Wi-Fi doesn't
  sample  serve sample_response.json — placeholder text for testing the UI

Standard library + requests only.  Start with:  python app.py
"""
import json
import os
import re
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import requests

from brave_client import fetch_brave_search_results

ROOT = Path(__file__).parent
STATIC = ROOT.parent / "public"
CACHE = ROOT / "cache" / "last_response.json"
SAMPLE = ROOT.parent / "public" / "sample.json"

PORT = int(os.getenv("PORT", "8000"))
DEMO_MODE = os.getenv("DEMO_MODE", "live").lower()
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5")
ANSWER_ENGINE = os.getenv("ANSWER_ENGINE", "brave").lower()
BRAVE_ANSWERS_URL = os.getenv("BRAVE_ANSWERS_URL",
                              "https://api.search.brave.com/res/v1/chat/completions")


def answers_key():
    return os.getenv("BRAVE_ANSWERS_API_KEY") or os.getenv("BRAVE_API_KEY")


# ---------- Brave Answers step --------------------------------------------

ANSWERS_FORMAT_DECISION = (
    "\n\nAnswer for a shopper using an electronics store's app. Use this format: "
    "a two-sentence summary; a heading 'Reasons to upgrade' with 3-5 bullet points; "
    "a heading 'Reasons to wait' with 3-5 bullet points; then one line starting "
    "'Bottom line:'. Base it on independent reviews and current reporting."
)
ANSWERS_FORMAT_GENERAL = (
    "\n\nAnswer for a shopper using an electronics store's app. Keep it short: "
    "a two-sentence summary, then up to 5 bullet points, then one line starting "
    "'Bottom line:'. Base it on independent reviews and current reporting."
)
DECISION_WORDS = re.compile(r"\b(upgrade|pros?|cons?|worth|should i|switch|wait)\b", re.I)


def answers_format(question: str) -> str:
    return ANSWERS_FORMAT_DECISION if DECISION_WORDS.search(question) else ANSWERS_FORMAT_GENERAL

CITE_RE = re.compile(r"<citation>(.*?)</citation>", re.S)
USAGE_RE = re.compile(r"<usage>(.*?)</usage>", re.S)


def parse_answers_stream(full: str):
    """Turn Brave's tagged stream text into (answer_text, citations, usage)."""
    usage = {}
    m = USAGE_RE.search(full)
    if m:
        try:
            usage = json.loads(m.group(1))
        except ValueError:
            pass
    full = USAGE_RE.sub("", full)

    citations = {}
    def swap(match):
        try:
            c = json.loads(match.group(1))
        except ValueError:
            return ""
        n = c.get("number")
        if n is None:
            return ""
        citations.setdefault(n, c)
        return f"[{n}]"
    text = CITE_RE.sub(swap, full)
    text = re.sub(r"(\[(\d+)\])(?:\s*\[\2\])+", r"\1", text)  # collapse [1][1]
    return text.strip(), [citations[k] for k in sorted(citations)], usage


def brave_answer(question: str):
    key = answers_key()
    if not key:
        raise RuntimeError("BRAVE_API_KEY environment variable not set.")
    body = {
        "model": "brave",
        "stream": True,                      # citations require streaming
        "enable_citations": True,
        "country": os.getenv("BRAVE_COUNTRY", "us"),
        "language": "en",
        "messages": [{"role": "user", "content": question + answers_format(question)}],
    }
    started = time.perf_counter()
    try:
        resp = requests.post(
            BRAVE_ANSWERS_URL,
            headers={"Content-Type": "application/json",
                     "x-subscription-token": key},
            json=body, stream=True, timeout=(10, 120),
        )
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Brave Answers request failed: {e}")
    if resp.status_code in (401, 403):
        raise RuntimeError(
            f"Brave Answers refused the key (HTTP {resp.status_code}). Check that this key "
            "is enabled for the Answers plan, or set BRAVE_ANSWERS_API_KEY to one that is.")
    if resp.status_code >= 400:
        raise RuntimeError(f"Brave Answers HTTP {resp.status_code}: {resp.text[:300]}")

    resp.encoding = "utf-8"
    parts = []
    for line in resp.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except ValueError:
            continue
        for ch in chunk.get("choices", []):
            piece = (ch.get("delta") or {}).get("content")
            if piece:
                parts.append(piece)
    elapsed = int((time.perf_counter() - started) * 1000)

    text, citations, usage = parse_answers_stream("".join(parts))
    if not text:
        raise RuntimeError("Brave Answers returned an empty answer.")
    sources = []
    for c in citations:
        url = c.get("url", "")
        host = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
        sources.append({"number": c.get("number"), "title": host or url, "url": url,
                        "description": (c.get("snippet") or "")[:240], "site": host})
    meta = {
        "endpoint": "POST /res/v1/chat/completions",
        "query": question,
        "params": {k: body[k] for k in ("model", "stream", "enable_citations", "country")},
        "latency_ms": elapsed,
        "result_count": len(sources),
        "usage": {k.replace("X-Request-", ""): v for k, v in usage.items()},
    }
    return text, sources, meta


# ---------- LLM step ------------------------------------------------------

def call_claude(system: str, user: str, max_tokens: int = 1200) -> str:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=60,
    )
    resp.raise_for_status()
    return "".join(b.get("text", "") for b in resp.json().get("content", []))


def to_search_query(question: str) -> str:
    """Shopper question -> short web query. Uses Claude if available."""
    if ANSWER_ENGINE == "claude" and os.getenv("ANTHROPIC_API_KEY"):
        try:
            q = call_claude(
                "Rewrite the shopper's question as one short web search query "
                "(under 12 words) that would find independent reviews. "
                "Reply with the query only.",
                question, max_tokens=60,
            ).strip().strip('"')
            if q:
                return q
        except Exception:
            pass
    return question


ANSWER_SYSTEM = """You are the in-app shopping assistant for an electronics retailer.
Answer ONLY from the numbered web sources provided. Do not use outside knowledge.
If the sources don't support a point, leave it out. Cite sources by number.
Reply with JSON only, no markdown fences, in exactly this shape:
{"summary": "2-3 sentence direct answer",
 "pros": [{"text": "...", "sources": [1]}],
 "cons": [{"text": "...", "sources": [2]}],
 "verdict": "one sentence on who should upgrade and who should wait"}
Give 3-5 pros and 3-5 cons, each under 30 words."""


def write_answer(question: str, results: list) -> dict:
    numbered = []
    for i, r in enumerate(results, start=1):
        extra = " ".join(r.get("extra_snippets") or [])
        numbered.append(f"[{i}] {r['title']} ({r['site']})\n{r['description']} {extra}".strip())
    user = f"Shopper question: {question}\n\nSources:\n\n" + "\n\n".join(numbered)
    raw = call_claude(ANSWER_SYSTEM, user)
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip()).strip()
    return json.loads(raw)


# ---------- Pipeline ------------------------------------------------------

def answer_question(question: str) -> dict:
    if DEMO_MODE == "replay":
        if not CACHE.exists():
            raise RuntimeError("Replay mode is on but no recording exists yet. "
                               "Run one question in live mode first.")
        data = json.loads(CACHE.read_text())
        data["mode"] = "replay"
        return data
    if DEMO_MODE == "sample":
        data = json.loads(SAMPLE.read_text())
        data["mode"] = "sample"
        return data

    started = time.perf_counter()
    if ANSWER_ENGINE == "brave":
        text, sources, meta = brave_answer(question)
        data = {"mode": "live", "engine": "brave-answers", "question": question,
                "answer": None, "answer_text": text, "answer_note": None,
                "sources": sources, "brave": meta,
                "total_ms": int((time.perf_counter() - started) * 1000)}
        CACHE.parent.mkdir(exist_ok=True)
        CACHE.write_text(json.dumps(data, indent=2))
        return data

    query = to_search_query(question)
    results, meta = fetch_brave_search_results(query)

    answer, answer_note = None, None
    if not results:
        answer_note = "Brave returned no web results for this query."
    elif ANSWER_ENGINE == "claude" and os.getenv("ANTHROPIC_API_KEY"):
        try:
            answer = write_answer(question, results)
        except Exception as e:
            answer_note = f"The answer step failed ({e.__class__.__name__}); showing sources only."
    else:
        answer_note = ("Answer step is off (ANSWER_ENGINE=none, or ANTHROPIC_API_KEY missing). "
                       "Showing Brave's web results only.")

    for i, r in enumerate(results, start=1):
        r["number"] = i
    data = {
        "mode": "live",
        "engine": "web-search" + ("+claude" if answer else ""),
        "question": question,
        "answer": answer,
        "answer_note": answer_note,
        "sources": results,
        "brave": meta,
        "total_ms": int((time.perf_counter() - started) * 1000),
    }
    if answer:
        CACHE.parent.mkdir(exist_ok=True)
        CACHE.write_text(json.dumps(data, indent=2))
    return data


# ---------- HTTP ----------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            return self._json(200, {
                "mode": DEMO_MODE,
                "engine": ANSWER_ENGINE,
                "brave_key": bool(answers_key()),
                "llm_key": bool(os.getenv("ANTHROPIC_API_KEY")),
                "recording": CACHE.exists(),
            })
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/ask":
            return self._json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            question = (json.loads(self.rfile.read(length) or b"{}").get("question") or "").strip()
            if not question:
                return self._json(400, {"error": "Type a question first."})
            return self._json(200, answer_question(question[:500]))
        except RuntimeError as e:
            return self._json(502, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": f"{e.__class__.__name__}: {e}"})

    def log_message(self, fmt, *args):
        print("  " + fmt % args)


if __name__ == "__main__":
    print(f"\nRetail demo running at http://127.0.0.1:{PORT}   (mode: {DEMO_MODE})")
    print(f"  Answer engine: {ANSWER_ENGINE}   Brave key: {'set' if answers_key() else 'MISSING'}")
    if ANSWER_ENGINE == "claude":
        print(f"  Claude key: {'set' if os.getenv('ANTHROPIC_API_KEY') else 'MISSING (sources only)'}")
    print()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
