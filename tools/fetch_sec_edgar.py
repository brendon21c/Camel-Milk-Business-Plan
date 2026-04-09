"""
tools/fetch_sec_edgar.py

Fetches public company financial data from the SEC EDGAR API.
No API key required — completely free and open. Rate limit: 10 req/sec.

Covers:
  1. Full-text search (EFTS) — search SEC filings by keyword across all
     companies and filing types. Useful for finding public competitors,
     industry filings, and regulatory risk disclosures.

  2. Company facts — fetch standardised financial facts (revenue, assets,
     net income, etc.) from a specific company's XBRL filings. Useful for
     competitor financial benchmarking.

  3. Company lookup — search for a company by name to find its CIK number
     (needed for company facts).

Relevant for:
  - Competitor analysis (find public competitors and their financials)
  - Market size validation (industry revenue from 10-K filings)
  - Risk research (find regulatory risk disclosures in 10-K filings)
  - Financial benchmarking (margins, capex, R&D spend)

CLI usage:
  python tools/fetch_sec_edgar.py search --query "camel milk" --form 10-K --limit 10
  python tools/fetch_sec_edgar.py company --name "Desert Farms"
  python tools/fetch_sec_edgar.py facts --cik 0001234567 --concept Revenues

Returns JSON to stdout for agent consumption.
"""

import argparse
import json
import os
import sys
import time

import httpx

# ── Config ────────────────────────────────────────────────────────────────────

# SEC EDGAR requires a User-Agent header identifying the requester
# Per SEC Fair Access rules: format is "Name Email"
SEC_USER_AGENT = "Camel-Milk-Business-Plan brendon@example.com"

EDGAR_EFTS_URL    = "https://efts.sec.gov/LATEST/search-index"  # Full-text search
EDGAR_SEARCH_URL  = "https://efts.sec.gov/LATEST/search-index"
EDGAR_DATA_URL    = "https://data.sec.gov"                       # Company facts
EDGAR_COMPANY_URL = "https://www.sec.gov/cgi-bin/browse-edgar"   # Company lookup

FIXED_DELAY_SEC = 0.15   # 150ms between calls (SEC limit is 10/sec)
MAX_RETRIES     = 3


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def get_sec(url: str, params: dict = None, label: str = "SEC EDGAR") -> dict | list:
    """
    GET request to SEC EDGAR with User-Agent header and retry logic.
    SEC requires a User-Agent — requests without it are blocked.
    """
    headers = {
        "User-Agent":      SEC_USER_AGENT,
        "Accept-Encoding": "gzip, deflate",
        "Host":            url.split("/")[2],  # Required by SEC fair access policy
    }

    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.get(url, params=params, headers=headers, timeout=20)
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
            return {}

        raise RuntimeError(f"[{label}] HTTP {resp.status_code}: {resp.text[:500]}")

    raise RuntimeError(f"[{label}] Still rate-limited after {MAX_RETRIES} retries")


# ── Full-text filing search ────────────────────────────────────────────────────

