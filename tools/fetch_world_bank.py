"""
fetch_world_bank.py — World Bank Open Data API
Fetches key development indicators for any country. No API key required.
Commands:
  indicators  <country_iso2> [--year YYYY]  — fetch ~10 key indicators for a country
  compare     <country_iso2> <country_iso2> [--indicator CODE] — compare two countries
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://api.worldbank.org/v2"
MAX_RETRIES = 3

# Core indicators covering economic size, living standards, trade openness, and business environment.
# These are the most useful for market assessment and country risk.
KEY_INDICATORS = {
    "gdp_usd":              "NY.GDP.MKTP.CD",      # GDP current US$
    "gdp_per_capita_usd":   "NY.GDP.PCAP.CD",      # GDP per capita current US$
    "gdp_growth_pct":       "NY.GDP.MKTP.KD.ZG",   # GDP growth rate %
    "population":           "SP.POP.TOTL",          # Total population
    "inflation_pct":        "FP.CPI.TOTL.ZG",       # Inflation, consumer prices %
    "gni_per_capita_usd":   "NY.GNP.PCAP.CD",      # GNI per capita (income proxy)
    "trade_pct_gdp":        "NE.TRD.GNFS.ZS",      # Trade openness (exports+imports/GDP)
    "fdi_inflows_usd":      "BX.KLT.DINV.CD.WD",   # Foreign direct investment inflows
    "internet_users_pct":   "IT.NET.USER.ZS",       # Internet penetration %
    "unemployment_pct":     "SL.UEM.TOTL.ZS",       # Unemployment rate %
    "urban_population_pct": "SP.URB.TOTL.IN.ZS",   # Urban population share %
    "exports_goods_usd":    "BX.GSR.MRCH.CD",       # Merchandise exports US$
    "imports_goods_usd":    "BM.GSR.MRCH.CD",       # Merchandise imports US$
}


def fetch_single_indicator(country_code, indicator_code, year=None):
    """Fetch the most recent value for one indicator from the World Bank API."""
    url = f"{BASE_URL}/country/{country_code}/indicator/{indicator_code}"
    params = {"format": "json", "mrv": 5, "per_page": 5}
    if year:
        params["date"] = str(year)

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()

            # World Bank returns [metadata, [records]] — skip null values
            if len(data) >= 2 and data[1]:
                for record in data[1]:
                    if record.get("value") is not None:
                        return {
                            "value": record["value"],
                            "year": record["date"],
                            "country_name": record.get("country", {}).get("value"),
                        }
            return None
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_world_bank] Failed {indicator_code}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_indicators(args):
    """Fetch all key indicators for a country."""
    country = args.country.upper()
    results = {}
    errors = []

    for name, code in KEY_INDICATORS.items():
        val = fetch_single_indicator(country, code, args.year)
        if val:
            results[name] = val
        else:
            errors.append(f"No data for {name} ({code})")
        time.sleep(0.2)  # Gentle rate limit — World Bank is a free public API

    # Fetch country metadata separately for context
    country_name = None
    try:
        meta = httpx.get(f"{BASE_URL}/country/{country}", params={"format": "json"}, timeout=10)
        meta_data = meta.json()
        if len(meta_data) >= 2 and meta_data[1]:
            country_name = meta_data[1][0].get("name")
    except Exception:
        pass

    output = {
        "source": "World Bank Open Data — free, no API key required",
        "country_code": country,
        "country_name": country_name,
        "indicators": results,
        "records": [{"country": country_name or country, **v, "indicator": k} for k, v in results.items()],
        "data_notes": "Values show most recent available year (up to 5 years back). World Bank data lags 1–2 years.",
    }
    if errors:
        output["partial_errors"] = errors
    return output


def cmd_compare(args):
    """Compare a single indicator across two countries."""
    c1 = args.country1.upper()
    c2 = args.country2.upper()
    indicator = args.indicator

    # If no indicator specified, default to GDP per capita
    if not indicator:
        indicator = "NY.GDP.PCAP.CD"
        indicator_label = "gdp_per_capita_usd"
    else:
        indicator_label = indicator

    r1 = fetch_single_indicator(c1, indicator)
    time.sleep(0.3)
    r2 = fetch_single_indicator(c2, indicator)

    records = []
    if r1:
        records.append({"country": c1, "country_name": r1.get("country_name"), "indicator": indicator_label,
                         "value": r1["value"], "year": r1["year"]})
    if r2:
        records.append({"country": c2, "country_name": r2.get("country_name"), "indicator": indicator_label,
                         "value": r2["value"], "year": r2["year"]})

    return {
        "source": "World Bank Open Data",
        "indicator_code": indicator,
        "indicator_label": indicator_label,
        "records": records,
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch World Bank development indicators")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # indicators command
    p_ind = subparsers.add_parser("indicators", help="Fetch key indicators for a country")
    p_ind.add_argument("country", help="ISO-2 country code (e.g. US, SO, CN, DE)")
    p_ind.add_argument("--year", type=int, help="Specific year (default: most recent available)")
    p_ind.set_defaults(func=cmd_indicators)

    # compare command
    p_cmp = subparsers.add_parser("compare", help="Compare an indicator across two countries")
    p_cmp.add_argument("country1", help="First country ISO-2 code")
    p_cmp.add_argument("country2", help="Second country ISO-2 code")
    p_cmp.add_argument("--indicator", help="World Bank indicator code (default: NY.GDP.PCAP.CD)")
    p_cmp.set_defaults(func=cmd_compare)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
