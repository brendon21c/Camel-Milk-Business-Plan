"""
fetch_wto_data.py — WTO/USITC Tariff & Trade Data
Fetches US tariff schedules (HTS) and import tariff rates. No API key required.
For global bilateral tariff rates the WTO API requires registration; this tool
covers US HTS tariffs (USITC) and basic WTO tariff summaries via web search fallback.
Commands:
  hts      <hts_code>                — US Harmonized Tariff Schedule rates for a product
  imports  <hts_code> [--year YYYY]  — US import data by HTS code from Census/USITC
  tariff   <country> <hts_code>      — estimated tariff rate context for a trade corridor
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

# Note: httpx and time are still used by cmd_imports (Census trade data).

load_dotenv()

MAX_RETRIES = 3
CENSUS_BASE = "https://api.census.gov/data"


def cmd_hts(args):
    """Look up US Harmonized Tariff Schedule entry for an HTS code.

    The USITC /reststop REST API was decommissioned in 2025. The site now
    serves a JavaScript SPA with no public JSON API. This command returns a
    structured fallback that directs the agent to retrieve rates via web search.
    """
    return {
        "source": "USITC Harmonized Tariff Schedule (HTS)",
        "hts_code": args.hts_code,
        "status": "api_unavailable",
        "message": (
            "The USITC HTS REST API was decommissioned. "
            "Use web_search to retrieve the tariff rate: "
            f"'HTS {args.hts_code} US tariff rate MFN 2024' or "
            f"'site:hts.usitc.gov {args.hts_code}'. "
            "Alternatively use the tariff command for FTA corridor context."
        ),
        "records": [],
        "tip": (
            "HTS code reference: 0403.90 = specialty dairy/kefir, "
            "0401 = fresh milk, 9403 = furniture, 8471 = computers, "
            "6109 = T-shirts/apparel, 2710 = petroleum products."
        ),
    }


def cmd_imports(args):
    """Fetch US import statistics for an HTS code using Census international trade API."""
    code = args.hts_code.replace(".", "").replace(" ", "")
    year = args.year or 2022

    # Census International Trade — no API key (see fetch_itc_data.py note)
    url = f"{CENSUS_BASE}/{year}/intltrade/imports/hs"
    params = {
        "get":   "I_COMMODITY,I_COMMODITY_SDESC,GEN_VAL_MO,GEN_QY1_MO,GEN_QY1_UNIT",
        "I_COMMODITY": code,
        "YEAR":  str(year),
    }

    records = []
    errors = []
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            if resp.status_code == 200:
                raw = resp.json()
                if raw and len(raw) > 1:
                    headers = raw[0]
                    for row in raw[1:]:
                        record = dict(zip(headers, row))
                        records.append({
                            "hts_code":    record.get("I_COMMODITY"),
                            "description": record.get("I_COMMODITY_SDESC"),
                            "value_usd":   record.get("GEN_VAL_MO"),
                            "quantity":    record.get("GEN_QY1_MO"),
                            "unit":        record.get("GEN_QY1_UNIT"),
                            "year":        year,
                        })
                break
            else:
                errors.append(f"Census API status {resp.status_code}")
                break
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                errors.append(str(e))
            time.sleep(2 ** attempt)

    return {
        "source": "US Census Bureau International Trade Statistics — free, no key required",
        "hts_code": args.hts_code,
        "year": year,
        "records": records[:25],
        "total_returned": len(records),
        "partial_errors": errors,
        "data_notes": "GEN_VAL_MO = total import value USD. Monthly data aggregated by HTS code.",
    }


def cmd_tariff(args):
    """Provide tariff context for a country→US trade corridor."""
    country = args.country
    hts = args.hts_code

    # HTS rates apply to all imports; FTA status determines which rate column applies
    # Key FTAs with reduced/zero rates: USMCA (Canada/Mexico), KORUS (South Korea),
    # US-Australia, US-Singapore, US-Chile, CAFTA-DR, US-Bahrain, etc.
    # Africa: AGOA (duty-free for eligible Sub-Saharan African countries)
    # LDCs: GSP (Generalized System of Preferences — suspended 2020 but partially restored)

    fta_info = {
        "somalia": {
            "fta": "None",
            "notes": (
                "Somalia is not in a US FTA. Products face general MFN tariff rates. "
                "Somalia may qualify for AGOA (African Growth and Opportunity Act) duty-free access "
                "for eligible product categories — verify current AGOA product list at agoa.info."
            ),
            "agoa_eligible": True,
        },
        "kenya": {
            "fta": "None (US-Kenya FTA negotiations ongoing as of 2024)",
            "notes": "Kenya is AGOA-eligible. Many agricultural products enter duty-free under AGOA.",
            "agoa_eligible": True,
        },
        "germany": {"fta": "None (EU-US — no comprehensive FTA in force as of 2024)",
                    "notes": "EU goods face general MFN tariff rates.", "agoa_eligible": False},
        "canada":  {"fta": "USMCA", "notes": "Most goods enter duty-free under USMCA.", "agoa_eligible": False},
        "mexico":  {"fta": "USMCA", "notes": "Most goods enter duty-free under USMCA.", "agoa_eligible": False},
        "china":   {"fta": "None", "notes": "Subject to Section 301 tariffs on many categories (additional 7.5–25%+).", "agoa_eligible": False},
    }

    country_key = country.lower()
    fta = fta_info.get(country_key, {
        "fta": "Check USTR FTA page",
        "notes": f"Verify FTA status for {country} at ustr.gov/trade-agreements/free-trade-agreements",
        "agoa_eligible": None,
    })

    return {
        "source": "USITC HTS + USTR FTA reference data — free, no key required",
        "country": country,
        "hts_code": hts,
        "fta_status": fta.get("fta"),
        "tariff_context": fta.get("notes"),
        "agoa_eligible": fta.get("agoa_eligible"),
        "records": [{"country": country, "hts_code": hts, **fta}],
        "next_step": (
            f"Run 'hts {hts}' command to get the actual MFN rate, "
            "then apply FTA reduction if applicable."
        ),
        "data_notes": (
            "For authoritative tariff rates, combine: "
            "(1) HTS general rate from this tool, "
            "(2) FTA preference eligibility from USTR, "
            "(3) Any Section 201/232/301 additional tariffs from USTR tariff tracker."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch US tariff schedule and import data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_hts = subparsers.add_parser("hts", help="Look up US HTS tariff rate for a product code")
    p_hts.add_argument("hts_code", help="HTS code (e.g. '0403.90' for specialty dairy, '9403.30' for furniture)")
    p_hts.set_defaults(func=cmd_hts)

    p_imp = subparsers.add_parser("imports", help="US import volume/value statistics for an HTS code")
    p_imp.add_argument("hts_code", help="HTS code (digits only or with dots)")
    p_imp.add_argument("--year", type=int, help="Year (default: 2022)")
    p_imp.set_defaults(func=cmd_imports)

    p_tariff = subparsers.add_parser("tariff", help="Tariff context for a country→US trade corridor")
    p_tariff.add_argument("country", help="Origin country (e.g. 'Somalia', 'Germany', 'China')")
    p_tariff.add_argument("hts_code", help="HTS code for the product")
    p_tariff.set_defaults(func=cmd_tariff)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
