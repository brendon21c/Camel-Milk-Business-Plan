"""
tools/fetch_usda_data.py

Fetches food and agricultural data from two USDA APIs:

  1. USDA FoodData Central (FDC) — nutritional composition data for foods.
     Useful for: health claims research, nutritional fact verification,
     ingredient breakdown for labeling compliance.
     API key: optional (DEMO_KEY used if none set). Get a free key at:
     https://fdc.nal.usda.gov/api-guide.html

  2. USDA NASS QuickStats — agricultural statistics (production volumes,
     prices, farm counts). Useful for: supply chain research, production
     cost estimation, commodity price benchmarking.
     API key: required (free). Register at:
     https://quickstats.nass.usda.gov/api

CLI usage:
  python tools/fetch_usda_data.py --source fdc --query "camel milk" --limit 5
  python tools/fetch_usda_data.py --source nass --commodity "MILK" --state "CA" --year 2023

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

# FDC API key — falls back to DEMO_KEY (100 req/hr) if not set
FDC_API_KEY  = os.getenv("USDA_FDC_API_KEY", "DEMO_KEY")

# NASS API key — required for QuickStats
NASS_API_KEY = os.getenv("USDA_NASS_API_KEY")

FDC_BASE_URL  = "https://api.nal.usda.gov/fdc/v1"
NASS_BASE_URL = "https://quickstats.nass.usda.gov/api"

FIXED_DELAY_SEC = 0.25
MAX_RETRIES     = 3


# ── Shared HTTP helper ────────────────────────────────────────────────────────

def get_with_retry(url: str, params: dict, label: str) -> dict:
    """
    GET request with fixed delay + exponential backoff on 429s.
    Returns parsed JSON or raises on unrecoverable error.
    """
    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.get(url, params=params, timeout=20)
        except httpx.RequestError as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"[{label}] Network error after {MAX_RETRIES} attempts: {exc}") from exc
            wait = 2 ** attempt
            print(f"[{label}] Network error attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"[{label}] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 404:
            return {}  # No data — not a fatal error

        raise RuntimeError(f"[{label}] HTTP {resp.status_code}: {resp.text[:500]}")

    raise RuntimeError(f"[{label}] Still rate-limited after {MAX_RETRIES} retries")


# ── USDA FoodData Central ─────────────────────────────────────────────────────

def fetch_fdc(query: str, limit: int = 5) -> dict:
    """
    Search the USDA FoodData Central database for foods matching the query.
    Returns nutritional composition data — useful for health claims and labeling.

    FDC has several data types: Foundation, SR Legacy, Branded, Survey.
    We search across all types and return the most relevant results.
    """
    print(f"[fetch_usda] Searching FoodData Central for: {query!r}", file=sys.stderr)

    url    = f"{FDC_BASE_URL}/foods/search"
    params = {
        "query":    query,
        "pageSize": min(limit, 25),  # FDC max per page
        "api_key":  FDC_API_KEY,
    }

    data = get_with_retry(url, params, "USDA FDC")

    if not data:
        return {"source": "USDA FoodData Central", "total_found": 0, "foods": []}

    foods_raw = data.get("foods", [])
    total     = data.get("totalHits", 0)

    # Extract the most useful fields per food item
    foods = []
    for f in foods_raw:
        # Pull key nutrients from the nutrients list
        nutrients = {}
        for n in f.get("foodNutrients", []):
            name  = n.get("nutrientName", "")
            value = n.get("value")
            unit  = n.get("unitName", "")
            # Keep the big ones most relevant to food product research
            if any(kw in name.lower() for kw in
                   ["protein", "fat", "carbohydrate", "calcium", "energy",
                    "lactose", "sugar", "sodium", "vitamin"]):
                nutrients[name] = f"{value} {unit}" if value is not None else "unknown"

        foods.append({
            "fdc_id":       f.get("fdcId"),
            "description":  f.get("description"),
            "data_type":    f.get("dataType"),
            "brand_owner":  f.get("brandOwner"),
            "serving_size": f.get("servingSize"),
            "serving_unit": f.get("servingSizeUnit"),
            "nutrients":    nutrients,
        })

    return {
        "source":      "USDA FoodData Central",
        "total_found": total,
        "returned":    len(foods),
        "foods":       foods,
    }


# ── USDA NASS QuickStats ──────────────────────────────────────────────────────

def fetch_nass(commodity: str, state: str = None, year: int = None,
               stat_cat: str = "PRODUCTION") -> dict:
    """
    Query USDA NASS QuickStats for agricultural production/price statistics.
    Returns production volumes, prices, and farm counts for a given commodity.

    Useful for: supply chain research, production cost benchmarking,
    understanding the scale of domestic production of similar products.

    commodity — e.g. "MILK", "DAIRY", "CATTLE"
    state     — 2-letter state code or None for national data
    year      — 4-digit year or None for most recent
    stat_cat  — "PRODUCTION", "PRICE RECEIVED", "INVENTORY", etc.
    """
    if not NASS_API_KEY:
        print("[fetch_usda] USDA_NASS_API_KEY not set — NASS query skipped", file=sys.stderr)
        return {
            "source":  "USDA NASS QuickStats",
            "error":   "USDA_NASS_API_KEY not configured in .env",
            "records": [],
        }

    print(f"[fetch_usda] Querying NASS QuickStats for: {commodity!r}", file=sys.stderr)

    params = {
        "key":         NASS_API_KEY,
        "commodity_desc": commodity.upper(),
        "statisticcat_desc": stat_cat.upper(),
        "format":      "JSON",
    }

    if state:
        params["state_alpha"] = state.upper()
    if year:
        params["year"]        = str(year)

    url  = f"{NASS_BASE_URL}/api_GET/"
    data = get_with_retry(url, params, "USDA NASS")

    if not data:
        return {"source": "USDA NASS QuickStats", "total_found": 0, "records": []}

    records_raw = data.get("data", [])

    # Extract the most useful fields per record
    records = []
    for r in records_raw[:50]:  # Cap at 50 — NASS can return thousands of rows
        records.append({
            "commodity":   r.get("commodity_desc"),
            "year":        r.get("year"),
            "state":       r.get("state_name"),
            "category":    r.get("statisticcat_desc"),
            "data_item":   r.get("short_desc"),
            "value":       r.get("Value"),
            "unit":        r.get("unit_desc"),
        })

    return {
        "source":      "USDA NASS QuickStats",
        "total_found": len(records_raw),
        "returned":    len(records),
        "records":     records,
    }


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch USDA food and agricultural data")
    subparsers = parser.add_subparsers(dest="source", required=True)

    # FoodData Central subcommand
    fdc_parser = subparsers.add_parser("fdc", help="Search USDA FoodData Central")
    fdc_parser.add_argument("--query", required=True, help="Food search query")
    fdc_parser.add_argument("--limit", type=int, default=5, help="Max results (max 25)")

    # NASS QuickStats subcommand
    nass_parser = subparsers.add_parser("nass", help="Query USDA NASS QuickStats")
    nass_parser.add_argument("--commodity", required=True, help="Commodity name (e.g. MILK)")
    nass_parser.add_argument("--state",     default=None,  help="State code (e.g. CA)")
    nass_parser.add_argument("--year",      type=int, default=None, help="Year (e.g. 2023)")
    nass_parser.add_argument("--stat-cat",  default="PRODUCTION",
                             help="Statistic category (default: PRODUCTION)")

    args = parser.parse_args()

    if args.source == "fdc":
        result = fetch_fdc(query=args.query, limit=args.limit)
    else:
        result = fetch_nass(
            commodity = args.commodity,
            state     = args.state,
            year      = args.year,
            stat_cat  = args.stat_cat,
        )

    print(json.dumps(result, indent=2))
