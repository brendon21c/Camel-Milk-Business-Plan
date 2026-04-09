"""
tools/fetch_fda_data.py

Fetches food safety and regulatory data from the openFDA API.
Covers food enforcement actions (recalls), food adverse events, and
ingredient/product searches. All endpoints are free; the API key
raises the rate limit from 240 to 1000 req/min.

Relevant for: regulatory workflow, risk assessment, food safety standards.

CLI usage:
  python tools/fetch_fda_data.py --endpoint food_enforcement --search "camel milk" --limit 10
  python tools/fetch_fda_data.py --endpoint food_event --search "dairy powder" --limit 10

Endpoints:
  food_enforcement  — FDA food recall/enforcement actions
  food_event        — FDA food adverse event reports (CAERS)

Returns JSON to stdout for agent consumption.
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

FDA_API_KEY = os.getenv("OPEN_FDA_API_KEY")  # Raises rate limit if present

# openFDA base URL — all endpoints live under this
FDA_BASE_URL = "https://api.fda.gov"

# Endpoint paths by logical name
ENDPOINT_MAP = {
    "food_enforcement": "/food/enforcement.json",  # Food recalls and enforcement
    "food_event":       "/food/event.json",         # Consumer adverse event reports
}

FIXED_DELAY_SEC = 0.25   # 250ms between calls (well within rate limit)
MAX_RETRIES     = 3


# ── FDA API call ──────────────────────────────────────────────────────────────

def call_fda(endpoint_key: str, search: str, limit: int) -> dict:
    """
    Query a single openFDA endpoint with retry logic.
    Uses the API key if available; falls back to unauthenticated (lower rate limit).
    Returns parsed JSON or raises on unrecoverable error.
    """
    if endpoint_key not in ENDPOINT_MAP:
        raise ValueError(f"Unknown endpoint '{endpoint_key}'. Choose from: {list(ENDPOINT_MAP)}")

    path = ENDPOINT_MAP[endpoint_key]
    url  = FDA_BASE_URL + path

    params = {
        "search": search,
        "limit":  min(limit, 100),  # openFDA max per request is 100
    }

    # API key is optional but raises the rate limit significantly
    if FDA_API_KEY:
        params["api_key"] = FDA_API_KEY

    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.get(url, params=params, timeout=20)
        except httpx.RequestError as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"Network error after {MAX_RETRIES} attempts: {exc}") from exc
            wait = 2 ** attempt
            print(f"[fetch_fda] Network error attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            # Rate limited — back off and retry
            wait = 2 ** attempt
            print(f"[fetch_fda] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 404:
            # No results for this search — return empty structure, not an error
            print(f"[fetch_fda] No results found for: {search!r}", file=sys.stderr)
            return {"meta": {"results": {"total": 0, "skip": 0, "limit": limit}}, "results": []}

        raise RuntimeError(f"openFDA API error {resp.status_code}: {resp.text[:500]}")

    raise RuntimeError(f"openFDA: still rate-limited after {MAX_RETRIES} retries")


# ── Result summariser ─────────────────────────────────────────────────────────

def summarise_enforcement(data: dict) -> dict:
    """
    Extract the most relevant fields from food enforcement results for agent use.
    Full raw data is included for completeness; summary is for quick scanning.
    """
    results = data.get("results", [])
    total   = data.get("meta", {}).get("results", {}).get("total", 0)

    # Pull key fields from each enforcement record
    summaries = []
    for r in results:
        summaries.append({
            "recall_number":      r.get("recall_number"),
            "product_description": r.get("product_description"),
            "reason_for_recall":  r.get("reason_for_recall"),
            "status":             r.get("status"),
            "classification":     r.get("classification"),   # Class I/II/III
            "recalling_firm":     r.get("recalling_firm"),
            "product_type":       r.get("product_type"),
            "recall_initiation_date": r.get("recall_initiation_date"),
            "distribution_pattern":   r.get("distribution_pattern"),
        })

    return {
        "source":      "openFDA food/enforcement",
        "total_found": total,
        "returned":    len(summaries),
        "records":     summaries,
    }


def summarise_events(data: dict) -> dict:
    """
    Extract relevant fields from food adverse event (CAERS) results.
    """
    results = data.get("results", [])
    total   = data.get("meta", {}).get("results", {}).get("total", 0)

    summaries = []
    for r in results:
        # Each event can have multiple products and reactions
        products  = [p.get("name_brand", "unknown") if isinstance(p, dict) else str(p)
                     for p in r.get("products", [])]
        # FDA CAERS reactions can come back as dicts {"name": "..."} or plain strings
        reactions = [rx.get("name", "unknown") if isinstance(rx, dict) else str(rx)
                     for rx in r.get("reactions", [])]

        summaries.append({
            "report_number":  r.get("report_number"),
            "date_created":   r.get("date_created"),
            "outcomes":       r.get("outcomes", []),
            "products":       products,
            "reactions":      reactions,
        })

    return {
        "source":      "openFDA food/event (CAERS)",
        "total_found": total,
        "returned":    len(summaries),
        "records":     summaries,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def fetch_fda(endpoint: str, search: str, limit: int = 10) -> dict:
    """
    Public entry point. Fetches and summarises FDA data for agent use.
    Returns a structured dict with metadata and summarised records.
    """
    print(f"[fetch_fda] Querying {endpoint} for: {search!r}", file=sys.stderr)
    raw = call_fda(endpoint, search, limit)

    # Apply the correct summariser based on endpoint
    if endpoint == "food_enforcement":
        return summarise_enforcement(raw)
    elif endpoint == "food_event":
        return summarise_events(raw)
    else:
        # Unknown endpoint — return raw data with a note
        return {"source": f"openFDA {endpoint}", "raw": raw}


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch FDA food safety data")
    parser.add_argument("--endpoint", required=True,
                        choices=list(ENDPOINT_MAP.keys()),
                        help="Which openFDA endpoint to query")
    parser.add_argument("--search",   required=True,
                        help="Search string (openFDA Lucene syntax, e.g. 'camel milk')")
    parser.add_argument("--limit",    type=int, default=10,
                        help="Max results to return (max 100)")
    args = parser.parse_args()

    result = fetch_fda(
        endpoint = args.endpoint,
        search   = args.search,
        limit    = args.limit,
    )

    # Output JSON to stdout for piping into orchestrator/agents
    print(json.dumps(result, indent=2))
