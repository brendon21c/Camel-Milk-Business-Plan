"""
tools/search_perplexity.py

Fallback search tool using the Perplexity Sonar API.
Returns AI-synthesized answers with inline citations — different from
Brave's raw web results. Use this when Brave returns fewer than 3 useful
results for a query, or when you need a synthesized factual answer
with cited sources rather than a list of web pages to parse.

When to use vs. Brave Search:
  - Brave: broad coverage, raw results, good for competitive scanning
  - Perplexity: synthesized answer + citations, good for "what is the current
    state of X" factual lookups (regulatory rules, market sizes, standards)

Pricing tier: Sonar (not Sonar Pro).
  ~$1 per 1,000 requests + token costs. Cheap for this scale.

CLI usage:
  python tools/search_perplexity.py --query "FDA import requirements for camel milk powder"
  python tools/search_perplexity.py --query "US specialty dairy market size 2025" --model sonar-pro

Returns JSON to stdout with the answer text and source citations.
"""

import argparse
import json
import os
import sys
import time

import httpx
from dotenv import load_dotenv

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv()

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")

PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"

# Model options — Sonar is the balanced tier (recommended for this system)
# Sonar Pro has deeper reasoning but costs 5x more per request
DEFAULT_MODEL = "sonar"   # Balanced tier

FIXED_DELAY_SEC = 0.25
MAX_RETRIES     = 3

# System prompt — instructs Perplexity to be factual and cite sources
SYSTEM_PROMPT = (
    "You are a business intelligence research assistant. "
    "Answer the query with specific, factual information. "
    "Cite your sources inline using [1], [2], etc. "
    "Be concise — prioritise facts, figures, and regulatory specifics. "
    "Do not speculate. If you are uncertain, say so clearly."
)


# ── API call ──────────────────────────────────────────────────────────────────

def call_perplexity(query: str, model: str = DEFAULT_MODEL) -> dict:
    """
    Send a query to the Perplexity Sonar API and return the response.
    Returns a dict with the answer text and structured citations.
    """
    if not PERPLEXITY_API_KEY:
        raise EnvironmentError(
            "PERPLEXITY_API_KEY not set in .env. "
            "Get a key at: https://www.perplexity.ai/settings/api"
        )

    headers = {
        "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
        "Content-Type":  "application/json",
    }

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": query},
        ],
        # Return citations as a structured list alongside the answer
        "return_citations":   True,
        "return_related_questions": False,  # Not needed for our use case
        "temperature": 0.1,   # Low temperature — we want factual, consistent answers
    }

    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.post(PERPLEXITY_URL, headers=headers, json=body, timeout=30)
        except httpx.RequestError as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"[perplexity] Network error after {MAX_RETRIES} attempts: {exc}") from exc
            wait = 2 ** attempt
            print(f"[perplexity] Network error attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"[perplexity] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        raise RuntimeError(f"[perplexity] HTTP {resp.status_code}: {resp.text[:500]}")

    raise RuntimeError(f"[perplexity] Still rate-limited after {MAX_RETRIES} retries")


# ── Result parser ─────────────────────────────────────────────────────────────

def parse_response(raw: dict, query: str) -> dict:
    """
    Extract the answer text and citations from a Perplexity API response.
    Returns a structured dict suitable for agent consumption.

    Unlike Brave (which returns a list of results to parse), Perplexity
    returns a synthesized answer. Agents can use the answer text directly
    and should treat citations as source URLs for the report sources list.
    """
    choices = raw.get("choices", [])
    if not choices:
        return {
            "source":  "Perplexity Sonar",
            "query":   query,
            "answer":  None,
            "error":   "No choices returned from API",
            "sources": [],
        }

    message    = choices[0].get("message", {})
    answer     = message.get("content", "")

    # Citations come back as a list of URLs in the top-level response
    citations  = raw.get("citations", [])

    # Usage stats — useful for monitoring costs
    usage      = raw.get("usage", {})

    return {
        "source":        "Perplexity Sonar",
        "model":         raw.get("model", DEFAULT_MODEL),
        "query":         query,
        "answer":        answer,
        "sources":       [
            {"url": url, "index": i + 1}
            for i, url in enumerate(citations)
        ],
        "usage": {
            "prompt_tokens":     usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "total_tokens":      usage.get("total_tokens"),
        },
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def search(query: str, model: str = DEFAULT_MODEL) -> dict:
    """
    Public entry point. Runs a Perplexity query and returns a parsed result.
    Agents should call this as a fallback when Brave returns thin results.
    """
    print(f"[perplexity] Querying ({model}): {query!r}", file=sys.stderr)
    raw    = call_perplexity(query, model)
    result = parse_response(raw, query)
    print(
        f"[perplexity] Answer: {len(result.get('answer', '') or '')} chars, "
        f"{len(result.get('sources', []))} citations",
        file=sys.stderr,
    )
    return result


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Query Perplexity Sonar for synthesized answers with citations"
    )
    parser.add_argument("--query", required=True,
                        help="Research question or factual query")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        choices=["sonar", "sonar-pro"],
                        help="Perplexity model (default: sonar)")
    args = parser.parse_args()

    result = search(query=args.query, model=args.model)
    print(json.dumps(result, indent=2))
