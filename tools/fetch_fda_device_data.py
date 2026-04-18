"""
fetch_fda_device_data.py — FDA Medical Device Data (openFDA)
Fetches 510(k) device clearances, PMA approvals, and device recalls.
Uses OPEN_FDA_API_KEY if available; operates at reduced rate without key.
Commands:
  clearances  <query>  [--limit N]  — FDA 510(k) premarket notifications (device clearances)
  pma         <query>  [--limit N]  — FDA PMA (premarket approval) for Class III devices
  recalls     <query>  [--limit N]  — FDA medical device recall enforcement reports
  events      <query>  [--limit N]  — adverse device events (MAUDE database)
"""

import argparse
import json
import os
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

OPEN_FDA_BASE = "https://api.fda.gov/device"
MAX_RETRIES   = 3
API_KEY       = os.getenv("OPEN_FDA_API_KEY", "")  # Optional — keyless gives 40 req/min


def fda_get(endpoint, params):
    """Fetch from openFDA device API with retries."""
    if API_KEY:
        params["api_key"] = API_KEY

    url = f"{OPEN_FDA_BASE}/{endpoint}.json"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            if resp.status_code == 429:
                # Rate limit — wait and retry
                print(f"[fetch_fda_device_data] Rate limited, waiting 5s...", file=sys.stderr)
                time.sleep(5)
                continue
            if resp.status_code == 404:
                return {"results": [], "meta": {"total": {"value": 0}}}
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"[fetch_fda_device_data] Failed {endpoint}: {e}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def cmd_clearances(args):
    """Fetch FDA 510(k) device clearances."""
    params = {
        "search": f'device_name:"{args.query}"',
        "limit":  min(args.limit, 100),
        "sort":   "decision_date:desc",
    }

    data = fda_get("510k", params)
    if not data:
        return {"source": "FDA openFDA 510(k) Database", "records": [],
                "error": "openFDA device API unavailable."}

    results = data.get("results", [])
    total = data.get("meta", {}).get("results", {}).get("total", len(results))

    records = [
        {
            "knumber":         r.get("k_number"),
            "decision_date":   r.get("decision_date"),
            "decision":        r.get("decision"),   # SESE = substantially equivalent
            "device_name":     r.get("device_name"),
            "applicant":       r.get("applicant"),
            "product_code":    r.get("product_code"),
            "device_class":    r.get("device_class"),
            "regulation_number": r.get("regulation_number"),
            "predicate_device": r.get("predicate_number"),
            "statement_or_summary": r.get("statement_or_summary"),
        }
        for r in results
    ]

    return {
        "source": "FDA openFDA 510(k) Premarket Notifications — free (keyless: 40 req/min)",
        "query": args.query,
        "total_available": total,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "510(k) = premarket notification pathway for Class II devices. "
            "SESE = Substantially Equivalent (cleared). "
            "Use to find predicate devices and understand clearance timeline for similar products."
        ),
    }


def cmd_pma(args):
    """Fetch FDA PMA (premarket approval) for Class III devices."""
    params = {
        "search": f'generic_name:"{args.query}"',
        "limit":  min(args.limit, 50),
        "sort":   "decision_date:desc",
    }

    data = fda_get("pma", params)
    if not data:
        return {"source": "FDA PMA Database", "records": [],
                "error": "openFDA PMA API unavailable."}

    results = data.get("results", [])

    records = [
        {
            "pma_number":      r.get("pma_number"),
            "decision_date":   r.get("decision_date"),
            "decision":        r.get("decision"),
            "device_name":     r.get("device_name"),
            "generic_name":    r.get("generic_name"),
            "applicant":       r.get("applicant"),
            "product_code":    r.get("product_code"),
            "advisory_committee": r.get("advisory_committee"),
        }
        for r in results
    ]

    return {
        "source": "FDA openFDA PMA Database — free (keyless: 40 req/min)",
        "query": args.query,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "PMA = Premarket Approval — required for Class III (high-risk) devices. "
            "More rigorous and expensive than 510(k). Average approval time 3–7 years. "
            "Use to understand high-risk device approval precedents."
        ),
    }


