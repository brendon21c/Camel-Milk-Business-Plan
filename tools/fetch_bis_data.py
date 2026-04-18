"""
fetch_bis_data.py — BIS (Bureau of Industry and Security) Export Controls
Fetches export control classifications, restricted party lists, and export licensing guidance.
No API key required — uses Federal Register API and BIS public reference data.
Commands:
  search     <keyword>           — search BIS export control notices via Federal Register
  eccn       <product_type>      — look up Export Control Classification Number guidance
  screening  <party_name>       — basic restricted party screening context
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

FEDERAL_REGISTER_BASE = "https://www.federalregister.gov/api/v1"
BIS_AGENCY_ID         = "14"   # BIS Federal Register agency ID
MAX_RETRIES           = 3

# ECCN reference data — compiled from BIS Commerce Control List (CCL)
# https://www.bis.doc.gov/index.php/regulations/commerce-control-list-ccl
ECCN_REFERENCE = {
    "food": {
        "eccn": "EAR99",
        "notes": (
            "Most food products are classified EAR99 — subject to Export Administration Regulations "
            "but no specific ECCN. EAR99 items can be exported to most countries without a license, "
            "except to embargoed destinations (Cuba, Iran, North Korea, Syria, Russia-related sanctions)."
        ),
        "license_exception": "Most transactions — License Exception GBS or no license required",
        "key_controls": "Destination/end-user screening required. Embargoed countries require BIS license.",
    },
    "electronics": {
        "eccn": "Varies — 3A001 to 3E001 range",
        "notes": (
            "Electronics ECCNs depend on specifications: processing speed, encryption capability, "
            "frequency ranges, and power output. Consumer electronics often qualify as EAR99 or 5A992. "
            "Encryption controls (Category 5 Part 2) are critical — mass-market encryption products "
            "may qualify for License Exception ENC."
        ),
        "high_risk_triggers": [
            "Processing speed > 64 GFLOPS — may trigger 3A001.a",
            "Encryption > 56-bit key length — Category 5 Part 2 review required",
            "RF amplifiers > specified power — Category 3 controls may apply",
            "Night vision or thermal imaging — USML/CCL boundary review needed",
        ],
        "license_exception": "ENC for many encryption products; EAR99 for basic consumer electronics",
    },
    "industrial_machinery": {
        "eccn": "EAR99 (most) or 2B001/2B002 range for precision equipment",
        "notes": (
            "General industrial machinery is usually EAR99. Precision machine tools (tolerances <0.001mm), "
            "isostatic presses, and equipment with controlled capabilities may have specific ECCNs. "
            "Check CCL Categories 1-4 for manufacturing equipment."
        ),
        "license_exception": "Usually EAR99 — license generally not required",
        "key_controls": "End-use/end-user screening. WMD-related end uses trigger license requirements regardless of ECCN.",
    },
    "software": {
        "eccn": "EAR99 or 5D002 (encryption software)",
        "notes": (
            "Most commercial software is EAR99. Software with encryption functionality is Category 5 Part 2 "
            "(5D002). Mass-market software with encryption may qualify for License Exception ENC. "
            "Source code for encryption algorithms: 5E002."
        ),
        "license_exception": "License Exception ENC widely available for commercial encryption software",
        "key_controls": "Destination/end-user screening. Russia/Belarus comprehensive controls in force.",
    },
    "chemicals": {
        "eccn": "Varies — 1C350 (precursors), 1C011, 1C240 range",
        "notes": (
            "Chemical export controls cover precursors to chemical weapons (Australia Group), "
            "energetic materials, and industrial chemicals with WMD potential. Most commercial "
            "chemicals are EAR99 unless they appear on the CCL or Chemical Weapons Convention schedules."
        ),
        "high_risk_triggers": [
            "Schedule 1/2/3 chemicals under CWC",
            "Australia Group Common Control List precursors",
            "Controlled pathogens or toxins (USML Category XIV)",
        ],
        "license_exception": "Depends heavily on specific chemical — verify against CCL 1C350 list",
    },
    "medical_devices": {
        "eccn": "EAR99 (most) or specific ECCN for advanced medical technology",
        "notes": (
            "Most medical devices are EAR99. Advanced medical imaging, lasers, and certain biological "
            "equipment may have specific ECCNs. USML (State Dept ITAR) controls apply to some military-capable "
            "medical systems. Embargo destination controls apply regardless of ECCN."
        ),
        "license_exception": "EAR99 — generally no license required except to embargoed destinations",
    },
    "firearms_defense": {
        "eccn": "USML (State Dept ITAR) — NOT covered by BIS CCL",
        "notes": (
            "Firearms, ammunition, and military equipment are controlled under USML (ITAR), not BIS CCL. "
            "Do not use BIS ECCN process for ITAR-controlled items — requires State Dept license."
        ),
    },
}

# Commonly embargoed/restricted destinations (as of 2024)
EMBARGOED_DESTINATIONS = {
    "cuba":        "Comprehensive embargo — almost all exports require license",
    "iran":        "Comprehensive sanctions — almost all exports require license",
    "north korea": "Comprehensive embargo — virtually no exports permitted",
    "syria":       "Comprehensive embargo — BIS license required for most items",
    "russia":      "Expanded controls post-2022 — most items require license; many denials",
    "belarus":     "Expanded controls post-2022 — aligns with Russia restrictions",
    "venezuela":   "Targeted controls — arms embargo and some dual-use restrictions",
    "myanmar":     "Targeted controls — arms embargo",
    "china":       "Enhanced End-User Review — not embargoed but Entity List screening critical",
}


def fr_get(endpoint, params):
    """Fetch from Federal Register API with retries."""
    url = f"{FEDERAL_REGISTER_BASE}/{endpoint}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_bis_data] FR API failed: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_search(args):
    """Search BIS export control notices and rules via Federal Register."""
    params = {
        "conditions[agencies][]": "industry-and-security-bureau",
        "conditions[type][]":     ["Rule", "Proposed Rule", "Notice"],
        "per_page":               20,
        "fields[]":               ["title", "document_number", "publication_date", "abstract", "html_url", "type"],
        "order":                  "relevance",
    }
    if args.keyword:
        params["conditions[term]"] = args.keyword

    data = fr_get("documents.json", params)
    if not data:
        return {"source": "Federal Register — BIS Notices", "records": [],
                "error": "Federal Register API unavailable."}

    docs = data.get("results", [])
    records = [
        {
            "title":    d.get("title"),
            "type":     d.get("type"),
            "date":     d.get("publication_date"),
            "abstract": d.get("abstract"),
            "url":      d.get("html_url"),
        }
        for d in docs
    ]

    return {
        "source": "Federal Register — BIS (Bureau of Industry and Security) — free, no key required",
        "keyword": args.keyword,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "BIS publishes export control updates, Entity List additions, and EAR amendments "
            "in the Federal Register. Full CCL at bis.doc.gov/ccl."
        ),
    }


def cmd_eccn(args):
    """Look up ECCN guidance for a product type."""
    product = args.product_type.lower().replace(" ", "_").replace("-", "_")

    eccn = ECCN_REFERENCE.get(product)
    if not eccn:
        for key, val in ECCN_REFERENCE.items():
            if key in product or product in key:
                eccn = val
                product = key
                break

    if not eccn:
        return {
            "source": "BIS Commerce Control List Reference",
            "product_type": args.product_type,
            "records": [],
            "available_categories": list(ECCN_REFERENCE.keys()),
            "note": (
                f"No pre-loaded ECCN guidance for '{args.product_type}'. "
                "Use BIS SNAP-R or the CCL Product Search at bis.doc.gov to determine ECCN."
            ),
        }

    records = [{"product": product, "eccn": eccn.get("eccn"), "notes": eccn.get("notes")}]

    return {
        "source": "BIS Commerce Control List (CCL) Reference — free, no key required",
        "product_type": product,
        "eccn": eccn.get("eccn"),
        "notes": eccn.get("notes"),
        "license_exception": eccn.get("license_exception"),
        "high_risk_triggers": eccn.get("high_risk_triggers", []),
        "key_controls": eccn.get("key_controls"),
        "records": records,
        "data_notes": (
            "Reference data only — authoritative classification requires BIS Commodity Classification "
            "or consultation with export counsel. Full CCL at bis.doc.gov/ccl."
        ),
    }


def cmd_screening(args):
    """Provide restricted party screening context for a destination/party."""
    party = args.party_name.lower()

    embargo_info = None
    for country, details in EMBARGOED_DESTINATIONS.items():
        if country in party or party in country:
            embargo_info = {"country": country, "status": details}
            break

    screening_tools = [
        {
            "tool": "BIS Consolidated Screening List (CSL)",
            "url": "https://www.trade.gov/consolidated-screening-list",
            "description": "Free API covering BIS Entity List, SDN, OFAC, State Dept Debarred — single query",
        },
        {
            "tool": "OFAC SDN List",
            "url": "https://sanctionssearch.ofac.treas.gov/",
            "description": "Treasury sanctions — individuals, entities, vessels",
        },
        {
            "tool": "BIS Entity List",
            "url": "https://www.bis.doc.gov/index.php/policy-guidance/lists-of-parties-of-concern/entity-list",
            "description": "Entities requiring license for most US exports",
        },
    ]

    return {
        "source": "BIS Export Controls Reference — free, no key required",
        "party_queried": args.party_name,
        "embargo_status": embargo_info,
        "screening_tools": screening_tools,
        "records": [{"tool": t["tool"], "url": t["url"]} for t in screening_tools],
        "critical_note": (
            "All exporters must screen parties against the Consolidated Screening List before export. "
            "This tool provides context only — use the official CSL API at trade.gov for actual screening."
        ),
        "csl_api": "https://api.trade.gov/apps/developer/io/admin/login (free API key required for CSL)",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch BIS export control classifications and notices")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_search = subparsers.add_parser("search", help="Search BIS Federal Register notices")
    p_search.add_argument("keyword", help="Keyword (e.g. 'Entity List', 'semiconductors', 'Russia export controls')")
    p_search.set_defaults(func=cmd_search)

    p_eccn = subparsers.add_parser("eccn", help="ECCN classification guidance for a product type")
    p_eccn.add_argument("product_type", help="Product type: food, electronics, industrial_machinery, software, chemicals, medical_devices")
    p_eccn.set_defaults(func=cmd_eccn)

    p_screen = subparsers.add_parser("screening", help="Restricted party screening context")
    p_screen.add_argument("party_name", help="Country or party name to screen (e.g. 'China', 'Iran', 'Somalia')")
    p_screen.set_defaults(func=cmd_screening)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
