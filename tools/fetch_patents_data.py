"""
fetch_patents_data.py — USPTO Patents (PatentsView) + Trademarks
Fetches patent filings and trademark registrations from USPTO free APIs.
No API key required.
Commands:
  patents     <query>  [--limit N]  — search USPTO patents via PatentsView API
  trademarks  <query>  [--limit N]  — search USPTO trademark registrations
  landscape   <term>               — technology/IP landscape summary for a product/industry
"""

import argparse
import json
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

PATENTS_BASE    = "https://api.patentsview.org/patents/query"
TRADEMARKS_BASE = "https://developer.uspto.gov/ibd-api/v1/application/searchUSPTO"
MAX_RETRIES     = 3


def pv_get(payload):
    """POST to PatentsView API with retries."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.post(PATENTS_BASE, json=payload, timeout=25,
                              headers={"Content-Type": "application/json"})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_patents_data] PatentsView failed: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def tm_get(params):
    """GET to USPTO Trademark API with retries."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(TRADEMARKS_BASE, params=params, timeout=20)
            if resp.status_code == 404:
                return {"body": {"docs": []}}
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_patents_data] USPTO TM failed: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_patents(args):
    """Search USPTO patents via PatentsView API."""
    payload = {
        "q": {"_text_any": {"patent_title": args.query, "patent_abstract": args.query}},
        "f": [
            "patent_number", "patent_title", "patent_date", "patent_type",
            "assignee_organization", "inventor_last_name",
            "cpc_section_id", "cpc_group_id",
        ],
        "o": {"sort": [{"patent_date": "desc"}]},
        "s": [{"patent_date": "desc"}],
        "per_page": min(args.limit, 25),
    }

    data = pv_get(payload)
    if not data:
        return {"_tool_error": True,
                "reason": "PatentsView API unavailable — verify manually at patentsview.org",
                "records": [], "source": "PatentsView (USPTO)"}

    patents = data.get("patents", [])
    total = data.get("total_patent_count", len(patents))

    records = [
        {
            "patent_number":  p.get("patent_number"),
            "title":          p.get("patent_title"),
            "date":           p.get("patent_date"),
            "type":           p.get("patent_type"),
            "assignee":       p.get("assignees", [{}])[0].get("assignee_organization") if p.get("assignees") else None,
            "inventor":       p.get("inventors", [{}])[0].get("inventor_last_name") if p.get("inventors") else None,
            "cpc_class":      p.get("cpcs", [{}])[0].get("cpc_group_id") if p.get("cpcs") else None,
            "url":            f"https://patents.google.com/patent/US{p.get('patent_number')}",
        }
        for p in patents
    ]

    return {
        "source": "PatentsView API (USPTO) — free, no key required",
        "query": args.query,
        "total_available": total,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "US patents only. For global patents, see espacenet.epo.org or patentscope.wipo.int. "
            "CPC class codes: A = human necessities/food, B = performing operations, "
            "C = chemistry/metallurgy, G = physics, H = electricity."
        ),
    }


def cmd_trademarks(args):
    """Search USPTO trademark registrations."""
    params = {
        "searchText": args.query,
        "rows":       min(args.limit, 25),
        "start":      0,
    }

    data = tm_get(params)

    if not data:
        return {
            "_tool_error": True,
            "reason": "USPTO Trademark API unavailable — verify manually at tmsearch.uspto.gov",
            "records": [], "source": "USPTO Trademark Database",
        }

    docs = data.get("body", {}).get("docs", [])
    total = data.get("body", {}).get("numFound", len(docs))

    records = [
        {
            "serial_number":    d.get("serialNumber"),
            "registration_number": d.get("registrationNumber"),
            "mark":             d.get("markIdentification"),
            "owner":            d.get("ownerName"),
            "filing_date":      d.get("filingDate"),
            "registration_date": d.get("registrationDate"),
            "status":           d.get("statusCode"),
            "status_description": d.get("statusDescription"),
            "goods_services":   d.get("goodsAndServices", "")[:200],
            "class":            d.get("intClassNumber"),
        }
        for d in docs
    ]

    return {
        "source": "USPTO Trademark Database — free, no key required",
        "query": args.query,
        "total_available": total,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "US trademark registrations and applications. "
            "Status codes: 710 = registered (live), 800-series = cancelled/expired. "
            "Use to check if a brand name or product name is trademarked before launch. "
            "For international trademarks: wipo.int/branddb."
        ),
    }