def cmd_recalls(args):
    """Fetch FDA medical device recall enforcement reports."""
    params = {
        "search": f'product_description:"{args.query}"',
        "limit":  min(args.limit, 50),
        "sort":   "recall_initiation_date:desc",
    }

    data = fda_get("recall", params)
    if not data:
        return {"source": "FDA Device Recall Database", "records": [],
                "error": "openFDA device recall API unavailable."}

    results = data.get("results", [])

    records = [
        {
            "recall_number":     r.get("recall_number"),
            "initiation_date":   r.get("recall_initiation_date"),
            "class":             r.get("recall_class"),  # Class I=most serious
            "device_name":       r.get("product_description"),
            "firm":              r.get("firm_name"),
            "reason":            r.get("reason_for_recall"),
            "action":            r.get("action"),
            "distribution_pattern": r.get("distribution_pattern"),
        }
        for r in results
    ]

    return {
        "source": "FDA openFDA Device Recall Database — free (keyless: 40 req/min)",
        "query": args.query,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "Class I = most serious (risk of serious injury/death). "
            "Class II = may cause temporary adverse health consequences. "
            "Class III = unlikely to cause adverse health consequences. "
            "Recall history is critical for regulatory risk assessment."
        ),
    }


def cmd_events(args):
    """Fetch FDA adverse device events from the MAUDE database."""
    params = {
        "search": f'device.generic_name:"{args.query}"',
        "limit":  min(args.limit, 25),
        "sort":   "date_received:desc",
    }

    data = fda_get("event", params)
    if not data:
        return {"source": "FDA MAUDE Adverse Events", "records": [],
                "error": "openFDA device event API unavailable."}

    results = data.get("results", [])
    total = data.get("meta", {}).get("results", {}).get("total", len(results))

    records = [
        {
            "date_received":  r.get("date_received"),
            "event_type":     r.get("event_type"),
            "device_name":    r.get("device", [{}])[0].get("generic_name") if r.get("device") else None,
            "manufacturer":   r.get("device", [{}])[0].get("manufacturer_d_name") if r.get("device") else None,
            "outcome":        [p.get("sequence_number_outcome") for p in r.get("patient", [])][:3],
            "narrative":      (r.get("mdr_text") or [{}])[0].get("text", "")[:300] if r.get("mdr_text") else None,
        }
        for r in results
    ]

    return {
        "source": "FDA MAUDE Adverse Event Database — free (keyless: 40 req/min)",
        "query": args.query,
        "total_available": total,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "MAUDE = Manufacturer and User Facility Device Experience. "
            "Events submitted by manufacturers, facilities, and voluntary reporters. "
            "Use to understand real-world safety performance of device categories."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch FDA medical device clearances and safety data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_cl = subparsers.add_parser("clearances", help="510(k) device clearances")
    p_cl.add_argument("query", help='Device name or type (e.g. "glucose monitor", "orthopedic implant")')
    p_cl.add_argument("--limit", type=int, default=15, help="Max results (default 15)")
    p_cl.set_defaults(func=cmd_clearances)

    p_pma = subparsers.add_parser("pma", help="PMA approvals for Class III devices")
    p_pma.add_argument("query", help='Device generic name (e.g. "cochlear implant", "artificial heart")')
    p_pma.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    p_pma.set_defaults(func=cmd_pma)

    p_rec = subparsers.add_parser("recalls", help="Medical device recall reports")
    p_rec.add_argument("query", help='Device type or product name (e.g. "insulin pump", "surgical stapler")')
    p_rec.add_argument("--limit", type=int, default=15, help="Max results (default 15)")
    p_rec.set_defaults(func=cmd_recalls)

    p_evt = subparsers.add_parser("events", help="Adverse device event reports (MAUDE)")
    p_evt.add_argument("query", help='Device generic name (e.g. "pacemaker", "blood pressure monitor")')
    p_evt.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    p_evt.set_defaults(func=cmd_events)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