def search_filings(query: str, form_type: str = None, limit: int = 10,
                   date_from: str = None, date_to: str = None) -> dict:
    """
    Full-text search across SEC EDGAR filings using EFTS (EDGAR Full-Text Search).
    Returns matching filing excerpts with company name, form type, and filing date.

    query     — search term (e.g. "camel milk", "specialty dairy import")
    form_type — optional filter (e.g. "10-K", "10-Q", "S-1", "8-K")
    limit     — max results (max 100 per page)
    date_from — optional start date "YYYY-MM-DD"
    date_to   — optional end date "YYYY-MM-DD"

    Useful for finding: public competitors, industry risk disclosures, market
    size mentions in official filings, regulatory risk language.
    """
    print(f"[sec_edgar] Searching filings for: {query!r} (form: {form_type or 'all'})", file=sys.stderr)

    # EDGAR full-text search endpoint
    url    = "https://efts.sec.gov/LATEST/search-index"
    params = {
        "q":    f'"{query}"',  # Wrap in quotes for exact phrase match
        "hits.hits.total.value": "true",
        "hits.hits._source": "period_of_report,entity_name,file_date,form_type,biz_location",
        "dateRange": "custom" if (date_from or date_to) else None,
        "_source": "period_of_report,entity_name,file_date,form_type",
        "hits.hits._source.includes": "entity_name,file_date,form_type,period_of_report",
    }

    # Use the public EDGAR full-text search API (simpler endpoint)
    search_url = "https://efts.sec.gov/LATEST/search-index"

    # Simpler approach: use the EDGAR search API
    edgar_search = "https://efts.sec.gov/LATEST/search-index"
    efts_url     = f"https://efts.sec.gov/LATEST/search-index?q=%22{query.replace(' ', '+')}%22"

    # Use the correct EDGAR full-text search endpoint
    search_params = {
        "q":        f'"{query}"',
        "dateRange": "custom" if date_from else None,
        "startdt":  date_from,
        "enddt":    date_to,
        "forms":    form_type,
        "_source":  "entity_name,file_date,form_type,period_of_report",
    }
    # Remove None values
    search_params = {k: v for k, v in search_params.items() if v is not None}

    data = get_sec(
        "https://efts.sec.gov/LATEST/search-index",
        search_params,
        "SEC EDGAR EFTS",
    )

    hits = data.get("hits", {})
    all_hits   = hits.get("hits", [])
    total      = hits.get("total", {}).get("value", 0)

    # Limit results manually since EDGAR EFTS doesn't support limit param cleanly
    all_hits = all_hits[:limit]

    filings = []
    for h in all_hits:
        src = h.get("_source", {})
        filings.append({
            "entity_name":       src.get("entity_name"),
            "form_type":         src.get("form_type"),
            "file_date":         src.get("file_date"),
            "period_of_report":  src.get("period_of_report"),
            "filing_url":        f"https://www.sec.gov/Archives/edgar/data/{src.get('entity_id', '')}/{h.get('_id', '')}",
        })

    return {
        "source":      "SEC EDGAR Full-Text Search",
        "query":       query,
        "form_type":   form_type or "all",
        "total_found": total,
        "returned":    len(filings),
        "filings":     filings,
    }


# ── Company lookup by name ────────────────────────────────────────────────────

def lookup_company(name: str) -> dict:
    """
    Search for a company by name to find its SEC CIK number.
    The CIK is needed to fetch detailed financial facts (company_facts).

    Returns a list of matching companies with their CIK numbers.
    """
    print(f"[sec_edgar] Looking up company: {name!r}", file=sys.stderr)

    url    = "https://efts.sec.gov/LATEST/search-index"
    params = {
        "q":        f'"{name}"',
        "entity":   name,
    }

    # Use the company search endpoint
    company_url = "https://www.sec.gov/cgi-bin/browse-edgar"
    params = {
        "company":    name,
        "CIK":        "",
        "type":       "10-K",
        "dateb":      "",
        "owner":      "include",
        "count":      "10",
        "search_text": "",
        "action":     "getcompany",
        "output":     "atom",  # Returns XML — we parse it
    }

    # EDGAR company search returns Atom XML — use the JSON company search instead
    # SEC provides a company tickers JSON that's easier to work with
    tickers_url = "https://www.sec.gov/files/company_tickers.json"

    data = get_sec(tickers_url, label="SEC EDGAR Company Tickers")

    if not data:
        return {"source": "SEC EDGAR", "query": name, "companies": []}

    # The tickers file is a dict of {index: {cik_str, ticker, title}}
    # Search by company name (title)
    name_lower = name.lower()
    matches = []
    for idx, co in data.items():
        title = co.get("title", "")
        if name_lower in title.lower():
            matches.append({
                "cik":    str(co.get("cik_str", "")).zfill(10),  # CIK padded to 10 digits
                "ticker": co.get("ticker"),
                "name":   title,
            })

    return {
        "source":    "SEC EDGAR Company Tickers",
        "query":     name,
        "matches":   matches[:10],  # Top 10 matches
    }


# ── Company financial facts ───────────────────────────────────────────────────