def cmd_landscape(args):
    """Provide IP landscape summary for a product or technology area."""
    term = args.term

    # Search patents and trademarks in parallel approach (sequential here)
    patent_payload = {
        "q": {"_text_any": {"patent_title": term}},
        "f": ["patent_number", "patent_date", "patent_type", "assignee_organization", "cpc_group_id"],
        "s": [{"patent_date": "desc"}],
        "per_page": 10,
    }
    patent_data = pv_get(patent_payload)
    time.sleep(0.5)

    tm_data = tm_get({"searchText": term, "rows": 10})

    patent_count = patent_data.get("total_patent_count", 0) if patent_data else 0
    patents      = patent_data.get("patents", []) if patent_data else []
    tm_count     = tm_data.get("body", {}).get("numFound", 0) if tm_data else 0
    trademarks   = tm_data.get("body", {}).get("docs", []) if tm_data else []

    # Surface tool failures explicitly so agents note unavailability rather than assuming no IP exists
    api_errors = []
    if not patent_data:
        api_errors.append("PatentsView unavailable — patent count may be incomplete")
    if not tm_data:
        api_errors.append("USPTO Trademark API unavailable — trademark check should be done manually at tmsearch.uspto.gov")

    # Find top assignees (companies with most patents)
    assignee_counts = {}
    for p in patents:
        for a in p.get("assignees", []):
            org = a.get("assignee_organization")
            if org:
                assignee_counts[org] = assignee_counts.get(org, 0) + 1
    top_assignees = sorted(assignee_counts.items(), key=lambda x: x[1], reverse=True)[:5]

    result = {
        "source": "PatentsView + USPTO Trademarks (free, no key required)",
        "term": term,
        "ip_landscape": {
            "total_us_patents": patent_count,
            "total_us_trademarks": tm_count,
            "top_patent_holders": [{"company": a, "patent_count": c} for a, c in top_assignees],
            "recent_patents": [
                {"title": p.get("patent_title"), "date": p.get("patent_date"),
                 "assignee": p.get("assignees", [{}])[0].get("assignee_organization") if p.get("assignees") else None}
                for p in patents[:5]
            ],
            "sample_trademarks": [
                {"mark": t.get("markIdentification"), "owner": t.get("ownerName"),
                 "status": t.get("statusDescription")}
                for t in trademarks[:5]
            ],
        },
        "records": [
            {"type": "patent_count", "value": patent_count},
            {"type": "trademark_count", "value": tm_count},
        ] + [{"type": "top_assignee", "company": a, "count": c} for a, c in top_assignees],
        "data_notes": (
            f"IP landscape for '{term}'. "
            "High patent count = crowded technology space with IP risk. "
            "Few patents = open innovation opportunity or nascent market. "
            "Trademark conflicts: check 'live' trademarks — expired/cancelled marks can often be used."
        ),
    }
    if api_errors:
        result["_tool_error"] = True
        result["reason"] = "; ".join(api_errors)
    return result


def main():
    parser = argparse.ArgumentParser(description="Fetch USPTO patent and trademark data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_pat = subparsers.add_parser("patents", help="Search US patents via PatentsView")
    p_pat.add_argument("query", help='Technology or product keyword (e.g. "camel milk processing", "modular kitchen")')
    p_pat.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    p_pat.set_defaults(func=cmd_patents)

    p_tm = subparsers.add_parser("trademarks", help="Search US trademark registrations")
    p_tm.add_argument("query", help='Brand name, product name, or keyword to check for conflicts')
    p_tm.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    p_tm.set_defaults(func=cmd_trademarks)

    p_ls = subparsers.add_parser("landscape", help="IP landscape summary for a product/technology area")
    p_ls.add_argument("term", help='Product or technology term (e.g. "camel milk", "modular furniture")')
    p_ls.set_defaults(func=cmd_landscape)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
