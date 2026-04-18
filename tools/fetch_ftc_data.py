"""
fetch_ftc_data.py — FTC (Federal Trade Commission) Rules & Enforcement
Fetches FTC labelling rules, enforcement cases, and marketing claim guidance.
No API key required — uses Federal Register API and FTC public data.
Commands:
  rules    [--query QUERY]   — search FTC regulations and rules via Federal Register
  cases    [--query QUERY] [--limit N]  — FTC enforcement actions and consent orders
  guidance <topic>           — pre-loaded FTC claim guidance for common product categories
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

FEDERAL_REGISTER_BASE = "https://www.federalregister.gov/api/v1"
FTC_AGENCY_ID         = "258"   # FTC's Federal Register agency ID
MAX_RETRIES           = 3

# Pre-loaded FTC guidance for product marketing claims (from official FTC publications)
FTC_GUIDANCE = {
    "health_claims": {
        "summary": "FTC Act Section 5 prohibits deceptive health claims. All claims must be truthful, substantiated, and non-misleading.",
        "rules": [
            "Health claims must be supported by competent and reliable scientific evidence",
            "Qualified health claims must include FDA-required disclaimers",
            "Structure/function claims (e.g. 'supports immune health') must be truthful and not imply disease treatment",
            "Testimonials must reflect honest opinions and cannot be used if not representative of typical results",
            "Before-and-after comparisons must reflect typical results; atypical results require clear disclosure",
        ],
        "key_documents": [
            ".com Disclosures — How to Make Effective Disclosures in Digital Advertising (2013)",
            "Dietary Supplements: An Advertising Guide for Industry (FTC)",
            "Guides Concerning the Use of Endorsements and Testimonials in Advertising (16 CFR Part 255)",
        ],
        "source": "FTC.gov — Advertising and Marketing section",
    },
    "food_labelling": {
        "summary": "FTC regulates food advertising claims. FDA regulates label content. Both agencies coordinate on food marketing.",
        "rules": [
            "FTC has primary authority over food advertising (what you say in ads)",
            "FDA has primary authority over label content (what appears on the package)",
            "Claims in ads must match and be consistent with label claims",
            "'Natural' claims: FTC and FDA both scrutinize — no formal FTC definition but must not deceive",
            "'Organic' claims: USDA organic certification required for use of 'USDA Organic' seal",
            "Country-of-origin claims must be accurate and not misleading",
        ],
        "source": "FTC.gov + FDA coordination guidance",
    },
    "green_environmental": {
        "summary": "FTC Green Guides (16 CFR Part 260) govern environmental marketing claims.",
        "rules": [
            "Claims like 'eco-friendly', 'sustainable', 'green' must be substantiated and not overly broad",
            "'Recyclable' claims require that recycling facilities are accessible to a significant majority of consumers",
            "'Biodegradable' claims require that products will completely decompose within one year after disposal",
            "Carbon offset claims must be truthful, substantiated, and not double-counted",
            "Certifications and seals of approval must clearly convey the basis for the endorsement",
        ],
        "cfr_reference": "16 CFR Part 260",
        "source": "FTC Green Guides (most recent update: 2012; 2023 update proposed)",
    },
    "made_in_usa": {
        "summary": "FTC 'Made in USA' standard: 'all or virtually all' of product must be made in the US.",
        "rules": [
            "Unqualified 'Made in USA' = all or virtually all ingredients/components domestic",
            "Qualified claim required if significant foreign content: e.g. 'Made in USA from domestic and imported parts'",
            "Applies to all marketing, advertising, and labelling",
            "FTC actively enforces — civil penalties up to $51,744 per violation",
        ],
        "cfr_reference": "16 CFR Part 323",
        "source": "FTC Made in USA Rule (effective 2022)",
    },
    "textile_labelling": {
        "summary": "FTC Textile Products Identification Act requires fibre content, country of origin, and manufacturer disclosure.",
        "rules": [
            "All textile products must disclose fibre content by generic name and percentage",
            "Country of origin must appear on label",
            "RN (Registered Number) or WPL number must identify manufacturer or importer",
            "Care instructions required under Permanent Care Labeling Rule (16 CFR Part 423)",
        ],
        "cfr_reference": "16 CFR Parts 300–303 (Textile), 16 CFR Part 423 (Care Labeling)",
        "source": "FTC Textile and Apparel Labeling",
    },
    "endorsements": {
        "summary": "FTC Guides on Endorsements require disclosure of material connections between endorsers and brands.",
        "rules": [
            "Paid influencers/reviewers must clearly disclose the relationship (#ad, #sponsored, etc.)",
            "Employees posting about products must disclose their employment",
            "Free product recipients must disclose when reviewing",
            "Disclosures must be clear and conspicuous — not buried in hashtags or footnotes",
            "Applies to social media, blogs, YouTube, podcasts, and all digital platforms",
        ],
        "cfr_reference": "16 CFR Part 255",
        "source": "FTC Guides Concerning Endorsements and Testimonials (updated 2023)",
    },
    "pricing": {
        "summary": "FTC guides on price advertising require that comparison prices are genuine.",
        "rules": [
            "Former price comparisons ('was $X, now $Y') must reflect the actual former price at which product was sold",
            "'Suggested retail price' comparisons must reflect actual list prices in the market",
            "Free product claims must not have hidden conditions that effectively charge for the 'free' item",
        ],
        "source": "FTC Guides Against Deceptive Pricing (16 CFR Part 233)",
    },
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
                print(f"[fetch_ftc_data] FR API failed {endpoint}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_rules(args):
    """Search FTC regulations and rules via Federal Register."""
    params = {
        "conditions[agencies][]": "federal-trade-commission",
        "conditions[type][]":     ["Rule", "Proposed Rule", "Notice"],
        "per_page":               20,
        "fields[]":               ["title", "document_number", "publication_date",
                                   "abstract", "citation", "html_url", "type"],
        "order":                  "relevance",
    }
    if args.query:
        params["conditions[term]"] = args.query

    data = fr_get("documents.json", params)
    if not data:
        return {"source": "Federal Register — FTC Rules", "records": [],
                "error": "Federal Register API unavailable."}

    docs = data.get("results", [])
    records = [
        {
            "title":         d.get("title"),
            "type":          d.get("type"),
            "date":          d.get("publication_date"),
            "citation":      d.get("citation"),
            "document_number": d.get("document_number"),
            "abstract":      d.get("abstract"),
            "url":           d.get("html_url"),
        }
        for d in docs
    ]

    return {
        "source": "Federal Register — FTC Rules & Regulations (free, no key required)",
        "query": args.query,
        "records": records,
        "total_returned": len(records),
        "data_notes": "Federal Register official FTC rulemaking. Includes proposed and final rules.",
    }


def cmd_cases(args):
    """Fetch FTC enforcement cases and press releases via Federal Register notices."""
    params = {
        "conditions[agencies][]": "federal-trade-commission",
        "conditions[type][]":     "Notice",
        "per_page":               min(args.limit, 25),
        "fields[]":               ["title", "publication_date", "abstract", "html_url"],
        "order":                  "newest",
    }
    if args.query:
        params["conditions[term]"] = args.query

    data = fr_get("documents.json", params)
    if not data:
        return {"source": "FTC Enforcement Actions", "records": [],
                "error": "Federal Register API unavailable."}

    docs = data.get("results", [])
    records = [
        {
            "title": d.get("title"),
            "date":  d.get("publication_date"),
            "abstract": d.get("abstract"),
            "url":   d.get("html_url"),
        }
        for d in docs
    ]

    return {
        "source": "Federal Register — FTC Notices & Enforcement (free, no key required)",
        "query": args.query,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "FTC consent orders and enforcement actions appear as Federal Register Notices. "
            "For full case database see ftc.gov/enforcement/cases-proceedings."
        ),
    }


def cmd_guidance(args):
    """Return pre-loaded FTC marketing claim guidance for a topic."""
    topic = args.topic.lower().replace(" ", "_").replace("-", "_")

    # Try exact match
    guidance = FTC_GUIDANCE.get(topic)

    # Try partial match
    if not guidance:
        for key, val in FTC_GUIDANCE.items():
            if key in topic or topic in key:
                guidance = val
                topic = key
                break

    if not guidance:
        return {
            "source": "FTC Guidance Reference",
            "topic": args.topic,
            "records": [],
            "available_topics": list(FTC_GUIDANCE.keys()),
            "note": (
                f"No pre-loaded guidance for '{args.topic}'. "
                "See ftc.gov/tips-advice/business-center/advertising-and-marketing for full guidance library."
            ),
        }

    records = [{"rule": r} for r in guidance.get("rules", [])]

    return {
        "source": "FTC Guidance Reference (compiled from ftc.gov official publications)",
        "topic": topic,
        "summary": guidance.get("summary"),
        "rules": guidance.get("rules", []),
        "cfr_reference": guidance.get("cfr_reference"),
        "key_documents": guidance.get("key_documents", []),
        "records": records,
        "data_notes": "Guidance reflects published FTC rules. Verify current status at ftc.gov.",
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch FTC labelling rules and enforcement data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_rules = subparsers.add_parser("rules", help="Search FTC regulations via Federal Register")
    p_rules.add_argument("--query", help="Search term (e.g. 'labeling', 'health claims', 'textile')")
    p_rules.set_defaults(func=cmd_rules)

    p_cases = subparsers.add_parser("cases", help="Search FTC enforcement actions via Federal Register")
    p_cases.add_argument("--query", help="Search term (e.g. 'food advertising', 'influencer', 'made in USA')")
    p_cases.add_argument("--limit", type=int, default=15, help="Max results (default 15)")
    p_cases.set_defaults(func=cmd_cases)

    p_guid = subparsers.add_parser("guidance", help="Pre-loaded FTC marketing claim guidance by topic")
    p_guid.add_argument("topic", help=(
        "Topic: health_claims, food_labelling, green_environmental, made_in_usa, "
        "textile_labelling, endorsements, pricing"
    ))
    p_guid.set_defaults(func=cmd_guidance)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
