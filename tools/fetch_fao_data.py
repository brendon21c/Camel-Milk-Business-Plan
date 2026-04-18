"""
fetch_fao_data.py — FAOSTAT API (UN Food and Agriculture Organization)
Fetches global food and agricultural production/trade data. No API key required.
Commands:
  production  <item>  [--country COUNTRY] [--year YYYY]  — crop/livestock production volumes
  trade       <item>  [--reporter COUNTRY] [--partner COUNTRY] [--year YYYY] — export/import flows
  prices      <item>  [--country COUNTRY]  — producer prices for an agricultural commodity
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://fenixservices.fao.org/faostat/api/v1"
MAX_RETRIES = 3

# FAOSTAT area codes for commonly referenced countries
# Full list available at: https://fenixservices.fao.org/faostat/api/v1/area/list
COUNTRY_CODES = {
    "world": "1",
    "usa": "231", "us": "231", "united states": "231",
    "somalia": "201", "so": "201",
    "kenya": "114",  "ethiopia": "238",
    "china": "351",  "cn": "351",
    "india": "100",  "in": "100",
    "germany": "79", "de": "79",
    "france": "68",  "fr": "68",
    "uk": "229",     "gb": "229",
    "uae": "225",    "saudi arabia": "193",
    "australia": "10", "au": "10",
    "canada": "33",  "ca": "33",
    "brazil": "21",  "br": "21",
    "mexico": "138", "mx": "138",
}


def resolve_country(name):
    """Convert country name/ISO to FAOSTAT area code."""
    if name.isdigit():
        return name
    return COUNTRY_CODES.get(name.lower(), name)


def fao_get(endpoint, params):
    """Make a GET request to the FAOSTAT API with retries."""
    url = f"{BASE_URL}/{endpoint}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            print(f"[fetch_fao_data] Retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def cmd_production(args):
    """Fetch agricultural/food production data for a commodity."""
    item_name = args.item
    country = resolve_country(args.country) if args.country else "1"  # default: World
    year = args.year or "2020,2021,2022"

    params = {
        "area": country,
        "item": item_name,   # FAOSTAT accepts item names or codes
        "element": "production",
        "year": year,
        "show_flags": "false",
        "null_values": "false",
        "output_type": "objects",
    }

    try:
        data = fao_get("data/QCL", params)  # QCL = Crops and livestock products
    except Exception as e:
        # Try FAOSTAT search endpoint if direct query fails
        return {"error": f"Production query failed: {e}", "records": [],
                "source": "FAOSTAT", "suggestion": "Try a simpler item name (e.g. 'milk', 'camel meat', 'wheat')"}

    records = data.get("data", [])

    return {
        "source": "FAOSTAT — UN Food and Agriculture Organization (free, no key required)",
        "dataset": "Crops and Livestock Products (QCL)",
        "item_queried": item_name,
        "country_code": country,
        "records": [
            {
                "item": r.get("Item"),
                "area": r.get("Area"),
                "element": r.get("Element"),
                "year": r.get("Year"),
                "value": r.get("Value"),
                "unit": r.get("Unit"),
            }
            for r in records[:30]  # Cap at 30 to keep context manageable
        ],
        "total_returned": len(records),
        "data_notes": "Production data in tonnes unless otherwise noted. 'World' = global aggregate.",
    }


def cmd_trade(args):
    """Fetch agricultural trade (export/import) flows for a commodity."""
    item_name = args.item
    reporter = resolve_country(args.reporter) if args.reporter else "1"
    partner  = resolve_country(args.partner)  if args.partner  else None
    year = args.year or "2021,2022"

    params = {
        "reporter_area": reporter,
        "item": item_name,
        "element": "Export Quantity,Export Value,Import Quantity,Import Value",
        "year": year,
        "show_flags": "false",
        "null_values": "false",
        "output_type": "objects",
    }
    if partner:
        params["partner_area"] = partner

    try:
        data = fao_get("data/TCL", params)  # TCL = Trade: Crops and Livestock Products
    except Exception as e:
        return {"error": f"Trade query failed: {e}", "records": [],
                "source": "FAOSTAT",
                "suggestion": "Try a more generic item name or check FAOSTAT item list."}

    records = data.get("data", [])

    return {
        "source": "FAOSTAT Trade Data — UN FAO (free, no key required)",
        "dataset": "Trade: Crops and Livestock Products (TCL)",
        "item_queried": item_name,
        "reporter_country_code": reporter,
        "partner_country_code": partner,
        "records": [
            {
                "item": r.get("Item"),
                "reporter_country": r.get("Reporter Country"),
                "partner_country": r.get("Partner Country"),
                "element": r.get("Element"),
                "year": r.get("Year"),
                "value": r.get("Value"),
                "unit": r.get("Unit"),
            }
            for r in records[:30]
        ],
        "total_returned": len(records),
        "data_notes": "Export/Import Quantity in tonnes; Value in 1000 USD.",
    }


def cmd_prices(args):
    """Fetch producer price data for an agricultural commodity."""
    item_name = args.item
    country = resolve_country(args.country) if args.country else "1"
    year = args.year or "2020,2021,2022"

    params = {
        "area": country,
        "item": item_name,
        "element": "Producer Price",
        "year": year,
        "null_values": "false",
        "output_type": "objects",
    }

    try:
        data = fao_get("data/PP", params)  # PP = Producer Prices
    except Exception as e:
        return {"error": f"Price query failed: {e}", "records": [], "source": "FAOSTAT"}

    records = data.get("data", [])

    return {
        "source": "FAOSTAT Producer Prices — UN FAO (free, no key required)",
        "item_queried": item_name,
        "country_code": country,
        "records": [
            {
                "item": r.get("Item"),
                "area": r.get("Area"),
                "year": r.get("Year"),
                "price_usd_per_tonne": r.get("Value"),
                "unit": r.get("Unit"),
            }
            for r in records[:20]
        ],
        "total_returned": len(records),
        "data_notes": "Prices in USD per tonne at farm gate. Data often lags 1–2 years.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch FAO food and agricultural data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_prod = subparsers.add_parser("production", help="Agricultural production volumes by country/commodity")
    p_prod.add_argument("item", help='Commodity name (e.g. "Camel milk", "Wheat", "Cattle")')
    p_prod.add_argument("--country", help="Country name or ISO code (default: World aggregate)")
    p_prod.add_argument("--year", help="Year or comma-separated years (default: 2020,2021,2022)")
    p_prod.set_defaults(func=cmd_production)

    p_trade = subparsers.add_parser("trade", help="Agricultural export/import flows")
    p_trade.add_argument("item", help='Commodity name (e.g. "Milk", "Beef", "Wheat flour")')
    p_trade.add_argument("--reporter", help="Reporting country (exporter/importer) name or code")
    p_trade.add_argument("--partner", help="Partner country name or code (optional filter)")
    p_trade.add_argument("--year", help="Year or comma-separated years (default: 2021,2022)")
    p_trade.set_defaults(func=cmd_trade)

    p_price = subparsers.add_parser("prices", help="Agricultural producer prices")
    p_price.add_argument("item", help='Commodity name (e.g. "Milk", "Camel milk")')
    p_price.add_argument("--country", help="Country name or code (default: World)")
    p_price.add_argument("--year", help="Year or comma-separated years (default: 2020,2021,2022)")
    p_price.set_defaults(func=cmd_prices)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
