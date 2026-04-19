"""
fetch_un_comtrade.py — UN Comtrade API v1
Bilateral trade flows between countries, by HS commodity code.
Requires UN_COMTRADE_API_KEY in .env (free tier: 500 req/hr).

Commands:
  bilateral  <reporter> <partner> <hs_code>  — export/import flows between two countries
  top_partners <reporter> <hs_code>          — top trading partners for a country/product

IMPORTANT: HS codes aggregate all sub-types within a category — species, material, grade,
and origin are not distinguished at the 6-digit level. A reported trade volume covers
everything that classifies under that code, not just the specific product in the proposition.
Always cross-reference with web_search or search_exa to confirm what actually comprises
the reported flow before drawing conclusions about the proposition's specific product.
"""

import argparse
import json
import os
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("UN_COMTRADE_API_KEY", "")
BASE_URL = "https://comtradeapi.un.org/data/v1/get/C/A/HS"
MAX_RETRIES = 3

# M49 numeric codes for countries most likely to appear in propositions.
# Comtrade uses these internally. ISO3 input is converted at call time.
COUNTRY_CODES = {
    "USA": 842, "GBR": 826, "DEU": 276, "FRA": 251, "CAN": 124,
    "AUS":  36, "CHN": 156, "IND": 356, "JPN": 392, "KOR": 410,
    "ARE": 784, "SAU": 682, "QAT": 634, "KWT": 414, "OMN": 512,
    "SOM": 706, "KEN": 404, "ETH": 231, "TZA": 834, "UGA": 800,
    "ZAF": 710, "NGA": 566, "GHA": 288, "EGY": 818, "MAR": 504,
    "NLD": 528, "BEL": 56,  "ITA": 380, "ESP": 724, "CHE": 756,
    "SWE": 752, "NOR": 578, "DNK": 208, "FIN": 246, "POL": 616,
    "MEX": 484, "BRA": 76,  "ARG":  32, "CHL": 152, "COL": 170,
    "SGP": 702, "MYS": 458, "THA": 764, "VNM": 704, "IDN": 360,
    "PAK": 586, "BGD": 50,  "LKA": 144, "NZL": 554, "ISR": 376,
    "TUR": 792, "UKR": 804, "RUS": 643,
    # World aggregate — use as partnerCode to get all-partners total
    "WLD": 0,
}

FLOW_LABELS = {"X": "Exports", "M": "Imports", "RX": "Re-exports", "RM": "Re-imports"}


def _iso3_to_m49(iso3):
    """Convert ISO-3 country code to M49 numeric. Returns None if unknown."""
    code = COUNTRY_CODES.get(iso3.upper())
    if code is None:
        print(f"[comtrade] Unknown country code: {iso3}. Use ISO-3 (e.g. USA, SOM, ARE).", file=sys.stderr)
    return code


