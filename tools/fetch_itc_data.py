"""
tools/fetch_itc_data.py

Fetches trade remedy and import data from two public APIs — no key required.

  1. Federal Register API (federalregister.gov)
     - Searches for trade remedy case notices published by USITC and the
       Department of Commerce: anti-dumping (AD), countervailing duty (CVD),
       Section 201/232/301 safeguard and tariff actions.
     - Use for: identifying whether competitors' imported products face trade
       remedies, assessing tariff risk, and understanding the trade policy
       environment for a given product category.
     API base: https://www.federalregister.gov/api/v1/

  2. US Census Bureau International Trade API
     - Import statistics by NAICS code: total import value and quantity by
       country of origin, covering recent reporting periods.
     - Use for: sizing import competition, identifying dominant source countries,
       and understanding import trends for domestic manufacturing analysis.
     API base: https://api.census.gov/data/timeseries/intltrade/imports

CLI usage:
  python tools/fetch_itc_data.py cases --term "furniture anti-dumping"
  python tools/fetch_itc_data.py cases --term "wood products" --limit 15
  python tools/fetch_itc_data.py imports --naics 337 --year 2022
  python tools/fetch_itc_data.py imports --naics 337 --country 5700   # China = 5700

Returns JSON to stdout for agent consumption.
"""

import argparse
import json
import os
import sys
import time

import httpx
from dotenv import load_dotenv

# ── Config ─────────────────────────────────────────────────────────────────────

load_dotenv()

CENSUS_API_KEY     = os.getenv("CENSUS_API_KEY")   # optional — increases rate limit
FEDREGISTER_BASE   = "https://www.federalregister.gov/api/v1/"
CENSUS_TRADE_BASE  = "https://api.census.gov/data/timeseries/intltrade/imports/naics"

MAX_RETRIES = 3
FIXED_DELAY = 0.5

# Federal Register agency slugs for trade remedy coverage
TRADE_REMEDY_AGENCIES = [
    "international-trade-commission",   # USITC — injury determinations
    "commerce-department",              # DOC — AD/CVD duty calculations
]


# ── HTTP helper ────────────────────────────────────────────────────────────────

def get_json(url: str, params: dict = None) -> dict:
    """
    GET request with retry logic for network errors and 429 rate limits.
    Returns parsed JSON. Raises RuntimeError on unrecoverable failure.
    """
    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY)

        try:
            resp = httpx.get(url, params=params, timeout=30, follow_redirects=True)
        except httpx.RequestError as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"Network error after {MAX_RETRIES} attempts: {exc}") from exc
            time.sleep(2 ** attempt)
            continue

        if resp.status_code == 200:
            try:
                return resp.json()
            except json.JSONDecodeError:
                raise RuntimeError(f"Non-JSON 200 response: {resp.text[:300]}")

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"[itc] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")

    raise RuntimeError(f"Still failing after {MAX_RETRIES} retries")


# ── Federal Register trade remedy cases ───────────────────────────────────────

def fetch_cases(term: str, limit: int = 15) -> dict:
    """
    Search Federal Register for trade remedy case notices.
    Covers USITC and Department of Commerce publications — the two agencies
    that govern anti-dumping, countervailing duty, and safeguard proceedings.

    Returns document titles, publication dates, document types, and abstracts.
    Ordered newest-first so agents see the most recent actions at the top.

    term  — search term (e.g. "furniture anti-dumping", "softwood lumber 301")
    limit — max documents to return (default 15)
    """
    print(f"[itc] Searching Federal Register for trade remedy cases: {term!r}...", file=sys.stderr)

    params = {
        "conditions[term]":          term,
        "per_page":                  str(limit),
        "order":                     "newest",
        # Request only the fields we need — keeps response compact
        "fields[]": [
            "title",
            "document_number",
            "publication_date",
            "type",
            "abstract",
            "html_url",
            "agencies",
            "docket_ids",
        ],
    }

    # Filter to trade-relevant agencies — reduces noise significantly
    for i, slug in enumerate(TRADE_REMEDY_AGENCIES):
        params[f"conditions[agencies][]"] = slug  # last write wins for simple params

    # Federal Register API supports multi-value params via repeated keys;
    # build manually to pass both agency conditions
    url     = FEDREGISTER_BASE + "documents.json"
    payload = {
        "conditions[term]": term,
        "per_page":         str(limit),
        "order":            "newest",
    }
    payload["fields[]"] = ["title", "document_number", "publication_date",
                            "type", "abstract", "html_url"]

    # Append agency conditions directly in the URL query string since httpx
    # doesn't natively support repeated param keys with the same name
    agency_qs = "&".join(
        f"conditions%5Bagencies%5D%5B%5D={slug}" for slug in TRADE_REMEDY_AGENCIES
    )
    full_url  = url + "?" + "&".join(
        f"{k}={v}" if not isinstance(v, list) else "&".join(f"{k}={i}" for i in v)
        for k, v in payload.items()
    ) + "&" + agency_qs

    data = get_json(full_url)

    raw_results = data.get("results", [])

    # Normalize to compact shape
    cases = []
    for doc in raw_results:
        cases.append({
            "title":            doc.get("title"),
            "type":             doc.get("type"),
            "publication_date": doc.get("publication_date"),
            "document_number":  doc.get("document_number"),
            "abstract":         (doc.get("abstract") or "")[:500],  # cap abstract length
            "url":              doc.get("html_url"),
        })

    return {
        "source":       "Federal Register — USITC and Commerce Department notices",
        "search_term":  term,
        "total_returned": len(cases),
        "note":         "Covers anti-dumping (AD), countervailing duty (CVD), "
                        "and safeguard (Section 201/232/301) proceedings. "
                        "Most recent actions appear first.",
        "cases":        cases,
    }


