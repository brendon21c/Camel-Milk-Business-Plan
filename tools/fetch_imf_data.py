"""
fetch_imf_data.py — IMF DataMapper API
Fetches macroeconomic indicators for any country. No API key required.
Commands:
  indicators  <country_iso>  — GDP growth, inflation, current account, unemployment
  outlook     <country_iso>  — WEO forecast data (growth, inflation trajectory)
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://www.imf.org/external/datamapper/api/v1"
MAX_RETRIES = 3

# IMF indicators most useful for market entry and country risk assessment
KEY_INDICATORS = {
    "gdp_growth_pct":           "NGDP_RPCH",   # Real GDP growth %
    "gdp_per_capita_ppp_usd":   "PPPPC",        # GDP per capita PPP (purchasing power)
    "gdp_per_capita_usd":       "NGDPDPC",      # GDP per capita nominal US$
    "inflation_pct":            "PCPIPCH",      # Consumer price inflation %
    "current_account_pct_gdp":  "BCA_NGDPD",   # Current account balance % GDP
    "unemployment_pct":         "LUR",          # Unemployment rate %
    "government_debt_pct_gdp":  "GGXWDG_NGDP", # Government gross debt % GDP
    "population_millions":      "LP",           # Population (millions)
    "exports_pct_gdp":          "BX_NGDPD",    # Exports % GDP
    "imports_pct_gdp":          "BM_NGDPD",    # Imports % GDP
}


def fetch_indicator(indicator_code, country_code):
    """Fetch a single indicator for a country from IMF DataMapper API."""
    url = f"{BASE_URL}/{indicator_code}/{country_code}"

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()

            # IMF returns {"values": {"INDICATOR": {"COUNTRY": {"YEAR": value}}}}
            values = data.get("values", {}).get(indicator_code, {}).get(country_code, {})
            if not values:
                return None

            # Return the 3 most recent years with non-null values
            sorted_years = sorted(values.keys(), reverse=True)
            recent = {}
            for yr in sorted_years:
                if values[yr] is not None and len(recent) < 3:
                    recent[yr] = values[yr]

            if not recent:
                return None

            latest_year = sorted_years[0]
            return {
                "value": values.get(latest_year),
                "year": latest_year,
                "recent_trend": recent,
            }
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_imf_data] Failed {indicator_code}/{country_code}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def get_country_label(country_code):
    """Fetch country name from IMF country list."""
    try:
        resp = httpx.get(f"{BASE_URL}/countries/{country_code}", timeout=10)
        data = resp.json()
        labels = data.get("countries", {}).get(country_code, {})
        return labels.get("label", country_code)
    except Exception:
        return country_code


def cmd_indicators(args):
    """Fetch all key IMF macroeconomic indicators for a country."""
    country = args.country.upper()
    country_name = get_country_label(country)
    results = {}
    errors = []

    for name, code in KEY_INDICATORS.items():
        val = fetch_indicator(code, country)
        if val:
            results[name] = val
        else:
            errors.append(f"No data for {name} ({code})")
        time.sleep(0.25)

    records = [
        {"country": country, "country_name": country_name, "indicator": k,
         "value": v["value"], "year": v["year"], "recent_trend": v.get("recent_trend")}
        for k, v in results.items()
    ]

    output = {
        "source": "IMF DataMapper API — free, no API key required",
        "country_code": country,
        "country_name": country_name,
        "indicators": results,
        "records": records,
        "data_notes": (
            "IMF World Economic Outlook data. Includes actual and forecast values. "
            "Years marked with 'E' are IMF estimates/forecasts."
        ),
    }
    if errors:
        output["partial_errors"] = errors
    return output


def cmd_outlook(args):
    """Fetch IMF World Economic Outlook growth and inflation trajectory."""
    country = args.country.upper()
    country_name = get_country_label(country)

    # Pull the two most forecast-relevant indicators
    forecast_indicators = {
        "gdp_growth_pct": "NGDP_RPCH",
        "inflation_pct": "PCPIPCH",
    }

    results = {}
    for name, code in forecast_indicators.items():
        url = f"{BASE_URL}/{code}/{country}"
        try:
            resp = httpx.get(url, timeout=15)
            data = resp.json()
            values = data.get("values", {}).get(code, {}).get(country, {})

            # Get 5 years of data: 2 historical + current + 2 forecast
            sorted_years = sorted(values.keys(), reverse=True)
            window = {}
            for yr in sorted_years[:5]:
                if values.get(yr) is not None:
                    window[yr] = values[yr]
            results[name] = window
        except Exception as e:
            results[name] = {"error": str(e)}
        time.sleep(0.25)

    records = [
        {"country": country, "indicator": name, "values_by_year": yrs}
        for name, yrs in results.items()
    ]

    return {
        "source": "IMF World Economic Outlook — free, no API key required",
        "country_code": country,
        "country_name": country_name,
        "outlook": results,
        "records": records,
        "data_notes": "Values include IMF forecasts for current and future years.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch IMF macroeconomic indicators")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_ind = subparsers.add_parser("indicators", help="Fetch key IMF indicators for a country")
    p_ind.add_argument("country", help="IMF country code (e.g. USA, SOM, DEU, CHN). Use 3-letter codes.")
    p_ind.set_defaults(func=cmd_indicators)

    p_out = subparsers.add_parser("outlook", help="Fetch IMF WEO growth and inflation trajectory")
    p_out.add_argument("country", help="IMF country code (3-letter, e.g. USA, SOM, DEU)")
    p_out.set_defaults(func=cmd_outlook)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
