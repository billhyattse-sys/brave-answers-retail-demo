"""
brave_client.py
Refactored from brave_demo_bestbuy2.py: same endpoint, same headers, same
error handling, but it RETURNS the results so the web demo can use them.
Run it directly and it still prints results like the original script.
"""
import os
import time
import requests

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"


def fetch_brave_search_results(query: str, count: int = 8):
    """Call Brave Web Search. Returns (results, meta). Raises RuntimeError on failure."""
    api_key = os.getenv("BRAVE_API_KEY")
    if not api_key:
        raise RuntimeError("BRAVE_API_KEY environment variable not set.")

    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": api_key,
    }
    params = {"q": query, "count": count}

    # Optional extras, off by default. Confirm your plan supports them in
    # Brave's API docs before turning them on.
    if os.getenv("BRAVE_EXTRA_SNIPPETS") == "1":
        params["extra_snippets"] = "true"
    if os.getenv("BRAVE_GOGGLES"):
        params["goggles"] = os.getenv("BRAVE_GOGGLES")

    started = time.perf_counter()
    try:
        response = requests.get(BRAVE_URL, headers=headers, params=params, timeout=10)
        response.raise_for_status()
    except requests.exceptions.HTTPError as http_err:
        raise RuntimeError(f"Brave HTTP error: {http_err} - Response: {response.text[:300]}")
    except requests.exceptions.RequestException as err:
        raise RuntimeError(f"Brave request failed: {err}")
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    data = response.json()
    results = []
    for item in data.get("web", {}).get("results", []):
        results.append({
            "title": item.get("title", "No Title"),
            "url": item.get("url", ""),
            "description": item.get("description", ""),
            "extra_snippets": item.get("extra_snippets", []),
            "age": item.get("age", ""),
            "site": (item.get("meta_url") or {}).get("hostname", ""),
        })

    meta = {
        "endpoint": "/res/v1/web/search",
        "query": query,
        "params": {k: v for k, v in params.items() if k != "q"},
        "latency_ms": elapsed_ms,
        "result_count": len(results),
    }
    return results, meta


if __name__ == "__main__":
    q = "Tech Reviews of pros and cons of upgrading to iPhone 18"
    try:
        results, meta = fetch_brave_search_results(q, count=5)
    except RuntimeError as e:
        print(e)
    else:
        print(f"\n--- Top Search Results for: '{q}' ({meta['latency_ms']} ms) ---\n")
        for idx, r in enumerate(results, start=1):
            print(f"[{idx}] {r['title']}")
            print(f"    URL: {r['url']}")
            print(f"    Snippet: {r['description']}\n")
