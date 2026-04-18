"""
fetch_rapex_data.py — EU Safety Gate (formerly RAPEX) Product Safety Alerts
Fetches EU product safety notifications and market surveillance data.
No API key required.
Commands:
  alerts   [--query QUERY] [--category CATEGORY] [--year YYYY] [--limit N]  — EU safety alerts
  summary  <product_category>  — product safety risk summary for a category
"""

import argparse
import json
import sys
import time
from datetime import datetime

import httpx
from dotenv import load_dotenv

load_dotenv()

# EU Safety Gate API — weekly reports available as XML/JSON downloads
# Primary download endpoint for structured data
SAFETY_GATE_BASE  = "https://ec.europa.eu/consumers/consumers_safety/safety_products/rapex/alerts"
SAFETY_GATE_API   = "https://webgate.ec.europa.eu/rapidexchange/search"  # newer endpoint
MAX_RETRIES       = 3

# Pre-loaded product safety risk summaries by category
# Based on EU Safety Gate annual reports and recurring alert patterns
SAFETY_RISK_SUMMARIES = {
    "furniture": {
        "common_hazards": [
            "Tip-over risk (wardrobes, chests of drawers) — EN 2580:2022 standard",
            "Entrapment hazard (bunk beds, cots)",
            "Sharp edges and protrusions",
            "Formaldehyde emissions from MDF/particleboard (exceeding EU limit 0.124 mg/m³)",
            "Structural failure (collapse under load)",
            "Chemical hazards — phthalates in upholstery, lead in paint",
        ],
        "main_origin_countries": ["China (>60% of alerts)", "India", "Turkey"],
        "regulatory_framework": "EN 716 (children's cots), EN 747 (bunk beds), REACH Regulation, RoHS",
        "alert_volume": "Furniture consistently in top 5 RAPEX categories",
        "market_surveillance": "EU member states conduct random border checks; China furniture under elevated scrutiny",
    },
    "electronics": {
        "common_hazards": [
            "Electric shock risk (non-compliant insulation, inadequate earthing)",
            "Fire/overheating (lithium battery failures)",
            "Electromagnetic interference (non-compliant RF emissions)",
            "Excessive radiation (lasers, UV)",
            "Chemical hazards — SVHC substances under REACH",
        ],
        "main_origin_countries": ["China (>75% of alerts)", "Hong Kong"],
        "regulatory_framework": "LVD (Low Voltage Directive), EMC Directive, RoHS, REACH, CE marking required",
        "alert_volume": "Electronics consistently #1 or #2 category in RAPEX annual reports",
        "market_surveillance": "Enhanced border controls for electronics from China",
    },
    "clothing_apparel": {
        "common_hazards": [
            "Flammability (children's nightwear, costumes — EN 14878, EN 1103)",
            "Chemical hazards — azo dyes, formaldehyde, nickel in fasteners",
            "Choking/strangulation (drawstrings on children's garments — EN 14682)",
            "Phthalates in prints/coatings",
            "Small detachable parts (choking hazard for children)",
        ],
        "main_origin_countries": ["China", "India", "Bangladesh", "Turkey"],
        "regulatory_framework": "REACH Regulation (chemical limits), EN 14682 (drawstrings), GPSD",
        "alert_volume": "Clothing consistently #2 or #3 category in RAPEX annual reports",
        "market_surveillance": "Children's clothing under highest scrutiny for chemical and mechanical hazards",
    },
    "food": {
        "common_hazards": [
            "Microbiological contamination (Salmonella, Listeria, E. coli)",
            "Undeclared allergens (nut traces, gluten, milk proteins)",
            "Excessive pesticide residues",
            "Chemical contaminants (aflatoxins, mycotoxins, heavy metals)",
            "Foreign bodies (physical contamination)",
            "Misleading health claims not permitted under EU law",
        ],
        "main_origin_countries": ["Turkey (nuts/dried fruits)", "India (spices)", "US (some products)", "China"],
        "regulatory_framework": "EU Food Law (EC 178/2002), RASFF system, EU pesticide MRLs, Allergen labeling (EU 1169/2011)",
        "note": "Food alerts are managed by RASFF (not RAPEX). Use fetch_fda_data.py for FDA food alerts.",
        "alert_volume": "Food alerts tracked separately in EU RASFF system",
    },
    "toys": {
        "common_hazards": [
            "Choking hazard (small detachable parts)",
            "Chemical hazards — phthalates, lead, formaldehyde in paints",
            "Strangulation (cords, strings)",
            "Sharp points and edges",
            "Magnetic hazards (strong magnets if swallowed)",
            "Electrical hazards in electronic toys",
        ],
        "main_origin_countries": ["China (>80% of alerts)"],
        "regulatory_framework": "Toy Safety Directive (2009/48/EC), EN 71 series, REACH",
        "alert_volume": "Toys consistently #1 RAPEX category by alert count",
        "market_surveillance": "Customs authorities screen all toy shipments; QR code traceability being introduced",
    },
    "cosmetics": {
        "common_hazards": [
            "Prohibited substances (mercury, hydroquinone above limits)",
            "Undeclared allergens",
            "Microbial contamination",
            "Excessive levels of permitted substances",
        ],
        "regulatory_framework": "EU Cosmetics Regulation (EC 1223/2009), Annex II prohibited substances list",
        "main_origin_countries": ["China", "US", "India"],
        "alert_volume": "Medium alert volume — well-regulated category with established standards",
    },
}