# ── Census international trade imports ────────────────────────────────────────

def fetch_imports(naics: str, year: int = 2022, country_code: str = None) -> dict:
    """
    Fetch US import statistics by NAICS code from Census Bureau international trade data.
    Aggregates 12 monthly snapshots into annual totals by country of origin.

    naics        — NAICS code string (e.g. "337" for furniture mfg, "3371" for household furn)
    year         — data year (default 2022; Census trade data has ~1 year lag)
    country_code — optional Census country code to filter (e.g. "5700" = China,
                   "5030" = Canada). Omit for all countries.

    Returns annual CIF import value (USD) per country, sorted by value descending.
    This data shows the scale and origin of import competition facing a domestic
    manufacturer — critical context for production cost and competitiveness analysis.
    """
    print(f"[itc] Fetching Census import data for NAICS {naics!r}, year {year}...", file=sys.stderr)

    # Census trade API provides monthly data — fetch all 12 months then aggregate
    params = {
        "get":  "CTY_CODE,CTY_NAME,GEN_CIF_YR",
        "NAICS": naics,
        "time": f"from {year}-01 to {year}-12",
    }
    if country_code:
        params["CTY_CODE"] = country_code
    # Note: CENSUS_API_KEY is NOT passed — Census trade endpoint uses its own auth
    # and the general Census key causes an "Invalid Key" rejection

    try:
        raw = get_json(CENSUS_TRADE_BASE, params=params)
    except Exception as exc:
        return {
            "error":  str(exc),
            "source": "US Census Bureau — International Trade",
            "naics":  naics,
            "note":   "Census trade data may be unavailable for this NAICS/year. "
                      "Try web_search for import statistics.",
            "records": [],
        }

    # Census returns a 2D list: first row is headers, rest are data rows
    if not raw or len(raw) < 2:
        return {
            "source":  "US Census Bureau — USA Trade Online",
            "naics":   naics,
            "year":    year,
            "records": [],
            "note":    "No data returned for this NAICS/year combination.",
        }

    headers = raw[0]
    rows    = raw[1:]
    records = [dict(zip(headers, row)) for row in rows]

    # Aggregate monthly CIF values by country to get annual totals
    totals = {}   # country_code → {"country": name, "import_value_usd": int}
    for r in records:
        code = r.get("CTY_CODE", "")
        name = r.get("CTY_NAME", "")
        cif  = r.get("GEN_CIF_YR")

        try:
            cif_val = int(cif) if cif and cif not in ("", "N", "D", "-") else 0
        except (ValueError, TypeError):
            cif_val = 0

        if code not in totals:
            totals[code] = {"country_code": code, "country": name, "import_value_usd": 0}
        totals[code]["import_value_usd"] += cif_val

    # Sort by annual import value descending so top source countries appear first
    cleaned = sorted(totals.values(), key=lambda x: x["import_value_usd"], reverse=True)

    return {
        "source":   "US Census Bureau — USA Trade Online (Annual Imports, aggregated from monthly)",
        "naics":    naics,
        "year":     year,
        "note":     "import_value_usd = CIF (cost, insurance, freight) value in USD, summed across 12 months. "
                    "Sorted by annual import value descending.",
        "records":  cleaned[:50],  # cap at 50 countries
    }


# ── CLI entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser     = argparse.ArgumentParser(description="Fetch ITC trade remedy and import data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Trade remedy cases subcommand
    cp = subparsers.add_parser("cases", help="Federal Register trade remedy case search")
    cp.add_argument("--term",  required=True, help="Search term (e.g. 'furniture anti-dumping')")
    cp.add_argument("--limit", type=int, default=15, help="Max results (default 15)")

    # Import statistics subcommand
    ip = subparsers.add_parser("imports", help="Census Bureau import statistics by NAICS")
    ip.add_argument("--naics",   required=True, help="NAICS code (e.g. 337 for furniture)")
    ip.add_argument("--year",    type=int, default=2022, help="Data year (default 2022)")
    ip.add_argument("--country", default=None,
                    help="Census country code filter (e.g. 5700 = China, 5030 = Canada)")

    args = parser.parse_args()

    try:
        if args.command == "cases":
            result = fetch_cases(term=args.term, limit=args.limit)
        else:
            result = fetch_imports(naics=args.naics, year=args.year, country_code=args.country)

    except Exception as exc:
        result = {
            "error":   str(exc),
            "source":  "ITC / Federal Register / Census Trade",
            "command": getattr(args, "command", "unknown"),
            "records": [],
        }
        print(f"[itc] Fatal error: {exc}", file=sys.stderr)

    print(json.dumps(result, indent=2))
