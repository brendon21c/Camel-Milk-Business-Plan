"""
tools/fetch_epa_data.py

Fetches EPA regulatory and enforcement data from two public APIs — no key required.

  1. EPA ECHO (Enforcement and Compliance History Online)
     - Facility search by NAICS code and state: compliance scores, violation counts,
       enforcement actions, inspection history.
     - Use for: understanding regulatory burden on an industry, identifying compliance
       risks, and sizing the enforcement landscape competitors face.
     API base: https://echodata.epa.gov/echo/

  2. EPA Toxic Release Inventory (TRI) via EPA Envirofacts REST API
     - Annual toxic chemical release data reported by manufacturing facilities.
     - Use for: identifying regulated emissions in a manufacturing process,
       understanding chemical compliance obligations, and assessing environmental risk.
     API base: https://data.epa.gov/efservice/

CLI usage:
  python tools/fetch_epa_data.py facilities --naics 337 --state MN
  python tools/fetch_epa_data.py facilities --naics 337                   # national
  python tools/fetch_epa_data.py tri --naics 337 --state MN
  python tools/fetch_epa_data.py tri --chemical "formaldehyde"

Returns JSON to stdout for agent consumption.
"""

import argparse
import json
import sys
import time

import httpx

# ── Config ─────────────────────────────────────────────────────────────────────

ECHO_BASE = "https://echodata.epa.gov/echo/"
TRI_BASE  = "https://data.epa.gov/efservice/"

MAX_RETRIES = 3
FIXED_DELAY = 0.5


# ── HTTP helper ────────────────────────────────────────────────────────────────

