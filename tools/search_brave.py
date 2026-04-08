"""
tools/search_brave.py

Core search tool for the Business Viability Intelligence System.
Wraps the Brave Search API with:
  - 500ms fixed delay between every call (avoids rate limiting)
  - Exponential backoff on 429 responses (max 3 retries)
  - Per-source cache TTL via Supabase `search_cache` table
  - CLI usage: python tools/search_brave.py --query "..." [--count 10] [--freshness 24]

Returns JSON to stdout so orchestrator or research agents can parse it.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from supabase import create_client

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv()

BRAVE_API_KEY = os.getenv("BRAVE_SEARCH_KEY")
SUPABASE_URL  = os.getenv("SUPABASE_URL")
SUPABASE_KEY  = os.getenv("SUPABASE_SERVICE_KEY")

BRAVE_ENDPOINT  = "https://api.search.brave.com/res/v1/web/search"
FIXED_DELAY_SEC = 0.5   # 500ms between every Brave call
MAX_RETRIES     = 3     # max retry attempts on 429


# ── Supabase client (lazy — only needed when caching is used) ─────────────────

def get_supabase():
    """Create and return a Supabase client. Fails fast if env vars are missing."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise EnvironmentError("SUPABASE_URL or SUPABASE_SERVICE_KEY not set in .env")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Cache helpers ─────────────────────────────────────────────────────────────

def get_cached(supabase, query: str, freshness_hours: int) -> dict | None:
    """
    Return cached results for `query` if they exist and are within the TTL window.
    Returns None if cache miss or stale.
    """
    resp = (
        supabase.table("search_cache")
        .select("results, cached_at")
        .eq("query", query)
        .order("cached_at", desc=True)
        .limit(1)
        .execute()
    )

    if not resp.data:
        return None  # cache miss

    row = resp.data[0]
    cached_at = datetime.fromisoformat(row["cached_at"].replace("Z", "+00:00"))
    age_hours  = (datetime.now(timezone.utc) - cached_at).total_seconds() / 3600

    if age_hours > freshness_hours:
        return None  # stale

    return row["results"]  # cache hit


def save_cache(supabase, query: str, results: dict):
    """
    Upsert search results into the cache table.
    Uses query as the logical key — overwrites existing rows for the same query.
    """
    supabase.table("search_cache").upsert(
        {
            "query":     query,
            "results":   results,
            "cached_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="query",
    ).execute()


# ── Brave API call ────────────────────────────────────────────────────────────

def call_brave(query: str, count: int) -> dict:
    """
    Hit the Brave Search API with fixed delay + exponential backoff on 429s.
    Returns the parsed JSON response or raises on unrecoverable errors.
    """
    if not BRAVE_API_KEY:
        raise EnvironmentError("BRAVE_SEARCH_KEY not set in .env")

    headers = {
        "Accept":              "application/json",
        "Accept-Encoding":     "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
    }
    params = {
        "q":     query,
        "count": min(count, 20),  # Brave max is 20 per call
    }

    for attempt in range(1, MAX_RETRIES + 1):
        # Honour the fixed delay before every call (not just retries)
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.get(BRAVE_ENDPOINT, headers=headers, params=params, timeout=15)
        except httpx.RequestError as exc:
            # Network-level failure — treat as fatal after max retries
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"Network error after {MAX_RETRIES} attempts: {exc}") from exc
            wait = 2 ** attempt
            print(f"[search_brave] Network error on attempt {attempt}, retrying in {wait}s…", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            # Rate limited — exponential backoff
            wait = 2 ** attempt
            print(f"[search_brave] 429 rate limit on attempt {attempt}, retrying in {wait}s…", file=sys.stderr)
            time.sleep(wait)
            continue

        # Any other error code is fatal
        raise RuntimeError(f"Brave API error {resp.status_code}: {resp.text}")

    raise RuntimeError(f"Brave API: still rate-limited after {MAX_RETRIES} retries")


# ── Main ──────────────────────────────────────────────────────────────────────

def search(query: str, count: int = 10, freshness_hours: int = 24, skip_cache: bool = False) -> dict:
    """
    Public entry point. Checks cache first (unless skip_cache=True), then calls Brave.
    Saves fresh results back to cache before returning.
    """
    supabase = get_supabase()

    # 1. Cache check
    if not skip_cache:
        cached = get_cached(supabase, query, freshness_hours)
        if cached:
            print(f"[search_brave] Cache hit for: {query!r}", file=sys.stderr)
            return cached

    # 2. Live Brave call
    print(f"[search_brave] Fetching live: {query!r}", file=sys.stderr)
    results = call_brave(query, count)

    # 3. Persist to cache
    save_cache(supabase, query, results)

    return results


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Brave Search with caching")
    parser.add_argument("--query",      required=True,       help="Search query string")
    parser.add_argument("--count",      type=int, default=10, help="Number of results (max 20)")
    parser.add_argument("--freshness",  type=int, default=24, help="Cache TTL in hours")
    parser.add_argument("--skip-cache", action="store_true",  help="Bypass cache and force live call")
    args = parser.parse_args()

    results = search(
        query         = args.query,
        count         = args.count,
        freshness_hours = args.freshness,
        skip_cache    = args.skip_cache,
    )

    # Output JSON to stdout for piping into orchestrator/agents
    print(json.dumps(results, indent=2))