def fetch_company_facts(cik: str, concept: str = "Revenues",
                        taxonomy: str = "us-gaap") -> dict:
    """
    Fetch standardised financial facts for a specific public company.
    CIK must be a 10-digit zero-padded string (e.g. "0001234567").

    concept  — XBRL concept name (e.g. "Revenues", "NetIncomeLoss",
                "Assets", "GrossProfit", "CostOfGoodsSold")
    taxonomy — "us-gaap" (standard) or "dei" (entity-level info)

    Returns annual and quarterly values for the requested financial metric.
    Useful for: competitor revenue benchmarking, margin analysis,
    understanding the financial scale of public competitors.
    """
    # Normalise CIK to 10 digits
    cik_padded = str(cik).lstrip("0").zfill(10)

    print(f"[sec_edgar] Fetching {taxonomy}/{concept} for CIK {cik_padded}", file=sys.stderr)

    url  = f"{EDGAR_DATA_URL}/api/xbrl/companyfacts/CIK{cik_padded}.json"
    data = get_sec(url, label="SEC EDGAR Company Facts")

    if not data:
        return {
            "source":  "SEC EDGAR Company Facts",
            "cik":     cik_padded,
            "concept": concept,
            "error":   "No data found — CIK may be incorrect or company is private",
        }

    entity_name = data.get("entityName", "unknown")
    facts       = data.get("facts", {}).get(taxonomy, {}).get(concept, {})

    if not facts:
        available = list(data.get("facts", {}).get(taxonomy, {}).keys())[:20]
        return {
            "source":      "SEC EDGAR Company Facts",
            "entity_name": entity_name,
            "cik":         cik_padded,
            "concept":     concept,
            "error":       f"Concept not found. Available: {available}",
        }

    units_data = facts.get("units", {})
    label      = facts.get("label", concept)
    description = facts.get("description", "")

    # Extract annual values (10-K filings) — most useful for trend analysis
    annual_values = []
    for unit_key, values in units_data.items():
        for v in values:
            # 10-K annual reports have form="10-K"
            if v.get("form") == "10-K":
                annual_values.append({
                    "year":  v.get("end", "")[:4],  # Just the year portion
                    "end":   v.get("end"),
                    "value": v.get("val"),
                    "unit":  unit_key,
                    "form":  v.get("form"),
                })

    # Sort by year descending (most recent first)
    annual_values.sort(key=lambda x: x["year"], reverse=True)

    return {
        "source":         "SEC EDGAR Company Facts (XBRL)",
        "entity_name":    entity_name,
        "cik":            cik_padded,
        "concept":        concept,
        "label":          label,
        "description":    description,
        "annual_values":  annual_values[:10],  # Last 10 years
    }


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch SEC EDGAR public company filing data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Full-text filing search
    search_parser = subparsers.add_parser("search", help="Full-text search across SEC filings")
    search_parser.add_argument("--query",     required=True, help="Search query")
    search_parser.add_argument("--form",      default=None,  help="Form type filter (e.g. 10-K)")
    search_parser.add_argument("--limit",     type=int, default=10, help="Max results")
    search_parser.add_argument("--from-date", default=None,  help="Start date YYYY-MM-DD")
    search_parser.add_argument("--to-date",   default=None,  help="End date YYYY-MM-DD")

    # Company lookup
    lookup_parser = subparsers.add_parser("company", help="Look up a company by name to find CIK")
    lookup_parser.add_argument("--name", required=True, help="Company name to search")

    # Company financial facts
    facts_parser = subparsers.add_parser("facts", help="Fetch company financial facts by CIK")
    facts_parser.add_argument("--cik",      required=True, help="SEC CIK number (10-digit)")
    facts_parser.add_argument("--concept",  default="Revenues",
                              help="XBRL concept (e.g. Revenues, NetIncomeLoss, Assets)")
    facts_parser.add_argument("--taxonomy", default="us-gaap",
                              choices=["us-gaap", "dei"],
                              help="XBRL taxonomy (default: us-gaap)")

    args = parser.parse_args()

    if args.command == "search":
        result = search_filings(
            query     = args.query,
            form_type = args.form,
            limit     = args.limit,
            date_from = args.from_date,
            date_to   = args.to_date,
        )
    elif args.command == "company":
        result = lookup_company(name=args.name)
    else:
        result = fetch_company_facts(
            cik      = args.cik,
            concept  = args.concept,
            taxonomy = args.taxonomy,
        )

    print(json.dumps(result, indent=2))
