"""
fetch_eurostat_data.py — Eurostat API (EU Statistical Office)
Fetches EU market, trade, and industry statistics. No API key required.
Commands:
  trade     <product_code>  [--reporter COUNTRY] [--year YYYY]  — EU imports/exports by product
  industry  <nace_code>     [--country COUNTRY] [--year YYYY]   — EU industry production stats
  market    <country_iso2>  — market size proxy: GDP, population, income for an EU country
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data"
MAX_RETRIES = 3

# Eurostat country codes (2-letter, mostly ISO-2)
EU_COUNTRIES = {
    "de": "DE", "germany": "DE",
    "fr": "FR", "france": "FR",
    "it": "IT", "italy": "IT",
    "es": "ES", "spain": "ES",
    "nl": "NL", "netherlands": "NL",
    "pl": "PL", "poland": "PL",
    "be": "BE", "belgium": "BE",
    "se": "SE", "sweden": "SE",
    "at": "AT", "austria": "AT",
    "dk": "DK", "denmark": "DK",
    "fi": "FI", "finland": "FI",
    "pt": "PT", "portugal": "PT",
    "gr": "EL", "greece": "EL",
    "hu": "HU", "hungary": "HU",
    "cz": "CZ", "czechia": "CZ",
    "ro": "RO", "romania": "RO",
    "eu": "EU27_2020",  # EU-27 aggregate
    "eu27": "EU27_2020",
}


def eurostat_get(dataset, params):
    """Fetch data from Eurostat REST API with retries."""
    url = f"{BASE_URL}/{dataset}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=25)
            if resp.status_code == 400:
                # Often means the filter combination doesn't exist
                return {"error": f"No data for this filter combination (400)", "records": []}
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_eurostat_data] Failed {dataset}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def parse_eurostat_json(data):
    """Parse Eurostat SDMX-JSON into flat records.

    Eurostat SDMX-JSON structure: data.value (flat array indexed by combined
    dimension position) + dimension value arrays to decode the index.
    """
    if not data or "value" not in data:
        return []

    try:
        dims = data.get("dimension", {})
        dim_order = data.get("id", [])
        dim_sizes = data.get("size", [])

        # Build dimension value lookup: dim_name → [value0, value1, ...]
        dim_labels = {}
        for dim_name in dim_order:
            category = dims.get(dim_name, {}).get("category", {})
            # Labels may be under 'label' or use index as key
            label_map = category.get("label", {})
            index_map = category.get("index", {})
            # Invert index map: position → code
            inv_index = {v: k for k, v in index_map.items()} if index_map else {}
            ordered_values = [inv_index.get(i, str(i)) for i in range(len(inv_index))]
            ordered_labels = [label_map.get(code, code) for code in ordered_values]
            dim_labels[dim_name] = ordered_labels

        values = data.get("value", {})
        records = []
        for flat_idx_str, value in values.items():
            if value is None:
                continue
            flat_idx = int(flat_idx_str)

            # Decode flat index back to per-dimension indices
            dim_indices = []
            remaining = flat_idx
            for size in reversed(dim_sizes):
                dim_indices.insert(0, remaining % size)
                remaining //= size

            record = {}
            for i, dim_name in enumerate(dim_order):
                labels = dim_labels.get(dim_name, [])
                idx = dim_indices[i] if i < len(dim_indices) else 0
                record[dim_name] = labels[idx] if idx < len(labels) else str(idx)
            record["value"] = value
            records.append(record)

        return records
    except Exception as e:
        print(f"[fetch_eurostat_data] Parse error: {e}", file=sys.stderr)
        return []


def cmd_trade(args):
    """Fetch EU trade statistics for a product (Comext dataset DS-016890)."""
    product = args.product_code.upper()
    reporter = EU_COUNTRIES.get(args.reporter.lower(), args.reporter.upper()) if args.reporter else "EU27_2020"
    year = args.year or 2022

    # DS-016890 = EU Trade in Goods (Comext)
    params = {
        "product":   product,
        "reporter":  reporter,
        "flow":      "1,2",         # 1=import, 2=export
        "period":    str(year),
        "lang":      "en",
        "format":    "JSON",
    }

    data = eurostat_get("DS-016890", params)
    if not data or "error" in data:
        return {
            "source": "Eurostat Comext Trade Data",
            "note": (
                f"No trade data found for product code '{product}'. "
                "Use CN (Combined Nomenclature) 8-digit codes or HS 6-digit codes."
            ),
            "records": [],
        }

    records = parse_eurostat_json(data)

    return {
        "source": "Eurostat Comext (EU Trade in Goods) — free, no key required",
        "dataset": "DS-016890",
        "product_code": product,
        "reporter_country": reporter,
        "year": year,
        "records": records[:30],
        "total_returned": len(records),
        "data_notes": "Values in EUR thousands. Flow 1=Imports, 2=Exports. CN codes available at ec.europa.eu/taxation_customs/dds2/taric/",
    }


def cmd_industry(args):
    """Fetch EU industrial production index for a NACE sector."""
    nace = args.nace_code.upper()
    country = EU_COUNTRIES.get(args.country.lower(), args.country.upper()) if args.country else "EU27_2020"
    year = args.year or 2022

    # STS_INPR_A = Short-Term Statistics, Industrial Production annual
    params = {
        "nace_r2": nace,
        "geo":     country,
        "time":    str(year),
        "unit":    "I15",  # Index 2015=100
        "lang":    "en",
        "format":  "JSON",
    }

    data = eurostat_get("sts_inpr_a", params)
    if not data:
        return {"source": "Eurostat Industry Stats", "records": [],
                "note": f"No production data for NACE code '{nace}'. Common codes: C=manufacturing, C10=food, C31=furniture"}

    records = parse_eurostat_json(data)

    return {
        "source": "Eurostat STS Industrial Production — free, no key required",
        "dataset": "sts_inpr_a",
        "nace_code": nace,
        "country": country,
        "year": year,
        "records": records[:20],
        "total_returned": len(records),
        "data_notes": "Production index (2015=100). NACE Rev.2 codes: C=manufacturing, C10=food/beverage, C31=furniture, C26=electronics.",
    }


def cmd_market(args):
    """Fetch EU country market profile: GDP, population, household income."""
    country = EU_COUNTRIES.get(args.country.lower(), args.country.upper())
    results = {}

    # GDP per capita (nama_10_pc)
    data_gdp = eurostat_get("nama_10_pc", {
        "geo": country, "unit": "CP_EUR_HAB", "na_item": "B1GQ",
        "time": "2022", "lang": "en", "format": "JSON"
    })
    if data_gdp:
        records = parse_eurostat_json(data_gdp)
        results["gdp_per_capita_eur"] = records[:3]

    time.sleep(0.3)

    # Population (demo_gind)
    data_pop = eurostat_get("demo_gind", {
        "geo": country, "indic_de": "JAN", "time": "2022",
        "lang": "en", "format": "JSON"
    })
    if data_pop:
        records = parse_eurostat_json(data_pop)
        results["population"] = records[:3]

    time.sleep(0.3)

    # Median household income (ilc_di03)
    data_inc = eurostat_get("ilc_di03", {
        "geo": country, "time": "2022", "lang": "en", "format": "JSON"
    })
    if data_inc:
        records = parse_eurostat_json(data_inc)
        results["median_household_income_eur"] = records[:3]

    flat_records = [
        {"country": country, "metric": k, "data": v}
        for k, v in results.items()
    ]

    return {
        "source": "Eurostat — EU Statistical Office (free, no key required)",
        "country": country,
        "market_profile": results,
        "records": flat_records,
        "data_notes": "Values in EUR. Use for EU market sizing and purchasing power context.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch Eurostat EU market and trade data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_trade = subparsers.add_parser("trade", help="EU imports/exports for a product (Comext)")
    p_trade.add_argument("product_code", help="CN (8-digit) or HS (6-digit) product code (e.g. '04039090' for specialty milk)")
    p_trade.add_argument("--reporter", help="EU country code (default: EU27 aggregate). Examples: DE, FR, NL")
    p_trade.add_argument("--year", type=int, help="Year (default: 2022)")
    p_trade.set_defaults(func=cmd_trade)

    p_ind = subparsers.add_parser("industry", help="EU industrial production index by NACE sector")
    p_ind.add_argument("nace_code", help="NACE Rev.2 code (e.g. 'C10'=food, 'C31'=furniture, 'C26'=electronics)")
    p_ind.add_argument("--country", help="EU country code (default: EU27 aggregate)")
    p_ind.add_argument("--year", type=int, help="Year (default: 2022)")
    p_ind.set_defaults(func=cmd_industry)

    p_market = subparsers.add_parser("market", help="EU country market profile (GDP, population, income)")
    p_market.add_argument("country", help="EU country code (e.g. DE, FR, IT, NL, PL) or 'EU' for EU aggregate")
    p_market.set_defaults(func=cmd_market)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
