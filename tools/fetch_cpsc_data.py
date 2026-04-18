"""
fetch_cpsc_data.py — CPSC Consumer Product Safety Commission
Fetches product recalls and safety incident reports. No API key required.
Commands:
  recalls    [--query QUERY] [--category CATEGORY] [--limit N]  — recent product safety recalls
  incidents  [--query QUERY] [--limit N]                        — consumer incident/injury reports
  standards  <product_type>                                      — safety standard guidance
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

RECALLS_BASE   = "https://www.saferproducts.gov/RestWebServices"
INCIDENTS_BASE = "https://www.saferproducts.gov/RestWebServices"
MAX_RETRIES    = 3

# CPSC product categories used in their database
CPSC_CATEGORIES = {
    "food": "Food, Food Preparation, & Serving",
    "kitchen": "Kitchen & Household Supplies",
    "furniture": "Home Furnishings",
    "electronics": "Electrical Products",
    "toys": "Toys, Games, & Hobbies",
    "clothing": "Apparel",
    "sports": "Sports, Recreation & Exercise Equipment",
    "medical": "Medical Equipment",
    "baby": "Children's Products",
    "appliances": "Housewares & Accessories",
    "tools": "Workshop, Garden, & Outdoor Tools",
    "lighting": "Lighting Equipment",
    "heating": "Heating, Cooling & Ventilation Products",
}

# Standard guidance lookup — hardcoded reference data (CPSC standards are stable)
STANDARDS_REFERENCE = {
    "furniture": {
        "standards": [
            "ASTM F2057 — Clothing storage unit tip-over (dressers, wardrobes)",
            "ASTM F3096 — Clothing storage unit stability",
            "16 CFR Part 1261 — Tipover of clothing storage units (mandatory, effective 2023)",
            "ANSI/BIFMA X5.1 — Office seating",
            "ANSI/BIFMA X5.5 — Desk/table products",
        ],
        "key_hazards": ["Tip-over (dressers)", "Entrapment", "Sharp edges", "Formaldehyde off-gassing"],
        "regulatory_body": "CPSC + ASTM International",
    },
    "electronics": {
        "standards": [
            "UL 62368-1 — Audio/video, IT and communication technology equipment",
            "UL 60950-1 — IT equipment safety (legacy)",
            "16 CFR Part 1505 — Electrically operated toys",
            "FCC Part 15 — EMC emissions (separate from CPSC but related)",
        ],
        "key_hazards": ["Fire/overheating", "Electric shock", "Lithium battery hazards"],
        "regulatory_body": "CPSC + UL + FCC",
    },
    "food": {
        "standards": [
            "FDA FSMA — Food Safety Modernization Act requirements",
            "FDA 21 CFR — Food labelling and safety regulations",
            "CPSC does not regulate food products directly — FDA has primary jurisdiction",
        ],
        "key_hazards": ["Choking (packaging)", "Chemical contamination (packaging materials)"],
        "regulatory_body": "FDA (primary) + CPSC (packaging only)",
        "note": "For food product safety, use fetch_fda_data.py instead.",
    },
    "toys": {
        "standards": [
            "ASTM F963 — Standard Consumer Safety Specification for Toy Safety",
            "16 CFR Part 1500 — Hazardous substances",
            "16 CFR Part 1303 — Lead paint ban",
            "CPSIA — Consumer Product Safety Improvement Act (children's products)",
        ],
        "key_hazards": ["Choking hazards", "Lead/phthalates", "Magnetic hazards", "Sharp points"],
        "regulatory_body": "CPSC",
    },
    "apparel": {
        "standards": [
            "16 CFR Part 1615/1616 — Flammability of children's sleepwear",
            "16 CFR Part 1610 — Flammability of clothing textiles",
            "16 CFR Part 1611 — Flammability of vinyl plastic film",
            "CPSIA — Lead content limits in children's products",
        ],
        "key_hazards": ["Flammability", "Choking (drawstrings)", "Lead/phthalates in children's items"],
        "regulatory_body": "CPSC + FTC (labelling)",
    },
    "kitchen": {
        "standards": [
            "UL 1037 — Anti-intrusion alarms",
            "NSF/ANSI 2 — Food equipment standards",
            "ASTM F1169 — Full-bed portable bed rails",
            "16 CFR Part 1500 — Hazardous substances",
        ],
        "key_hazards": ["Cuts (knives)", "Burns", "Electrical hazards", "Chemical off-gassing"],
        "regulatory_body": "CPSC + NSF",
    },
    "medical": {
        "standards": [
            "FDA 21 CFR Parts 800-898 — Medical device regulations (primary jurisdiction)",
            "CPSC has limited jurisdiction over most medical devices",
        ],
        "key_hazards": ["Device malfunction", "Infection risk"],
        "regulatory_body": "FDA (primary) — use fetch_fda_device_data.py",
        "note": "Medical devices are primarily regulated by FDA, not CPSC.",
    },
}


def cpsc_get(endpoint, params):
    """Fetch from CPSC SaferProducts API with retries."""
    url = f"{RECALLS_BASE}/{endpoint}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_cpsc_data] Failed {endpoint}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_recalls(args):
    """Fetch recent CPSC product recalls."""
    params = {
        "format":   "json",
        "RecallDateStart": "2020-01-01",
    }
    if args.query:
        params["query"] = args.query
    if args.category:
        # Map shorthand to full category name if possible
        cat = CPSC_CATEGORIES.get(args.category.lower(), args.category)
        params["ProductType"] = cat

    data = cpsc_get("recall", params)

    if not data:
        return {"source": "CPSC SaferProducts.gov", "records": [],
                "error": "No recalls returned. Try a broader query."}

    # CPSC returns a list of recall objects
    recalls = data if isinstance(data, list) else data.get("recalls", [])

    limit = min(args.limit, 30)
    records = []
    for r in recalls[:limit]:
        records.append({
            "recall_number":   r.get("RecallID"),
            "recall_date":     r.get("RecallDate"),
            "product_name":    r.get("Products", [{}])[0].get("Name") if r.get("Products") else None,
            "hazard":          r.get("Hazards", [{}])[0].get("Name") if r.get("Hazards") else None,
            "remedy":          r.get("Remedies", [{}])[0].get("Name") if r.get("Remedies") else None,
            "units_recalled":  r.get("NumberOfUnits"),
            "injuries":        r.get("Injuries"),
            "manufacturer":    r.get("Firms", [{}])[0].get("Name") if r.get("Firms") else None,
            "country_of_origin": r.get("ManufacturerCountry"),
            "description":     r.get("Description"),
        })

    return {
        "source": "CPSC SaferProducts.gov — free, no key required",
        "query": args.query,
        "category_filter": args.category,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "CPSC recalls since 2020. Full recall database at cpsc.gov/Recalls. "
            "Use to assess product safety risk profile and recall history in your category."
        ),
    }


def cmd_incidents(args):
    """Fetch consumer safety incident reports from CPSC SaferProducts."""
    params = {
        "format": "json",
    }
    if args.query:
        params["query"] = args.query

    data = cpsc_get("report", params)

    if not data:
        return {"source": "CPSC Incident Reports", "records": [],
                "error": "No incidents returned."}

    incidents = data if isinstance(data, list) else data.get("reports", [])
    limit = min(args.limit, 20)

    records = []
    for inc in incidents[:limit]:
        records.append({
            "incident_date":  inc.get("DateOfIncident"),
            "product":        inc.get("ProductDescription"),
            "injury_type":    inc.get("InjuryType"),
            "description":    inc.get("IncidentDescription"),
            "age_of_victim":  inc.get("AgeOfVictim"),
        })

    return {
        "source": "CPSC SaferProducts.gov Incident Reports — free, no key required",
        "query": args.query,
        "records": records,
        "total_returned": len(records),
        "data_notes": "Consumer-reported injury/incident data. Use to understand real-world safety concerns.",
    }


def cmd_standards(args):
    """Look up applicable safety standards for a product type."""
    product = args.product_type.lower()

    # Try exact match first, then partial match
    match = STANDARDS_REFERENCE.get(product)
    if not match:
        for key, val in STANDARDS_REFERENCE.items():
            if key in product or product in key:
                match = val
                break

    if not match:
        return {
            "source": "CPSC Standards Reference",
            "product_type": args.product_type,
            "records": [],
            "note": (
                f"No pre-loaded standards for '{args.product_type}'. "
                f"Available categories: {list(STANDARDS_REFERENCE.keys())}. "
                "Search cpsc.gov/Business--Manufacturing/Business-Education for official standards."
            ),
        }

    return {
        "source": "CPSC Standards Reference (compiled from cpsc.gov/regulations)",
        "product_type": args.product_type,
        "applicable_standards": match.get("standards", []),
        "key_hazards": match.get("key_hazards", []),
        "regulatory_body": match.get("regulatory_body"),
        "note": match.get("note"),
        "records": [{"standard": s} for s in match.get("standards", [])],
        "data_notes": "Reference data — verify current versions at cpsc.gov or astm.org.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch CPSC product safety recalls and standards")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_rec = subparsers.add_parser("recalls", help="Search CPSC product recalls")
    p_rec.add_argument("--query", help="Product keyword (e.g. 'furniture', 'camel milk', 'modular kitchen')")
    p_rec.add_argument("--category", help="Product category shorthand: furniture, electronics, food, toys, apparel, kitchen, medical")
    p_rec.add_argument("--limit", type=int, default=15, help="Max results (default 15)")
    p_rec.set_defaults(func=cmd_recalls)

    p_inc = subparsers.add_parser("incidents", help="Search consumer injury/incident reports")
    p_inc.add_argument("--query", help="Product keyword")
    p_inc.add_argument("--limit", type=int, default=15, help="Max results (default 15)")
    p_inc.set_defaults(func=cmd_incidents)

    p_std = subparsers.add_parser("standards", help="Look up safety standards for a product type")
    p_std.add_argument("product_type", help="Product type: furniture, electronics, food, toys, apparel, kitchen, medical")
    p_std.set_defaults(func=cmd_standards)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