def fetch_safety_gate_data(query=None, category=None, year=None, limit=20):
    """Attempt to fetch live EU Safety Gate alert data."""
    # EU Safety Gate provides weekly CSV/XML downloads
    # Try the search API endpoint
    params = {
        "format": "json",
        "rows":   min(limit, 50),
    }
    if query:
        params["q"] = query
    if year:
        params["year"] = year
    if category:
        params["productCategory"] = category

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(f"{SAFETY_GATE_BASE}/screen/webReport",
                             params=params, timeout=20,
                             headers={"Accept": "application/json"})
            if resp.status_code in (200, 201):
                ct = resp.headers.get("content-type", "")
                if "json" in ct:
                    return resp.json()
            return None
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_rapex_data] Safety Gate live API failed: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_alerts(args):
    """Fetch EU Safety Gate product safety alerts."""
    # Try live API
    live_data = fetch_safety_gate_data(
        query=args.query,
        category=args.category,
        year=args.year,
        limit=args.limit,
    )

    if live_data and isinstance(live_data, (dict, list)):
        alerts = live_data if isinstance(live_data, list) else live_data.get("alerts", live_data.get("results", []))
        records = [
            {
                "alert_number": a.get("reference"),
                "date":         a.get("date"),
                "product":      a.get("productType") or a.get("product"),
                "hazard":       a.get("typeOfHazard") or a.get("hazard"),
                "country":      a.get("notifyingCountry") or a.get("country"),
                "origin":       a.get("productOrigin") or a.get("origin"),
                "measure":      a.get("measuresTaken") or a.get("measure"),
                "description":  (a.get("description", "") or "")[:200],
            }
            for a in alerts[:args.limit]
        ]
        if records:
            return {
                "source": "EU Safety Gate (RAPEX) — free, no key required",
                "query": args.query,
                "records": records,
                "total_returned": len(records),
                "data_notes": "EU product safety notifications. Full database at ec.europa.eu/safety-gate-alerts.",
            }

    # Fall back to guidance + reference data
    return {
        "source": "EU Safety Gate (RAPEX) Reference — free, no key required",
        "query": args.query,
        "category": args.category,
        "records": [],
        "note": (
            "EU Safety Gate live API requires direct portal access. "
            "Use 'summary' command for pre-loaded risk data by product category. "
            "Full alert database: ec.europa.eu/safety-gate-alerts/screen/webReport"
        ),
        "download_data": (
            "Weekly CSV downloads available at: "
            "ec.europa.eu/consumers/consumers_safety/safety_products/rapex/alerts/repository/content/pages/rapex/reports/"
        ),
    }


def cmd_summary(args):
    """Return pre-loaded EU product safety risk summary for a category."""
    category = args.product_category.lower().replace(" ", "_").replace("-", "_")

    summary = SAFETY_RISK_SUMMARIES.get(category)
    if not summary:
        for key, val in SAFETY_RISK_SUMMARIES.items():
            if key in category or category in key:
                summary = val
                category = key
                break

    if not summary:
        return {
            "source": "EU Safety Gate Risk Reference",
            "product_category": args.product_category,
            "records": [],
            "available_categories": list(SAFETY_RISK_SUMMARIES.keys()),
            "note": (
                f"No pre-loaded summary for '{args.product_category}'. "
                "See ec.europa.eu/safety-gate-alerts for live data."
            ),
        }

    records = [{"hazard": h} for h in summary.get("common_hazards", [])]

    return {
        "source": "EU Safety Gate Risk Reference (compiled from RAPEX annual reports)",
        "product_category": category,
        "common_hazards": summary.get("common_hazards", []),
        "main_origin_countries": summary.get("main_origin_countries", []),
        "regulatory_framework": summary.get("regulatory_framework"),
        "alert_volume_context": summary.get("alert_volume"),
        "market_surveillance_note": summary.get("market_surveillance"),
        "note": summary.get("note"),
        "records": records,
        "data_notes": (
            "Reference data compiled from EU Safety Gate annual reports. "
            "Use for EU market regulatory risk assessment and product compliance planning."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch EU Safety Gate product safety alerts")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_alerts = subparsers.add_parser("alerts", help="Search EU Safety Gate product safety alerts")
    p_alerts.add_argument("--query",    help="Product keyword (e.g. 'kitchen tools', 'furniture', 'toy')")
    p_alerts.add_argument("--category", help="Product category filter")
    p_alerts.add_argument("--year",     type=int, help="Alert year (e.g. 2023)")
    p_alerts.add_argument("--limit",    type=int, default=15, help="Max results (default 15)")
    p_alerts.set_defaults(func=cmd_alerts)

    p_sum = subparsers.add_parser("summary", help="Pre-loaded EU product safety risk summary by category")
    p_sum.add_argument("product_category", help=(
        "Category: furniture, electronics, clothing_apparel, food, toys, cosmetics"
    ))
    p_sum.set_defaults(func=cmd_summary)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