def _request(params):
    """Single API call with retry and rate-limit handling."""
    if not API_KEY:
        return {"error": "UN_COMTRADE_API_KEY not set in .env", "records": []}

    headers = {"Ocp-Apim-Subscription-Key": API_KEY}

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(BASE_URL, params=params, headers=headers, timeout=30)

            if resp.status_code == 429:
                # Rate limited — back off and retry
                wait = 5 * (attempt + 1)
                print(f"[comtrade] Rate limited. Waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue

            resp.raise_for_status()
            data = resp.json()

            # Comtrade returns {"data": [...], "validation": {...}}
            records = data.get("data", [])
            return {"ok": True, "records": records, "validation": data.get("validation", {})}

        except httpx.HTTPStatusError as e:
            if attempt == MAX_RETRIES - 1:
                return {"error": f"HTTP {e.response.status_code}: {e.response.text[:300]}", "records": []}
            time.sleep(2 ** attempt)
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                return {"error": str(e), "records": []}
            time.sleep(2 ** attempt)

    return {"error": "Max retries exceeded", "records": []}


def _format_record(r):
    """Extract the fields most useful to research agents from a raw Comtrade row."""
    return {
        "reporter":      r.get("reporterDesc"),
        "partner":       r.get("partnerDesc"),
        "flow":          FLOW_LABELS.get(r.get("flowCode", ""), r.get("flowCode")),
        "hs_code":       r.get("cmdCode"),
        "hs_desc":       r.get("cmdDesc"),
        "year":          r.get("period"),
        "trade_value_usd": r.get("primaryValue"),
        "net_weight_kg": r.get("netWgt"),
        "qty":           r.get("qty"),
        "qty_unit":      r.get("qtyUnitAbbr"),
    }


def cmd_bilateral(args):
    """
    Bilateral trade flows between reporter and partner for a specific HS code.
    Returns both export (X) and import (M) rows so the agent can see both sides.
    """
    reporter_m49 = _iso3_to_m49(args.reporter)
    partner_m49  = _iso3_to_m49(args.partner)

    if reporter_m49 is None or partner_m49 is None:
        return {"error": "Invalid country code(s). Use ISO-3 (e.g. USA, SOM, ARE).", "records": []}

    year = str(args.year) if args.year else "2023"

    params = {
        "reporterCode": reporter_m49,
        "partnerCode":  partner_m49,
        "period":       year,
        "cmdCode":      args.hs_code,
        "flowCode":     "X,M",   # both exports and imports in one call
        "maxRecords":   50,
        "format":       "JSON",
        "includeDesc":  "true",
    }

    result = _request(params)
    if "error" in result:
        return result

    records = [_format_record(r) for r in result["records"]]

    # Surface a plain-language summary for the agent
    total_export = sum(r["trade_value_usd"] or 0 for r in records if r["flow"] == "Exports")
    total_import = sum(r["trade_value_usd"] or 0 for r in records if r["flow"] == "Imports")

    return {
        "source": "UN Comtrade — official bilateral trade statistics",
        "reporter": args.reporter.upper(),
        "partner":  args.partner.upper(),
        "hs_code":  args.hs_code,
        "year":     year,
        "summary": {
            "exports_usd": total_export,
            "imports_usd": total_import,
            "note": "reporter → partner flows. Zero may mean no trade recorded, not zero trade.",
        },
        "data_warning": (
            "HS codes aggregate all sub-types within a category — species, material, grade, and origin "
            "are not separated at the 6-digit level. These figures cover the full commodity class, not "
            "the proposition's specific product. Cross-reference with web search to verify what actually "
            "comprises this trade flow before drawing conclusions."
        ),
        "records": records,
    }


def cmd_top_partners(args):
    """
    Top trading partners for a country/product combination.
    Uses World (0) as partner to get all-partner totals, then
    re-queries per-partner breakdown limited to top N.
    """
    reporter_m49 = _iso3_to_m49(args.reporter)
    if reporter_m49 is None:
        return {"error": "Invalid country code. Use ISO-3 (e.g. USA, SOM, ARE).", "records": []}

    year  = str(args.year) if args.year else "2023"
    flow  = args.flow.upper() if args.flow else "X"
    count = min(args.count, 20) if args.count else 10

    params = {
        "reporterCode": reporter_m49,
        # Omitting partnerCode returns all partners — what we want for ranking
        "period":       year,
        "cmdCode":      args.hs_code,
        "flowCode":     flow,
        "maxRecords":   500,
        "format":       "JSON",
        "includeDesc":  "true",
    }

    result = _request(params)
    if "error" in result:
        return result

    records = [_format_record(r) for r in result["records"]]

    # Sort by trade value descending, filter out the World aggregate row
    ranked = sorted(
        [r for r in records if r["partner"] and r["partner"].lower() != "world"],
        key=lambda x: x["trade_value_usd"] or 0,
        reverse=True,
    )[:count]

    total_value = sum(r["trade_value_usd"] or 0 for r in ranked)

    return {
        "source": "UN Comtrade — official bilateral trade statistics",
        "reporter":      args.reporter.upper(),
        "hs_code":       args.hs_code,
        "flow":          FLOW_LABELS.get(flow, flow),
        "year":          year,
        "top_partners":  ranked,
        "total_trade_value_usd": total_value,
        "data_warning": (
            "HS codes aggregate all sub-types within a category — species, material, grade, and origin "
            "are not separated at the 6-digit level. These figures cover the full commodity class, not "
            "the proposition's specific product. Cross-reference with web search to verify what actually "
            "comprises this trade flow before drawing conclusions."
        ),
        "records":       ranked,
    }


def main():
    parser = argparse.ArgumentParser(description="UN Comtrade bilateral trade data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # bilateral command
    bil = subparsers.add_parser("bilateral", help="Trade flows between two countries for an HS code")
    bil.add_argument("reporter", help="Reporting country ISO-3 (e.g. SOM, USA, ARE)")
    bil.add_argument("partner",  help="Partner country ISO-3 (e.g. USA, DEU, CHN)")
    bil.add_argument("hs_code",  help="HS commodity code (e.g. 040210 = milk powder)")
    bil.add_argument("--year",   type=int, help="Trade year (default: 2023)")
    bil.set_defaults(func=cmd_bilateral)

    # top_partners command
    tp = subparsers.add_parser("top_partners", help="Top trading partners for a country/product")
    tp.add_argument("reporter", help="Reporting country ISO-3")
    tp.add_argument("hs_code",  help="HS commodity code")
    tp.add_argument("--flow",   choices=["X", "M"], default="X",
                    help="X = exports (default), M = imports")
    tp.add_argument("--year",   type=int, help="Trade year (default: 2023)")
    tp.add_argument("--count",  type=int, default=10, help="Number of partners to return (max 20)")
    tp.set_defaults(func=cmd_top_partners)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
