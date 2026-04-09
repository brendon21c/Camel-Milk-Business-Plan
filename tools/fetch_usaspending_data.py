"""
tools/fetch_usaspending_data.py

Fetches US federal spending data from USASpending.gov API v2.
No API key required — completely free and open.

Covers:
  - Award search: find federal contracts and grants in a given industry/keyword
  - Agency spending: top agencies spending in a category
  - Spending trends: year-over-year spending totals

Relevant for:
  - Market size validation (how much does the government buy in this category?)
  - Identifying potential B2G (business-to-government) channels
  - Understanding subsidy flows in the industry (grants to food producers, etc.)
  - Competitor intelligence (who has federal contracts in this space?)

CLI usage:
  python tools/fetch_usaspending_data.py --search "camel milk" --award-type contracts --limit 10
  python tools/fetch_usaspending_data.py --search "dairy products" --award-type grants --limit 20
  python tools/fetch_usaspending_data.py --naics 311511 --fiscal-year 2023

Returns JSON to stdout for agent consumption.
"""

import argparse
import json
import os
import sys
import time

import httpx

# ── Config ────────────────────────────────────────────────────────────────────

USASPENDING_BASE_URL = "https://api.usaspending.gov/api/v2"

FIXED_DELAY_SEC = 0.25
MAX_RETRIES     = 3

# USASpending uses POST with JSON bodies for award searches
AWARD_SEARCH_URL = f"{USASPENDING_BASE_URL}/search/spending_by_award/"
SPENDING_EXPLORER = f"{USASPENDING_BASE_URL}/spending_explorer/"


# ── HTTP helper ───────────────────────────────────────────────────────────────

