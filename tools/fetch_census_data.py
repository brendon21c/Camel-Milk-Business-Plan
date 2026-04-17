"""
tools/fetch_census_data.py

Fetches demographic and economic data from the US Census Bureau API.
Covers two primary datasets:

  1. American Community Survey 5-Year (ACS5) — population demographics,
     income, education, age distribution. Useful for: target market sizing,
     demographic validation, consumer profile research.

  2. County Business Patterns (CBP) — number of establishments, employees,
     and payroll by industry (NAICS code). Useful for: industry sizing,
     competitor density mapping, regional market analysis.

Both datasets are free. API key increases rate limit from 500 to unlimited
daily requests. Key is already in .env as CENSUS_API_KEY.

CLI usage:
  python tools/fetch_census_data.py --dataset acs5 --variables B01003_001E,B19013_001E --geography state:*
  python tools/fetch_census_data.py --dataset cbp --naics 311 --geography state:*
  python tools/fetch_census_data.py --dataset acs5 --profile --geography us:*

Common variables:
  ACS5: B01003_001E=total population, B19013_001E=median household income,
        B15003_022E=bachelor's degree holders, B02001_002E=white alone,
        S1901_C01_012E=income $100k+
  CBP:  ESTAB=establishments, EMP=employees, PAYANN=annual payroll

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

CENSUS_API_KEY = os.getenv("CENSUS_API_KEY")

CENSUS_BASE_URL = "https://api.census.gov/data"

# Common ACS5 variable presets for business intelligence use
ACS5_MARKET_PROFILE = [
    "NAME",
    "B01003_001E",   # Total population
    "B19013_001E",   # Median household income
    "B15003_022E",   # Bachelor's degree
    "B15003_023E",   # Master's degree
    "B08303_001E",   # Commute time (proxy for urban density)
    "B25077_001E",   # Median home value (proxy for wealth)
]

FIXED_DELAY_SEC = 0.25
MAX_RETRIES     = 3


# ── Census API call ───────────────────────────────────────────────────────────

def call_census(year: int, dataset: str, variables: list[str],
                geography: str) -> list[list]:
    """
    Execute a Census API call and return the tabular result.
    The Census API returns a 2D array: first row = headers, rest = data rows.

    year      — data year (e.g. 2022)
    dataset   — Census dataset path segment (e.g. "acs/acs5", "cbp")
    variables — list of variable codes to fetch
    geography — "for" parameter (e.g. "state:*", "us:1", "county:*&in=state:06")
    """
    url = f"{CENSUS_BASE_URL}/{year}/{dataset}"

    params = {
        "get": ",".join(variables),
        "for": geography,
    }

    if CENSUS_API_KEY:
        params["key"] = CENSUS_API_KEY

    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(FIXED_DELAY_SEC)

        try:
            resp = httpx.get(url, params=params, timeout=30)
        except httpx.RequestError as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"[census] Network error after {MAX_RETRIES} attempts: {exc}") from exc
            wait = 2 ** attempt
            print(f"[census] Network error attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            try:
                return resp.json()
            except json.JSONDecodeError:
                # Census API occasionally returns a 200 with malformed/empty body.
                # Treat it like a transient error and retry — same as a rate limit.
                if attempt == MAX_RETRIES:
                    raise RuntimeError(
                        f"[census] Malformed JSON after {MAX_RETRIES} attempts "
                        f"(status 200). Body preview: {resp.text[:200]}"
                    )
                wait = 2 ** attempt
                print(f"[census] Malformed JSON attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"[census] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        # Census API returns 400 for bad variable names — raise with context
        raise RuntimeError(f"[census] HTTP {resp.status_code}: {resp.text[:500]}")

    raise RuntimeError(f"[census] Still rate-limited after {MAX_RETRIES} retries")


# ── Result formatter ──────────────────────────────────────────────────────────

def table_to_records(raw: list[list]) -> list[dict]:
    """
    Convert Census API's 2D list format (headers + rows) into a list of dicts.
    Makes results easier for agents to parse and reason about.
    """
    if not raw or len(raw) < 2:
        return []

    headers = raw[0]
    rows    = raw[1:]

    return [dict(zip(headers, row)) for row in rows]


# ── High-level fetch functions ────────────────────────────────────────────────

def fetch_acs5_market_profile(geography: str = "us:1", year: int = 2022) -> dict:
    """
    Fetch a standard market profile from ACS5: population, income, education.
    Default geography is national (us:1). Use "state:*" for all states.

    These variables give a demographic picture of the target market:
    who they are, how much they earn, and how educated they are.
    """
    print(f"[census] Fetching ACS5 market profile for geography: {geography!r}", file=sys.stderr)

    raw     = call_census(year, "acs/acs5", ACS5_MARKET_PROFILE, geography)
    records = table_to_records(raw)

    # Add human-readable labels for the cryptic Census variable codes
    label_map = {
        "B01003_001E": "total_population",
        "B19013_001E": "median_household_income_usd",
        "B15003_022E": "bachelors_degree_holders",
        "B15003_023E": "masters_degree_holders",
        "B08303_001E": "commuters_any_mode",
        "B25077_001E": "median_home_value_usd",
    }

    # Rename variables to readable keys and cast numerics
    cleaned = []
    for r in records:
        row = {"name": r.get("NAME", "unknown")}
        for code, label in label_map.items():
            val = r.get(code)
            try:
                row[label] = int(val) if val not in (None, "-", "N", "") else None
            except (ValueError, TypeError):
                row[label] = val
        cleaned.append(row)

    return {
        "source":    "US Census Bureau — ACS 5-Year Estimates",
        "dataset":   f"acs/acs5 ({year})",
        "geography": geography,
        "variables": list(label_map.values()),
        "records":   cleaned,
    }


def fetch_cbp_industry(naics: str, geography: str = "us:1", year: int = 2021) -> dict:
    """
    Fetch County Business Patterns data for an industry (NAICS code).
    Returns establishment count, employee count, and annual payroll.

    naics     — NAICS code string (e.g. "311" for food manufacturing,
                "4451" for grocery stores, "31151" for dairy product mfg)
    geography — "us:1" for national, "state:*" for all states
    year      — CBP data year (most recent: 2021)

    Useful for sizing the industry, understanding regional concentration,
    and benchmarking payroll/employment for financial projections.
    """
    print(f"[census] Fetching CBP data for NAICS {naics!r}, geography: {geography!r}", file=sys.stderr)

    variables = ["NAME", "NAICS2017", "NAICS2017_LABEL", "ESTAB", "EMP", "PAYANN"]

    params_extra = f"&NAICS2017={naics}"  # CBP needs NAICS as a filter
    raw_url = (
        f"{CENSUS_BASE_URL}/{year}/cbp"
        f"?get={','.join(variables)}"
        f"&for={geography}"
        f"&NAICS2017={naics}"
    )
    # Build candidate URLs: first try with key (higher rate limit), then without.
    # Census returns an HTML "Invalid Key" page (status 200) if the key is wrong,
    # so we detect that and fall back to keyless access rather than hard-failing.
    candidate_urls = []
    if CENSUS_API_KEY:
        candidate_urls.append(raw_url + f"&key={CENSUS_API_KEY}")
    candidate_urls.append(raw_url)  # keyless fallback (500 req/day limit)

    raw = None
    last_error = None

    for url_attempt in candidate_urls:
        # Direct HTTP call (CBP uses NAICS as a filter param, not a GET variable)
        for attempt in range(1, MAX_RETRIES + 1):
            time.sleep(FIXED_DELAY_SEC)
            try:
                # follow_redirects=True required — Census API redirects some endpoints
                # (e.g. CBP 2021) to updated URLs; httpx defaults to no redirect following
                resp = httpx.get(url_attempt, timeout=30, follow_redirects=True)
            except httpx.RequestError as exc:
                if attempt == MAX_RETRIES:
                    last_error = f"[census CBP] Network error: {exc}"
                    break
                time.sleep(2 ** attempt)
                continue

            if resp.status_code == 200:
                try:
                    raw = resp.json()
                    break
                except json.JSONDecodeError:
                    # "Invalid Key" comes back as HTML with status 200 — detect it
                    if "Invalid Key" in resp.text or "<html" in resp.text[:100]:
                        print("[census CBP] API key invalid — retrying without key", file=sys.stderr)
                        last_error = "[census CBP] API key rejected"
                        break  # try next candidate URL
                    if attempt == MAX_RETRIES:
                        last_error = (
                            f"[census CBP] Malformed JSON after {MAX_RETRIES} attempts "
                            f"(status 200). Body preview: {resp.text[:200]}"
                        )
                        break
                    wait = 2 ** attempt
                    print(f"[census CBP] Malformed JSON attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
                    time.sleep(wait)
                    continue
            elif resp.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            else:
                last_error = f"[census CBP] HTTP {resp.status_code}: {resp.text[:500]}"
                break

        if raw is not None:
            break  # got a valid response — no need to try fallback URL

    if raw is None:
        raise RuntimeError(last_error or "[census CBP] All attempts failed")

    records = table_to_records(raw)

    # Cast numeric fields
    for r in records:
        for field in ("ESTAB", "EMP", "PAYANN"):
            val = r.get(field)
            try:
                r[field] = int(val) if val not in (None, "", "N", "D") else None
            except (ValueError, TypeError):
                pass

    return {
        "source":    "US Census Bureau — County Business Patterns",
        "dataset":   f"cbp ({year})",
        "naics":     naics,
        "geography": geography,
        "records":   records,
    }


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch US Census Bureau data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # ACS5 market profile
    acs_parser = subparsers.add_parser("acs5", help="ACS5 demographic market profile")
    acs_parser.add_argument("--geography", default="us:1",
                            help="Census geography (e.g. 'us:1', 'state:*')")
    acs_parser.add_argument("--year",      type=int, default=2022,
                            help="ACS5 data year (default: 2022)")

    # County Business Patterns
    cbp_parser = subparsers.add_parser("cbp", help="County Business Patterns by NAICS")
    cbp_parser.add_argument("--naics",    required=True,
                            help="NAICS industry code (e.g. 311 for food manufacturing)")
    cbp_parser.add_argument("--geography", default="us:1",
                            help="Census geography (e.g. 'us:1', 'state:*')")
    cbp_parser.add_argument("--year",      type=int, default=2021,
                            help="CBP data year (default: 2021)")

    args = parser.parse_args()

    try:
        if args.command == "acs5":
            result = fetch_acs5_market_profile(geography=args.geography, year=args.year)
        else:
            result = fetch_cbp_industry(naics=args.naics, geography=args.geography, year=args.year)
    except Exception as exc:
        # Always write valid JSON to stdout — even on failure — so execPython
        # (in run.js) gets a parseable result and the agent receives a clean
        # error object it can reason about rather than a raw Python traceback.
        result = {
            "error":   str(exc),
            "source":  "US Census Bureau",
            "dataset": getattr(args, "command", "unknown"),
            "records": [],
        }
        print(f"[census] Fatal error: {exc}", file=sys.stderr)

    print(json.dumps(result, indent=2))