def get_json(url: str, params: dict = None) -> dict:
    """
    Perform a GET request and return parsed JSON.
    Retries on network errors and 429 rate limits with exponential backoff.
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
                raise RuntimeError(f"Non-JSON response (200): {resp.text[:300]}")

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"[epa] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue

        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")

    raise RuntimeError(f"Still failing after {MAX_RETRIES} retries")


# ── ECHO facility search ───────────────────────────────────────────────────────

def fetch_facilities(naics: str, state: str = None, limit: int = 20) -> dict:
    """
    Search EPA ECHO for regulated manufacturing facilities by NAICS code.
    Optionally filter by state (2-letter abbreviation).

    Returns a list of facilities with their compliance summary — inspection count,
    violation quarters, enforcement actions, and overall compliance status.
    This paints a picture of the regulatory environment for the industry sector.

    naics — NAICS code prefix (e.g. "337" for furniture, "321" for wood products)
    state — optional 2-letter state abbreviation (e.g. "MN", "CA")
    limit — max facilities to return (default 20)
    """
    print(f"[epa] Searching ECHO facilities for NAICS {naics!r}, state {state or 'all'}...", file=sys.stderr)

    params = {
        "output":    "JSON",
        "p_ncs":     naics,       # NAICS code filter
        "p_per_page": str(limit),
    }
    if state:
        params["p_st"] = state.upper()

    url  = ECHO_BASE + "echo_rest_services.get_facility_info"
    data = get_json(url, params=params)

    # ECHO wraps results in Results.facilities list
    raw_facilities = (
        data.get("Results", {}).get("facilities", [])
        or data.get("Results", {}).get("Facilities", [])
        or []
    )

    # Normalize to a consistent shape using actual ECHO API field names
    facilities = []
    for f in raw_facilities:
        facilities.append({
            "name":                f.get("FacName"),
            "city":                f.get("FacCity"),
            "state":               f.get("FacState"),
            "naics":               f.get("FacNAICSCodes"),
            "compliance_status":   f.get("FacComplianceStatus"),
            "inspection_count":    f.get("FacInspectionCount"),
            "violation_quarters":  f.get("FacQtrsWithNC"),         # quarters with non-compliance
            "enforcement_actions": f.get("CAAFormalActionCount"),  # Clean Air Act formal actions
            "penalty_count":       f.get("FacPenaltyCount"),
            "tri_releases_lbs":    f.get("TRIOnSiteReleases"),     # on-site TRI releases (lbs)
        })

    return {
        "source":     "EPA ECHO — Enforcement and Compliance History Online",
        "naics":      naics,
        "state":      state or "all",
        "total_returned": len(facilities),
        "note":       "violation_quarters = quarters with significant non-compliance. "
                      "enforcement_actions = formal enforcement actions taken.",
        "facilities": facilities,
    }


# ── Toxic Release Inventory ────────────────────────────────────────────────────

def fetch_tri(naics: str = None, state: str = None, chemical: str = None,
              year: int = 2022, limit: int = 20) -> dict:
    """
    Fetch Toxic Release Inventory (TRI) data from EPA Envirofacts REST API.
    TRI data is self-reported by manufacturing facilities that release or transfer
    regulated toxic chemicals above threshold quantities.

    This identifies what chemicals a manufacturing sector typically releases and
    what emissions compliance looks like for the industry — critical for regulatory
    risk assessment in manufacturing propositions.

    naics    — NAICS code filter (e.g. "337") — optional
    state    — 2-letter state abbreviation — optional
    chemical — chemical name to search (e.g. "formaldehyde") — optional
    year     — reporting year (default: 2022, most recent complete TRI data)
    limit    — max records to return
    """
    print(f"[epa] Fetching TRI data — NAICS {naics or 'all'}, state {state or 'all'}, "
          f"chemical {chemical or 'all'}, year {year}...", file=sys.stderr)

    # EPA Envirofacts REST API uses path-based filters:
    # /efservice/{TABLE}/{COLUMN}/{VALUE}/{COLUMN2}/{VALUE2}/JSON/rows/{start}:{end}
    # TRI_ONSITE_RELEASES_TRANSFERS is the main TRI table
    path_parts = ["TRI_ONSITE_RELEASES_TRANSFERS"]

    if year:
        path_parts += [f"REPORTING_YEAR/{year}"]
    if state:
        path_parts += [f"ST/{state.upper()}"]

    # Build URL; JSON output and row limit appended at end
    url = TRI_BASE + "/".join(path_parts) + f"/JSON/rows/0:{limit - 1}"

    try:
        data = get_json(url)
    except Exception as exc:
        # TRI API has irregular availability; return partial result rather than crashing
        return {
            "error":   str(exc),
            "source":  "EPA Toxic Release Inventory (TRI) via Envirofacts",
            "note":    "TRI API may be temporarily unavailable. Try again or use web_search for TRI data.",
            "records": [],
        }

    # Filter by chemical name client-side if specified (API doesn't support it path-based)
    records = data if isinstance(data, list) else []
    if chemical and records:
        chem_lower = chemical.lower()
        records = [r for r in records if chem_lower in str(r.get("CHEMICAL", "")).lower()]

    # Filter by NAICS prefix client-side
    if naics and records:
        records = [r for r in records if str(r.get("PRIMARY_NAICS", "")).startswith(naics)]

    # Normalize to a compact shape
    cleaned = []
    for r in records[:limit]:
        cleaned.append({
            "facility_name": r.get("FACILITY_NAME"),
            "city":          r.get("CITY"),
            "state":         r.get("ST"),
            "naics":         r.get("PRIMARY_NAICS"),
            "chemical":      r.get("CHEMICAL"),
            "total_releases_lbs": r.get("TOTAL_RELEASES"),
            "year":          r.get("REPORTING_YEAR"),
        })

    return {
        "source":         "EPA Toxic Release Inventory (TRI) via Envirofacts",
        "reporting_year": year,
        "naics_filter":   naics,
        "state_filter":   state,
        "chemical_filter": chemical,
        "total_returned": len(cleaned),
        "note":           "TRI data is self-reported by facilities above release thresholds. "
                          "total_releases_lbs = total on-site and off-site releases in pounds.",
        "records":        cleaned,
    }


# ── CLI entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser     = argparse.ArgumentParser(description="Fetch EPA regulatory and enforcement data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Facilities subcommand
    fp = subparsers.add_parser("facilities", help="ECHO facility compliance search by NAICS")
    fp.add_argument("--naics",  required=True, help="NAICS code (e.g. 337 for furniture)")
    fp.add_argument("--state",  default=None,  help="2-letter state abbreviation (optional)")
    fp.add_argument("--limit",  type=int, default=20, help="Max results (default 20)")

    # TRI subcommand
    tp = subparsers.add_parser("tri", help="Toxic Release Inventory data by industry")
    tp.add_argument("--naics",    default=None, help="NAICS code filter (optional)")
    tp.add_argument("--state",    default=None, help="2-letter state abbreviation (optional)")
    tp.add_argument("--chemical", default=None, help="Chemical name to filter (optional)")
    tp.add_argument("--year",     type=int, default=2022, help="Reporting year (default 2022)")
    tp.add_argument("--limit",    type=int, default=20, help="Max results (default 20)")

    args = parser.parse_args()

    try:
        if args.command == "facilities":
            result = fetch_facilities(naics=args.naics, state=args.state, limit=args.limit)
        else:
            result = fetch_tri(
                naics=args.naics,
                state=args.state,
                chemical=args.chemical,
                year=args.year,
                limit=args.limit,
            )

    except Exception as exc:
        result = {
            "error":   str(exc),
            "source":  "EPA",
            "command": getattr(args, "command", "unknown"),
            "records": [],
        }
        print(f"[epa] Fatal error: {exc}", file=sys.stderr)

    print(json.dumps(result, indent=2))