def post_with_retry(url: str, body: dict, label: str = "USASpending") -> dict:
    """
    POST JSON body to USASpending API with retry logic.
    USASpending uses POST for most search endpoints (not GET with params).
    """
    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.post(url, json=body, timeout=30)
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
            print(f"[{label}] 429 rate limit, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        raise RuntimeError(f"[{label}] HTTP {resp.status_code}: {resp.text[:500]}")

    raise RuntimeError(f"[{label}] Still rate-limited after {MAX_RETRIES} retries")


# ── Award search ──────────────────────────────────────────────────────────────

def search_awards(keyword: str, award_type: str = "contracts",
                  limit: int = 10, fiscal_year: int = None) -> dict:
    """
    Search USASpending for federal awards (contracts or grants) matching a keyword.

    keyword     — search term (e.g. "camel milk", "dairy products")
    award_type  — "contracts" or "grants" (or "all" for both)
    limit       — max results (USASpending max is 100 per page)
    fiscal_year — optional filter (e.g. 2023). Defaults to all available years.

    Returns award records with obligated amounts, recipients, and agencies.
    """
    print(f"[usaspending] Searching {award_type} for: {keyword!r}", file=sys.stderr)

    # Map award_type to USASpending type codes
    type_map = {
        "contracts": ["A", "B", "C", "D"],           # Contract types
        "grants":    ["02", "03", "04", "05"],        # Grant types
        "all":       ["A", "B", "C", "D", "02", "03", "04", "05"],
    }

    award_types = type_map.get(award_type, type_map["contracts"])

    # Build the filter object
    filters = {
        "keywords":    [keyword],
        "award_type_codes": award_types,
    }

    # Add fiscal year filter if specified
    if fiscal_year:
        filters["time_period"] = [
            {
                "start_date": f"{fiscal_year - 1}-10-01",  # Federal FY starts Oct 1
                "end_date":   f"{fiscal_year}-09-30",
            }
        ]

    body = {
        "filters": filters,
        "fields": [
            "Award ID",
            "Recipient Name",
            "Award Amount",
            "Total Outlays",
            "Description",
            "Start Date",
            "End Date",
            "Awarding Agency",
            "Awarding Sub Agency",
            "Award Type",
            "Place of Performance State Code",
            "NAICS Code",
            "NAICS Description",
        ],
        "limit":  min(limit, 100),
        "page":   1,
        "sort":   "Award Amount",
        "order":  "desc",  # Largest awards first — most relevant for market intelligence
    }

    data = post_with_retry(AWARD_SEARCH_URL, body)

    results  = data.get("results", [])
    metadata = data.get("page_metadata", {})

    # Summarise each award record for agent use
    awards = []
    for r in results:
        awards.append({
            "award_id":         r.get("Award ID"),
            "recipient":        r.get("Recipient Name"),
            "amount_usd":       r.get("Award Amount"),
            "total_outlays":    r.get("Total Outlays"),
            "description":      r.get("Description"),
            "start_date":       r.get("Start Date"),
            "end_date":         r.get("End Date"),
            "awarding_agency":  r.get("Awarding Agency"),
            "sub_agency":       r.get("Awarding Sub Agency"),
            "award_type":       r.get("Award Type"),
            "state":            r.get("Place of Performance State Code"),
            "naics_code":       r.get("NAICS Code"),
            "naics_description": r.get("NAICS Description"),
        })

    return {
        "source":        "USASpending.gov",
        "keyword":       keyword,
        "award_type":    award_type,
        "total_found":   metadata.get("count", 0),
        "returned":      len(awards),
        "total_obligated_usd": sum(
            a["amount_usd"] for a in awards if isinstance(a["amount_usd"], (int, float))
        ),
        "awards": awards,
    }


# ── NAICS spending breakdown ──────────────────────────────────────────────────

def fetch_naics_spending(naics_code: str, fiscal_year: int = 2023) -> dict:
    """
    Fetch total federal spending for a NAICS industry code in a given fiscal year.
    Useful for understanding the scale of government procurement in the industry.

    naics_code  — 6-digit NAICS code (e.g. "311511" for fluid milk)
    fiscal_year — the fiscal year to query (default: 2023)
    """
    print(f"[usaspending] Fetching NAICS {naics_code!r} spending for FY{fiscal_year}", file=sys.stderr)

    filters = {
        "naics_codes": [naics_code],
        "time_period": [
            {
                "start_date": f"{fiscal_year - 1}-10-01",
                "end_date":   f"{fiscal_year}-09-30",
            }
        ],
        "award_type_codes": ["A", "B", "C", "D"],  # Contracts only for NAICS
    }

    body = {
        "filters": filters,
        "fields": [
            "Award ID",
            "Recipient Name",
            "Award Amount",
            "Description",
            "Awarding Agency",
            "NAICS Code",
            "NAICS Description",
        ],
        "limit":  25,
        "sort":   "Award Amount",
        "order":  "desc",
    }

    data = post_with_retry(AWARD_SEARCH_URL, body)

    results  = data.get("results", [])
    metadata = data.get("page_metadata", {})

    # Build a total spending summary + top recipients
    total_obligated = sum(
        r.get("Award Amount", 0) or 0 for r in results
    )

    recipients = [
        {
            "recipient":   r.get("Recipient Name"),
            "amount_usd":  r.get("Award Amount"),
            "agency":      r.get("Awarding Agency"),
            "description": r.get("Description"),
        }
        for r in results
    ]

    return {
        "source":              "USASpending.gov",
        "naics_code":          naics_code,
        "fiscal_year":         fiscal_year,
        "total_contract_count": metadata.get("count", 0),
        "sample_size":         len(recipients),
        "sample_obligated_usd": total_obligated,
        "top_recipients":      recipients,
    }


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch US federal spending data from USASpending.gov")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Keyword award search
    search_parser = subparsers.add_parser("search", help="Search awards by keyword")
    search_parser.add_argument("--keyword",     required=True, help="Search keyword")
    search_parser.add_argument("--award-type",  default="contracts",
                               choices=["contracts", "grants", "all"],
                               help="Type of awards to search")
    search_parser.add_argument("--limit",       type=int, default=10, help="Max results")
    search_parser.add_argument("--fiscal-year", type=int, default=None,
                               help="Fiscal year filter (e.g. 2023)")

    # NAICS spending breakdown
    naics_parser = subparsers.add_parser("naics", help="Spending by NAICS code")
    naics_parser.add_argument("--code",        required=True, help="6-digit NAICS code")
    naics_parser.add_argument("--fiscal-year", type=int, default=2023, help="Fiscal year")

    args = parser.parse_args()

    if args.command == "search":
        result = search_awards(
            keyword     = args.keyword,
            award_type  = args.award_type,
            limit       = args.limit,
            fiscal_year = args.fiscal_year,
        )
    else:
        result = fetch_naics_spending(
            naics_code  = args.code,
            fiscal_year = args.fiscal_year,
        )

    print(json.dumps(result, indent=2))
