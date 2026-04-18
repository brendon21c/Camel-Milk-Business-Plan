"""
fetch_cbp_data.py — US Customs and Border Protection (CBP)
Fetches HTS tariff rulings, import requirements, and trade compliance guidance.
No API key required.
Commands:
  rulings   <hts_code>  [--query QUERY]  — CBP binding tariff classification rulings
  requirements <product> [--origin COUNTRY]  — import requirements reference for a product
  hts_lookup  <keyword>  — search HTS code descriptions to find the right tariff code
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

CBP_RULINGS_BASE = "https://rulings.cbp.gov/api"
HTS_BASE         = "https://hts.usitc.gov/reststop"
MAX_RETRIES      = 3

# Pre-loaded CBP import requirements by product/industry category.
# Sourced from CBP.gov and FDA/USDA entry guidance.
IMPORT_REQUIREMENTS = {
    "food": {
        "agencies": ["FDA", "USDA (for meat, poultry, eggs)", "CBP"],
        "requirements": [
            "FDA Prior Notice: Must be filed electronically ≥2–8 hours before arrival (depending on mode of transport)",
            "FDA Facility Registration: Foreign food facility must be registered with FDA (biennial renewal)",
            "Country of origin labeling (COOL): Required for most food products",
            "Nutrition facts panel: Required per FDA 21 CFR Part 101",
            "Ingredient declaration: Required, in descending order by weight",
            "HACCP compliance: Required for fish/seafood; recommended for all food processors",
            "Importer of Record: US-based entity responsible for compliance must be designated",
            "Bond: Continuous or single-entry customs bond required",
        ],
        "restricted_categories": [
            "Dairy from non-approved countries: USDA approval required for dairy product imports",
            "Meat/poultry: USDA FSIS approval required; country must be on eligible list",
            "Fresh fruits/vegetables: USDA APHIS phytosanitary inspection may be required",
        ],
        "typical_fees": "CBP processing fee (MPF): 0.3464% of value, min $27.23, max $528.33",
        "source": "CBP.gov + FDA import guidance",
    },
    "furniture": {
        "agencies": ["CBP", "EPA (formaldehyde)", "CPSC"],
        "requirements": [
            "HTS classification required (Chapter 94 for furniture)",
            "Country of origin marking required on product or packaging",
            "TSCA Section 6(h): Formaldehyde emission standards for composite wood products (CARB Phase 2)",
            "CPSC safety standards if applicable (see CPSC tool)",
            "Section 301 tariffs: Additional 25% tariff on furniture imported from China (HTS Chapter 94)",
            "Lacey Act: May apply to wooden furniture — requires declaration of wood species/country of harvest",
        ],
        "typical_fees": "MFN tariff: 0% for most furniture from non-Section-301 countries",
        "source": "CBP.gov + EPA TSCA guidance",
    },
    "electronics": {
        "agencies": ["CBP", "FCC", "CPSC"],
        "requirements": [
            "FCC equipment authorization required before import (FCC ID or Declaration of Conformity)",
            "Country of origin marking required",
            "UL listing or equivalent safety certification strongly recommended",
            "Section 301 tariffs: Additional 7.5–25% on electronics from China",
            "BIS export controls: Some electronics require Export Control Classification (ECCN) review",
        ],
        "typical_fees": "MFN tariff: 0–3.9% for most electronics",
        "source": "CBP.gov + FCC equipment authorization guidance",
    },
    "apparel": {
        "agencies": ["CBP", "FTC"],
        "requirements": [
            "Country of origin marking required (must appear on inner label)",
            "Fiber content labeling required (Textile Fiber Products Identification Act)",
            "Care instruction labeling required (FTC Permanent Care Labeling Rule)",
            "Quota/visa requirements: Some textile categories from some countries require visa",
            "Anti-dumping/CVD duties may apply (check USITC for current orders)",
            "GSP/AGOA: Certain apparel from qualifying countries may enter duty-free",
        ],
        "typical_fees": "MFN tariff: 12–32% for apparel (some of the highest US tariff rates)",
        "source": "CBP.gov + FTC textile labeling guidance",
    },
    "medical_device": {
        "agencies": ["FDA", "CBP"],
        "requirements": [
            "FDA 510(k) clearance or PMA approval required for Class II/III devices",
            "FDA establishment registration required",
            "FDA device listing required",
            "Quality System Regulation (QSR / 21 CFR Part 820) compliance",
            "Country of origin marking required",
            "UDI (Unique Device Identification): Required for Class II/III devices",
        ],
        "typical_fees": "MFN tariff: 0% for most medical devices (HTS Chapter 90)",
        "source": "FDA + CBP import guidance for medical devices",
    },
    "cosmetics": {
        "agencies": ["FDA", "CBP"],
        "requirements": [
            "FDA cosmetic registration (voluntary, but MoCRA 2022 makes facility registration mandatory by Dec 2023)",
            "Ingredient list required (INCI names, descending order)",
            "Warning statements required where applicable",
            "Prohibited ingredients list: FDA bans certain colorants, mercury compounds, etc.",
            "Country of origin marking required",
        ],
        "typical_fees": "MFN tariff: 0–6.5% depending on product type",
        "source": "FDA MoCRA + CBP guidance",
    },
}


def cbp_get(endpoint, params):
    """Fetch from CBP Rulings API with retries."""
    url = f"{CBP_RULINGS_BASE}/{endpoint}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_cbp_data] CBP API failed {endpoint}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_rulings(args):
    """Fetch CBP binding tariff classification rulings."""
    params = {
        "term":   args.query or args.hts_code,
        "format": "json",
    }

    data = cbp_get("search", params)

    if not data:
        return {
            "source": "CBP CROSS (Customs Rulings Online Search System)",
            "hts_code": args.hts_code,
            "records": [],
            "note": (
                "CBP Rulings API unavailable. Search manually at rulings.cbp.gov. "
                "Rulings are legally binding CBP classification decisions."
            ),
        }

    rulings = data.get("rulings", data.get("results", []))
    records = [
        {
            "ruling_number": r.get("ruling_number"),
            "date":          r.get("issue_date"),
            "subject":       r.get("subject"),
            "tariff_number": r.get("tariff_number"),
            "description":   r.get("description"),
            "url":           f"https://rulings.cbp.gov/ruling/{r.get('ruling_number')}",
        }
        for r in rulings[:15]
    ]

    return {
        "source": "CBP CROSS (Customs Rulings Online Search System) — free, no key required",
        "hts_code": args.hts_code,
        "query": args.query,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "CBP binding rulings represent official tariff classification decisions. "
            "They are legally binding on CBP for the product described. "
            "Search full database at rulings.cbp.gov."
        ),
    }


def cmd_requirements(args):
    """Return import requirements for a product category."""
    product = args.product.lower().replace(" ", "_").replace("-", "_")

    # Try exact match then partial
    req = IMPORT_REQUIREMENTS.get(product)
    if not req:
        for key, val in IMPORT_REQUIREMENTS.items():
            if key in product or product in key:
                req = val
                product = key
                break

    if not req:
        return {
            "source": "CBP Import Requirements Reference",
            "product": args.product,
            "records": [],
            "available_categories": list(IMPORT_REQUIREMENTS.keys()),
            "note": (
                f"No pre-loaded requirements for '{args.product}'. "
                "See cbp.gov/trade/basic-import-export for official guidance."
            ),
        }

    # Add country-specific context if origin provided
    origin_note = None
    if args.origin:
        country = args.origin.lower()
        if country in ("china", "cn"):
            origin_note = (
                "CHINA-SPECIFIC: Check Section 301 tariffs (additional 7.5–25% depending on HTS). "
                "Many categories have additional tariffs. Check USTR Section 301 exclusion list."
            )
        elif country in ("somalia", "so", "kenya", "ethiopia"):
            origin_note = (
                "AFRICA (Sub-Saharan): Check AGOA eligibility — qualifying countries get duty-free access "
                "for most products. Somalia's AGOA eligibility should be verified at agoa.info."
            )
        elif country in ("canada", "mexico"):
            origin_note = "USMCA country: Most products qualify for preferential (zero or reduced) tariff rates."

    records = [{"requirement": r} for r in req.get("requirements", [])]

    return {
        "source": "CBP Import Requirements Reference (compiled from cbp.gov, FDA, USDA guidance)",
        "product_category": product,
        "origin_country": args.origin,
        "regulatory_agencies": req.get("agencies", []),
        "requirements": req.get("requirements", []),
        "restricted_categories": req.get("restricted_categories", []),
        "typical_tariff_fees": req.get("typical_fees"),
        "origin_specific_note": origin_note,
        "records": records,
        "data_notes": "Reference data — verify current requirements at cbp.gov before import.",
    }


def cmd_hts_lookup(args):
    """Search HTS code descriptions to find the right tariff classification."""
    params = {
        "query": args.keyword,
    }

    data = None
    try:
        resp = httpx.get(f"{HTS_BASE}/search", params=params, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
    except Exception as e:
        print(f"[fetch_cbp_data] HTS search failed: {e}", file=sys.stderr)

    if not data:
        # Return static common codes as fallback
        common_codes = {
            "dairy / milk": "Chapter 04 (04.01–04.06)",
            "camel milk / specialty milk": "0403.90.16 or 0403.90.45",
            "milk powder": "0402.10 (skimmed) / 0402.21 (full fat)",
            "furniture": "Chapter 94 (9401–9403)",
            "kitchen tools": "8211–8215 (cutlery) or 7323 (kitchen/household articles of iron)",
            "electronics": "Chapter 84/85",
            "apparel / clothing": "Chapters 61–62",
            "medical devices": "Chapter 90",
            "cosmetics": "3303–3307",
        }
        return {
            "source": "HTS Reference Data (USITC) — free, no key required",
            "keyword": args.keyword,
            "records": [{"keyword": k, "hts_range": v} for k, v in common_codes.items()],
            "note": (
                "HTS API search unavailable. Common HTS ranges shown above. "
                "Full HTS search at hts.usitc.gov or schedule.usa.gov."
            ),
        }

    records = [
        {
            "hts_code":    item.get("htsno"),
            "description": item.get("description"),
            "general_rate": item.get("general"),
            "indent":      item.get("indent"),
        }
        for item in (data if isinstance(data, list) else data.get("results", []))[:20]
    ]

    return {
        "source": "USITC Harmonized Tariff Schedule — free, no key required",
        "keyword": args.keyword,
        "records": records,
        "total_returned": len(records),
        "data_notes": "Full HTS schedule at hts.usitc.gov. General rate = MFN tariff for most countries.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch CBP import requirements and tariff rulings")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_rul = subparsers.add_parser("rulings", help="CBP binding tariff classification rulings")
    p_rul.add_argument("hts_code", help="HTS code to look up rulings for (e.g. '0403.90')")
    p_rul.add_argument("--query", help="Additional keyword to filter rulings (e.g. 'camel milk')")
    p_rul.set_defaults(func=cmd_rulings)

    p_req = subparsers.add_parser("requirements", help="Import requirements for a product category")
    p_req.add_argument("product", help="Product category: food, furniture, electronics, apparel, medical_device, cosmetics")
    p_req.add_argument("--origin", help="Country of origin for country-specific notes (e.g. 'China', 'Somalia')")
    p_req.set_defaults(func=cmd_requirements)

    p_hts = subparsers.add_parser("hts_lookup", help="Search HTS codes by product keyword")
    p_hts.add_argument("keyword", help="Product keyword to find HTS code (e.g. 'camel milk', 'modular kitchen')")
    p_hts.set_defaults(func=cmd_hts_lookup)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
