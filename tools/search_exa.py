#!/usr/bin/env python3
"""
Exa AI Semantic Search — finds conceptually related content, not just keyword matches.
Brave finds what you literally asked for. Exa understands meaning and surfaces
relevant pages even when exact keywords are absent. Use alongside Brave.

Search depth modes (use --type to select):
  instant        ~200ms  — fastest, surface-level results
  fast           ~450ms  — light semantic pass
  auto           ~1s     — default; Exa picks the right depth
  deep-lite      2–10s   — more thorough, good for niche topics
  deep           5–60s   — comprehensive; use for primary research questions
  deep-reasoning 10–60s  — Exa reasons about the query; use for complex questions
                           where framing matters (e.g. country risk, market structure)

Category filters (use --category to narrow domain):
  company | news | research paper | financial report | personal site | people

Commands:
  search  <query>  -- Semantic search with full text content
  similar <url>    -- Find pages semantically similar to a known good source
"""

import sys
import json
import os
import argparse
import httpx
import time
from dotenv import load_dotenv

load_dotenv()

EXA_API_KEY = os.getenv("EXA_API_KEY", "")
BASE_URL = "https://api.exa.ai"
MAX_RETRIES = 3

# Timeout scales with search depth — deep-reasoning can take up to 60s
TIMEOUT_BY_TYPE = {
    "instant":        20,
    "fast":           30,
    "auto":           45,
    "deep-lite":      60,
    "deep":           120,
    "deep-reasoning": 120,
}

VALID_TYPES = list(TIMEOUT_BY_TYPE.keys())

VALID_CATEGORIES = [
    "company",
    "news",
    "research paper",
    "financial report",
    "personal site",
    "people",
]


def search(
    query,
    num_results=5,
    search_type="deep",
    include_text=True,
    start_published_date=None,
    category=None,
    max_chars=5000,
):
    """
    Semantic search via Exa.
    Default type is 'deep' — comprehensive results worth the 5–60s wait for research use.
    Set category to narrow results to a specific content domain (company, news, etc.).
    Returns full article text per result (up to max_chars) plus highlight sentences.
    """
    if not EXA_API_KEY:
        return {
            "error": "EXA_API_KEY not set in .env — sign up at exa.ai",
            "records": [],
            "source": "Exa AI Semantic Search",
        }

    payload = {
        "query": query,
        "numResults": num_results,
        "type": search_type,
        "contents": {
            "highlights": {"numSentences": 3, "highlightsPerUrl": 2},
        },
    }
    if include_text:
        payload["contents"]["text"] = {"maxCharacters": max_chars}
    if start_published_date:
        payload["startPublishedDate"] = start_published_date
    if category:
        payload["category"] = category

    headers = {"x-api-key": EXA_API_KEY, "Content-Type": "application/json"}
    timeout = TIMEOUT_BY_TYPE.get(search_type, 120)

    for attempt in range(MAX_RETRIES):
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(f"{BASE_URL}/search", json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                records = []
                for r in data.get("results", []):
                    entry = {
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "published_date": r.get("publishedDate"),
                        "score": r.get("score"),
                        "highlights": r.get("highlights", []),
                    }
                    if include_text and r.get("text"):
                        entry["content"] = r["text"]
                    records.append(entry)

                return {
                    "source": f"Exa AI Semantic Search ({search_type})",
                    "query": query,
                    "search_type": search_type,
                    "category": category,
                    "total_results": len(records),
                    "records": records,
                }

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                wait = 2 ** attempt
                print(f"[exa] 429 rate limit attempt {attempt}, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            return {
                "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}",
                "records": [],
                "source": "Exa AI Semantic Search",
            }
        except httpx.TimeoutException:
            # Deep modes can legitimately take a long time — retry once before failing
            if attempt < MAX_RETRIES - 1:
                print(f"[exa] Timeout on attempt {attempt} (type={search_type}), retrying...", file=sys.stderr)
                continue
            return {
                "error": f"Timeout after {timeout}s for type={search_type}. Try deep-lite or auto.",
                "records": [],
                "source": "Exa AI Semantic Search",
            }
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            return {"error": str(e), "records": [], "source": "Exa AI Semantic Search"}

    return {"error": "Max retries exceeded", "records": [], "source": "Exa AI Semantic Search"}


def find_similar(url, num_results=5, max_chars=5000):
    """
    Find pages semantically similar to a given URL.
    Useful for finding competitors, distributors, or brands when you know one good example.
    The URL does not need to be crawled first — Exa uses its own index.
    """
    if not EXA_API_KEY:
        return {"error": "EXA_API_KEY not set in .env", "records": [], "source": "Exa AI"}

    payload = {
        "url": url,
        "numResults": num_results,
        "contents": {
            "text": {"maxCharacters": max_chars},
            "highlights": {"numSentences": 2, "highlightsPerUrl": 1},
        },
    }
    headers = {"x-api-key": EXA_API_KEY, "Content-Type": "application/json"}

    for attempt in range(MAX_RETRIES):
        try:
            with httpx.Client(timeout=45) as client:
                resp = client.post(f"{BASE_URL}/findSimilar", json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                records = [
                    {
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "published_date": r.get("publishedDate"),
                        "score": r.get("score"),
                        "highlights": r.get("highlights", []),
                        "content": r.get("text", ""),
                    }
                    for r in data.get("results", [])
                ]

                return {
                    "source": "Exa AI — pages similar to reference URL",
                    "reference_url": url,
                    "total_results": len(records),
                    "records": records,
                }

        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            return {"error": str(e), "records": [], "source": "Exa AI"}

    return {"error": "Max retries exceeded", "records": [], "source": "Exa AI"}


def main():
    parser = argparse.ArgumentParser(description="Exa AI Semantic Search")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # search — semantic search with depth and category control
    s = subparsers.add_parser("search", help="Semantic search query")
    s.add_argument("query", help="Search query — phrase it as a concept, not just keywords")
    s.add_argument("--count", type=int, default=5, help="Number of results (max 10)")
    s.add_argument(
        "--type",
        choices=VALID_TYPES,
        default="deep",
        help=(
            "Search depth: instant (~200ms), fast (~450ms), auto (~1s), "
            "deep-lite (2–10s), deep (5–60s), deep-reasoning (10–60s, best for complex questions)"
        ),
    )
    s.add_argument(
        "--category",
        choices=VALID_CATEGORIES,
        default=None,
        help="Restrict results to a content category: company, news, research paper, financial report, etc.",
    )
    s.add_argument("--since", help="Only include results published after this date (YYYY-MM-DD)")
    s.add_argument("--max-chars", type=int, default=5000, help="Max characters of text per result (default 5000)")
    s.add_argument("--no-text", action="store_true", help="Skip full text (faster — highlights only)")

    # similar — find pages like a known URL
    sim = subparsers.add_parser("similar", help="Find pages semantically similar to a given URL")
    sim.add_argument("url", help="Reference URL to find similar pages for")
    sim.add_argument("--count", type=int, default=5)
    sim.add_argument("--max-chars", type=int, default=5000)

    args = parser.parse_args()

    if args.command == "search":
        result = search(
            query=args.query,
            num_results=min(args.count, 10),
            search_type=args.type,
            include_text=not args.no_text,
            start_published_date=getattr(args, "since", None),
            category=args.category,
            max_chars=args.max_chars,
        )
    else:
        result = find_similar(
            url=args.url,
            num_results=min(args.count, 10),
            max_chars=args.max_chars,
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
