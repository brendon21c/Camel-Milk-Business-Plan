"""
fetch_oecd_data.py — OECD Stats API (SDMX-JSON)
Fetches OECD member-country economic and trade statistics. No API key required.
Commands:
  indicators  <country_iso3>  — key business/economic indicators for an OECD country
  trade       <country_iso3>  [--partner PARTNER]  — trade flows with optional partner filter
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

# OECD SDMX-JSON API endpoint
BASE_URL = "https://sdmx.oecd.org/public/rest"
MAX_RETRIES = 3

# OECD country codes (3-letter ISO in OECD convention)
OECD_MEMBERS = {
    "USA", "GBR", "DEU", "FRA", "JPN", "AUS", "CAN", "KOR", "MEX", "TUR",
    "ITA", "ESP", "NLD", "CHE", "SWE", "NOR", "DNK", "FIN", "AUT", "BEL",
    "POL", "CZE", "HUN", "GRC", "PRT", "IRL", "NZL", "ISL", "LUX", "SVK",
    "SVN", "EST", "LVA", "LTU", "CHL", "COL", "CRI", "ISR", "IND",
}


def oecd_get(dataset, key, params=None):
    """Fetch data from OECD SDMX-JSON API."""
    url = f"{BASE_URL}/data/{dataset}/{key}"
    default_params = {
        "dimensionAtObservation": "AllDimensions",
        "format":                 "jsondata",
        "detail":                 "dataonly",
    }
    if params:
        default_params.update(params)

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=default_params, timeout=25)
            if resp.status_code == 404:
                return None  # No data for this key — not an error
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_oecd_data] Failed {dataset}/{key}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def extract_sdmx_series(data):
    """Parse OECD SDMX-JSON response into flat records.

    OECD SDMX-JSON nests data inside dataSets[0].series; keys are composite
    dimension indices separated by ':'. This function flattens that structure.
    """
    if not data:
        return []

    try:
        structure = data.get("data", {}).get("structures", [{}])[0]
        dimensions = structure.get("dimensions", {}).get("observation", [])

        datasets = data.get("data", {}).get("dataSets", [])
        if not datasets:
            return []

        observations = datasets[0].get("observations", {})
        records = []
        for key, obs_list in observations.items():
            # Key is a colon-separated index string; map to dimension values
            parts = key.split(":")
            dim_values = {}
            for i, part in enumerate(parts):
                if i < len(dimensions):
                    dim = dimensions[i]
                    values = dim.get("values", [])
                    idx = int(part)
                    if idx < len(values):
                        dim_values[dim.get("id", f"dim_{i}")] = values[idx].get("name", part)

            # obs_list[0] is the value
            value = obs_list[0] if obs_list else None
            if value is not None:
                record = {"value": value}
                record.update(dim_values)
                records.append(record)

        return records
    except Exception as e:
        print(f"[fetch_oecd_data] SDMX parse error: {e}", file=sys.stderr)
        return []


def cmd_indicators(args):
    """Fetch key OECD economic indicators for a country."""
    country = args.country.upper()
    if country not in OECD_MEMBERS:
        return {
            "error": f"{country} is not an OECD member. This tool covers OECD member economies only.",
            "oecd_members": sorted(OECD_MEMBERS),
            "records": [],
        }

    results = {}
    errors = []

    # 1. GDP and National Accounts (SNA_TABLE1) — key economic size indicators
    data = oecd_get("OECD.SDD.NAD,DSD_NAMAIN1@DF_TABLE1_EXPENDITURE_HCPC,1.0",
                    f"A.{country}....XDC..")
    if data:
        records = extract_sdmx_series(data)
        results["national_accounts"] = records[:10]
    else:
        errors.append("national_accounts: no data")

    time.sleep(0.4)

    # 2. Trade in Goods (TIVA, trade as % of GDP from main indicators)
    # Use OECD Main Economic Indicators for trade openness
    data2 = oecd_get("OECD.SDD.STES,DSD_NAMAIN1@DF_TABLE1_EXPENDITURE,1.0",
                     f"A.{country}.B1GQ.XDC..")
    if data2:
        results["gdp_series"] = extract_sdmx_series(data2)[:5]
    else:
        errors.append("gdp_series: no data (not critical)")

    time.sleep(0.4)

    # Note: OECD SDMX dataset paths change often; surface what we got
    record_summary = [
        {"country": country, "dataset": k, "record_count": len(v)}
        for k, v in results.items()
    ]

    return {
        "source": "OECD Stats API (SDMX-JSON) — free, no key required",
        "country_code": country,
        "note": (
            "OECD covers 38 member economies. Use fetch_world_bank for non-OECD countries. "
            "Raw SDMX data — interpret with country/indicator context."
        ),
        "data_by_dataset": results,
        "records": record_summary,
        "partial_errors": errors,
        "data_notes": "OECD data typically lags 1 year. Values in national currency unless stated.",
    }


def cmd_trade(args):
    """Fetch OECD TIVA (Trade in Value Added) or bilateral trade stats."""
    country = args.country.upper()
    partner = args.partner.upper() if args.partner else None

    # OECD TIVA dataset
    key = f"A.{country}...."
    if partner:
        key = f"A.{country}.{partner}..."

    data = oecd_get("OECD.TAD.ATI,DSD_TRADE@DF_TRADE,1.0", key)
    records = extract_sdmx_series(data) if data else []

    return {
        "source": "OECD Trade Statistics (SDMX-JSON) — free, no key required",
        "reporter_country": country,
        "partner_country": partner,
        "records": records[:25],
        "total_returned": len(records),
        "data_notes": "OECD trade data covers member economies. Values typically in USD millions.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch OECD economic and trade data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_ind = subparsers.add_parser("indicators", help="Key economic indicators for an OECD country")
    p_ind.add_argument("country", help="ISO-3 country code (OECD members only — e.g. USA, DEU, GBR, JPN)")
    p_ind.set_defaults(func=cmd_indicators)

    p_trade = subparsers.add_parser("trade", help="OECD bilateral trade flows")
    p_trade.add_argument("country", help="Reporter country ISO-3 code")
    p_trade.add_argument("--partner", help="Partner country ISO-3 code (optional filter)")
    p_trade.set_defaults(func=cmd_trade)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
