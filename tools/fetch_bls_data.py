"""
tools/fetch_bls_data.py

Fetches employment and wage data from the Bureau of Labor Statistics (BLS) Public Data API.
Uses v2 when BLS_V2_API_Key is present in .env (50 series/request, 20 years of history,
annual averages support). Falls back to v1 if the key is missing (25 series, 10 years).

Datasets covered:
  1. wages      — Average hourly/weekly earnings benchmarks across manufacturing sectors.
                  Drawn from CES (Current Employment Statistics). Use for production cost
                  modeling and labor competitiveness analysis.
  2. employment — Employment level trends for manufacturing sectors.
                  Use for workforce availability signals and industry health assessment.
  3. series     — Fetch any BLS time series by ID for advanced/specific lookups.

CLI usage:
  python tools/fetch_bls_data.py wages
  python tools/fetch_bls_data.py wages --start 2021 --end 2024
  python tools/fetch_bls_data.py employment --sector durable
  python tools/fetch_bls_data.py series --ids CES3000000008,CES3200000001 --start 2022 --end 2024

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

BLS_API_KEY = os.getenv("BLS_V2_API_Key")   # optional — enables v2 endpoint

# v2 gives 50 series/request, 20 years of history, and annual average support.
# v1 is the unauthenticated fallback (25 series, 10 years).
BLS_API_URL = (
    "https://api.bls.gov/publicAPI/v2/timeseries/data/"
    if BLS_API_KEY
    else "https://api.bls.gov/publicAPI/v1/timeseries/data/"
)

MAX_RETRIES = 3
FIXED_DELAY = 0.5   # courtesy delay between requests — BLS docs recommend this

# ── Predefined series ──────────────────────────────────────────────────────────
#
# CES (Current Employment Statistics) — seasonally adjusted national estimates.
# Series ID format: CES{supersector_code}{data_type_code}
#   Supersector 30 = all manufacturing
#   Supersector 32 = durable goods manufacturing (furniture falls here, NAICS 337)
#   Supersector 31 = nondurable goods manufacturing
#   Data type 01 = employees on nonfarm payrolls (thousands)
#   Data type 08 = average hourly earnings of all employees ($)
#   Data type 30 = average weekly earnings of all employees ($)
#   Data type 32 = average hourly earnings, production/nonsupervisory workers ($)

WAGE_SERIES = {
    "all_mfg_avg_hourly_earnings":         "CES3000000008",
    "all_mfg_avg_weekly_earnings":         "CES3000000030",
    "durable_mfg_avg_hourly_earnings":     "CES3200000008",
    "nondurable_mfg_avg_hourly_earnings":  "CES3100000008",
    "prod_workers_avg_hourly_earnings":    "CES3000000032",  # production/nonsup workers
}

# Employment levels by manufacturing sector
EMPLOYMENT_SERIES = {
    "all":        "CES3000000001",  # all manufacturing employees (thousands)
    "durable":    "CES3200000001",  # durable goods mfg (includes furniture, wood products)
    "nondurable": "CES3100000001",  # nondurable goods mfg
}


# ── BLS API call ───────────────────────────────────────────────────────────────

def fetch_series(series_ids: list, start_year: int, end_year: int) -> dict:
    """
    POST to BLS API v1 to retrieve time series data.
    Returns the raw API response dict. Raises on network or status error.

    series_ids — list of BLS series ID strings (max 25 for v1)
    start_year — first year of the requested data range
    end_year   — last year of the requested data range
    """
    payload = {
        "seriesid":  series_ids,
        "startyear": str(start_year),
        "endyear":   str(end_year),
    }
    # v2 requires the key in the POST body; v1 ignores it if present
    if BLS_API_KEY:
        payload["registrationkey"] = BLS_API_KEY

    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY)

        try:
            resp = httpx.post(BLS_API_URL, json=payload, timeout=30)
        except httpx.RequestError as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"[bls] Network error after {MAX_RETRIES} attempts: {exc}") from exc
            time.sleep(2 ** attempt)
            continue

        if resp.status_code == 200:
            data = resp.json()

            # BLS returns HTTP 200 even for rate-limit and auth errors — check status field
            if data.get("status") == "REQUEST_SUCCEEDED":
                return data

            messages = data.get("message", [])
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"[bls] API returned non-success status. Messages: {messages}")
            print(f"[bls] Non-success response attempt {attempt}: {messages}", file=sys.stderr)
            time.sleep(2 ** attempt)
            continue

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"[bls] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        raise RuntimeError(f"[bls] HTTP {resp.status_code}: {resp.text[:300]}")

    raise RuntimeError(f"[bls] Still failing after {MAX_RETRIES} retries")


def extract_latest(api_response: dict, id_to_label: dict = None) -> list:
    """
    Pull the most recent data point from each series in a BLS response.
    BLS returns data newest-first, so index 0 is always the latest.

    id_to_label — optional dict mapping series IDs to human-readable names.
    """
    results = []
    for series in api_response.get("Results", {}).get("series", []):
        sid    = series.get("seriesID", "")
        points = series.get("data", [])

        if not points:
            results.append({"series_id": sid, "value": None, "note": "no data returned"})
            continue

        latest = points[0]
        row = {
            "series_id": sid,
            "year":      latest.get("year"),
            "period":    latest.get("periodName"),
            "value":     latest.get("value"),
        }
        if id_to_label and sid in id_to_label:
            row["label"] = id_to_label[sid]

        # Include footnotes if present (BLS uses these for preliminary data flags)
        footnotes = [f.get("text", "") for f in latest.get("footnotes", []) if f.get("text")]
        if footnotes:
            row["footnotes"] = footnotes

        results.append(row)

    return results


# ── High-level fetch functions ─────────────────────────────────────────────────

def fetch_wages(start_year: int = 2021, end_year: int = 2024) -> dict:
    """
    Fetch standard manufacturing wage benchmarks from BLS CES.
    Returns average hourly and weekly earnings for all manufacturing,
    durable goods, and nondurable goods subsectors.

    These benchmarks anchor labor cost estimates in financial projections
    and let agents compare a company's wage assumptions against market norms.
    """
    print("[bls] Fetching manufacturing wage benchmarks...", file=sys.stderr)

    ids     = list(WAGE_SERIES.values())
    raw     = fetch_series(ids, start_year, end_year)
    id_map  = {v: k for k, v in WAGE_SERIES.items()}
    latest  = extract_latest(raw, id_to_label=id_map)

    return {
        "source":     "Bureau of Labor Statistics — Current Employment Statistics (CES)",
        "dataset":    "Manufacturing wage benchmarks",
        "note":       "Values are seasonally adjusted national estimates. Earnings in USD.",
        "benchmarks": latest,
    }


def fetch_employment(sector: str = "all", start_year: int = 2021, end_year: int = 2024) -> dict:
    """
    Fetch manufacturing employment trends from BLS CES for a given sector.
    sector — "all", "durable", or "nondurable"

    Employment levels (in thousands, seasonally adjusted) show industry scale
    and direction. Durable goods includes furniture (NAICS 337) and wood products.
    """
    if sector not in EMPLOYMENT_SERIES:
        raise ValueError(f"[bls] sector must be one of: {list(EMPLOYMENT_SERIES.keys())}")

    print(f"[bls] Fetching employment trends for sector: {sector!r}...", file=sys.stderr)

    sid = EMPLOYMENT_SERIES[sector]
    raw = fetch_series([sid], start_year, end_year)

    # Return a multi-point trend (not just the latest) so agents can reason about direction
    trend = []
    for series in raw.get("Results", {}).get("series", []):
        for point in series.get("data", []):
            trend.append({
                "year":   point.get("year"),
                "period": point.get("periodName"),
                "value":  point.get("value"),  # employees in thousands
            })

    return {
        "source":    "Bureau of Labor Statistics — Current Employment Statistics (CES)",
        "dataset":   f"Manufacturing employment — {sector} goods",
        "series_id": sid,
        "unit":      "thousands of employees, seasonally adjusted",
        "note":      "Durable goods manufacturing (CES32) includes furniture (NAICS 337) and wood products (NAICS 321).",
        "trend":     trend[:24],  # cap at ~2 years of monthly data to keep response compact
    }


def fetch_custom_series(series_ids: list, start_year: int, end_year: int) -> dict:
    """
    Fetch arbitrary BLS time series by explicit series IDs.
    Use when the agent knows the exact BLS codes relevant to the proposition.
    Returns all data points in the requested range.
    """
    print(f"[bls] Fetching custom series: {series_ids}...", file=sys.stderr)

    raw    = fetch_series(series_ids, start_year, end_year)
    output = []

    for series in raw.get("Results", {}).get("series", []):
        output.append({
            "series_id": series.get("seriesID"),
            "data":      series.get("data", []),
        })

    return {
        "source":   "Bureau of Labor Statistics",
        "series":   output,
        "messages": raw.get("message", []),
    }


# ── CLI entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser     = argparse.ArgumentParser(description="Fetch BLS employment and wage data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Wages subcommand
    wp = subparsers.add_parser("wages", help="Manufacturing wage benchmarks (CES)")
    wp.add_argument("--start", type=int, default=2021, help="Start year (default: 2021)")
    wp.add_argument("--end",   type=int, default=2024, help="End year (default: 2024)")

    # Employment subcommand
    ep = subparsers.add_parser("employment", help="Manufacturing employment trends (CES)")
    ep.add_argument("--sector", default="all", choices=["all", "durable", "nondurable"],
                    help="Manufacturing sector (default: all)")
    ep.add_argument("--start", type=int, default=2021, help="Start year (default: 2021)")
    ep.add_argument("--end",   type=int, default=2024, help="End year (default: 2024)")

    # Custom series subcommand
    sp = subparsers.add_parser("series", help="Fetch specific BLS series by ID")
    sp.add_argument("--ids",   required=True,
                    help="Comma-separated BLS series IDs (e.g. CES3000000008,CES3200000001)")
    sp.add_argument("--start", type=int, default=2021, help="Start year (default: 2021)")
    sp.add_argument("--end",   type=int, default=2024, help="End year (default: 2024)")

    args = parser.parse_args()

    try:
        if args.command == "wages":
            result = fetch_wages(start_year=args.start, end_year=args.end)
        elif args.command == "employment":
            result = fetch_employment(sector=args.sector, start_year=args.start, end_year=args.end)
        else:
            ids    = [s.strip() for s in args.ids.split(",") if s.strip()]
            result = fetch_custom_series(ids, args.start, args.end)

    except Exception as exc:
        # Always emit valid JSON — agent needs a parseable result even on failure
        result = {
            "error":   str(exc),
            "source":  "Bureau of Labor Statistics",
            "command": getattr(args, "command", "unknown"),
            "records": [],
        }
        print(f"[bls] Fatal error: {exc}", file=sys.stderr)

    print(json.dumps(result, indent=2))
