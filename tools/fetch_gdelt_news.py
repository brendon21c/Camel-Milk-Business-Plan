"""
fetch_gdelt_news.py — GDELT Project API v2
Searches global news across 170+ countries, 65+ languages, updated every 15 minutes.
No API key required. No rate limits documented.
Commands:
  search   <query>  [--country COUNTRY] [--limit N]  — search news articles by keyword
  timeline <query>  [--country COUNTRY]               — event volume over time (trend signal)
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://api.gdeltproject.org/api/v2"
MAX_RETRIES = 3

# GDELT country codes (FIPS-style, 2-letter uppercase)
# GDELT uses FIPS 10-4 country codes, not ISO-2 in all cases
GDELT_COUNTRIES = {
    "us": "US", "usa": "US", "united states": "US",
    "somalia": "SO", "so": "SO",
    "kenya": "KE", "ethiopia": "ET",
    "china": "CH", "cn": "CH",
    "india": "IN",
    "germany": "GM", "de": "GM",
    "france": "FR", "fr": "FR",
    "uk": "UK", "gb": "UK",
    "uae": "AE", "saudi arabia": "SA",
    "australia": "AS", "au": "AS",
    "canada": "CA",
    "brazil": "BR",
    "mexico": "MX",
    "japan": "JA", "jp": "JA",
    "south korea": "KS", "kr": "KS",
    "nigeria": "NI",
    "south africa": "SF",
}


def build_query(query, country=None):
    """Build a GDELT query string with optional country filter."""
    q = query
    if country:
        code = GDELT_COUNTRIES.get(country.lower(), country.upper())
        q = f"{q} sourcecountry:{code}"
    return q


def gdelt_get(endpoint, params):
    """Make a GET to GDELT API with retries."""
    url = f"{BASE_URL}/{endpoint}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.get(url, params=params, timeout=20)
            resp.raise_for_status()
            # GDELT returns JSON or HTML depending on format param
            ct = resp.headers.get("content-type", "")
            if "json" in ct:
                return resp.json()
            # Some endpoints return newline-delimited JSON
            text = resp.text.strip()
            if text.startswith("{") or text.startswith("["):
                return json.loads(text)
            raise ValueError(f"Unexpected content-type: {ct}")
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            print(f"[fetch_gdelt_news] Retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def cmd_search(args):
    """Search GDELT for news articles matching a query."""
    query = build_query(args.query, args.country)
    limit = min(args.limit, 25)  # GDELT max is 250 but we keep context reasonable

    params = {
        "query":      query,
        "mode":       "artlist",
        "maxrecords": limit,
        "format":     "json",
        "sort":       "DateDesc",
    }

    try:
        data = gdelt_get("doc/doc", params)
    except Exception as e:
        return {"error": f"GDELT search failed: {e}", "records": [],
                "source": "GDELT Project",
                "query_used": query}

    articles = data.get("articles", [])

    records = [
        {
            "title":       a.get("title"),
            "url":         a.get("url"),
            "source":      a.get("domain"),
            "date":        a.get("seendate"),
            "language":    a.get("language"),
            "country":     a.get("sourcecountry"),
            "sentiment":   a.get("tone"),  # Negative tone = more negative coverage
        }
        for a in articles
    ]

    return {
        "source": "GDELT Project v2 — global news, 170+ countries, 65+ languages (free, no key)",
        "query_used": query,
        "country_filter": args.country,
        "records": records,
        "total_returned": len(records),
        "data_notes": (
            "GDELT monitors 100,000+ news sources updated every 15 minutes. "
            "Tone is numeric: negative = more negative news coverage. "
            "Results sorted by most recent first."
        ),
    }


def cmd_timeline(args):
    """Fetch event volume trend for a query — shows whether news coverage is growing or shrinking."""
    query = build_query(args.query, args.country)

    params = {
        "query":  query,
        "mode":   "timelinevolnorm",  # Normalised volume — removes weekday/seasonal bias
        "format": "json",
    }

    try:
        data = gdelt_get("doc/doc", params)
    except Exception as e:
        return {"error": f"GDELT timeline failed: {e}", "records": [],
                "source": "GDELT Project", "query_used": query}

    timeline = data.get("timeline", [])
    if not timeline:
        # Try alternate response shape
        timeline = data.get("data", [])

    # Flatten the nested GDELT timeline structure
    records = []
    for series in timeline:
        for point in series.get("data", []):
            records.append({
                "date":   point.get("date"),
                "volume": point.get("value"),
            })

    # Sort by date ascending so trend direction is clear
    records.sort(key=lambda x: x.get("date", ""))

    return {
        "source": "GDELT Project v2 — event volume timeline (free, no key)",
        "query_used": query,
        "country_filter": args.country,
        "records": records,
        "data_notes": (
            "Normalised volume (0–100). Higher = more news coverage relative to global baseline. "
            "Use to spot whether interest in a topic is growing, shrinking, or spiking."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description="Search global news via GDELT Project")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_search = subparsers.add_parser("search", help="Search news articles by keyword")
    p_search.add_argument("query", help='Search query (e.g. "camel milk export" or "furniture tariff United States")')
    p_search.add_argument("--country", help="Filter by country (e.g. 'Somalia', 'US', 'Germany')")
    p_search.add_argument("--limit", type=int, default=10, help="Max results (default 10, max 25)")
    p_search.set_defaults(func=cmd_search)

    p_tl = subparsers.add_parser("timeline", help="Get news volume trend for a query topic")
    p_tl.add_argument("query", help="Topic to track over time")
    p_tl.add_argument("--country", help="Filter by country (optional)")
    p_tl.set_defaults(func=cmd_timeline)

    args = parser.parse_args()

    try:
        result = args.func(args)
    except Exception as e:
        result = {"error": str(e), "records": []}

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
