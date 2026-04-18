#!/usr/bin/env python3
"""
Exa AI Semantic Search — finds conceptually related content, not just keyword matches.
Brave finds what you literally asked for. Exa understands meaning and surfaces
relevant pages even when exact keywords are absent. Use alongside Brave.

Commands:
  search  <query>  -- Semantic or keyword search with full text content
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


def search(query, num_results=5, search_type="auto", include_text=True, start_published_date=None):
    """
    Semantic/neural search via Exa.
    search_type: 'neural' (conceptual), 'keyword' (exact), 'auto' (Exa decides).
    Returns full article text per result (up to 3000 chars) plus highlight sentences.
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
        payload["contents"]["text"] = {"maxCharacters": 3000}
    if start_published_date:
        payload["startPublishedDate"] = start_published_date

    headers = {"x-api-key": EXA_API_KEY, "Content-Type": "application/json"}

    for attempt in range(MAX_RETRIES):
        try:
            with httpx.Client(timeout=30) as client:
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
                    "source": "Exa AI Semantic Search — finds conceptually related content",
                    "query": query,
                    "search_type": search_type,
                    "total_results": len(records),
                    "records": records,
                }

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            return {
                "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}",
                "records": [],
                "source": "Exa AI Semantic Search",
            }
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            return {"error": str(e), "records": [], "source": "Exa AI Semantic Search"}

    return {"error": "Max retries exceeded", "records": [], "source": "Exa AI Semantic Search"}


def find_similar(url, num_results=5):
    """
    Find pages semantically similar to a given URL.
    Useful for finding competitors when you know one good example.
    """
    if not EXA_API_KEY:
        return {"error": "EXA_API_KEY not set in .env", "records": [], "source": "Exa AI"}

    payload = {
        "url": url,
        "numResults": num_results,
        "contents": {"text": {"maxCharacters": 2000}},
    }
    headers = {"x-api-key": EXA_API_KEY, "Content-Type": "application/json"}

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(f"{BASE_URL}/findSimilar", json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

            records = [
                {
                    "title": r.get("title"),
                    "url": r.get("url"),
                    "published_date": r.get("publishedDate"),
                    "score": r.get("score"),
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
        return {"error": str(e), "records": [], "source": "Exa AI"}


def main():
    parser = argparse.ArgumentParser(description="Exa AI Semantic Search")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # search — semantic or keyword query
    s = subparsers.add_parser("search", help="Semantic search query")
    s.add_argument("query", help="Search query")
    s.add_argument("--count", type=int, default=5, help="Results (max 10)")
    s.add_argument("--type", choices=["neural", "keyword", "auto"], default="auto",
                   help="neural=semantic meaning, keyword=exact terms, auto=Exa decides")
    s.add_argument("--since", help="Only results published after date (YYYY-MM-DD)")
    s.add_argument("--no-text", action="store_true", help="Skip full text (faster, highlights only)")

    # similar — find pages like a known URL
    sim = subparsers.add_parser("similar", help="Find pages semantically similar to a URL")
    sim.add_argument("url", help="Reference URL")
    sim.add_argument("--count", type=int, default=5)

    args = parser.parse_args()

    if args.command == "search":
        result = search(
            query=args.query,
            num_results=min(args.count, 10),
            search_type=args.type,
            include_text=not args.no_text,
            start_published_date=getattr(args, "since", None),
        )
    else:
        result = find_similar(url=args.url, num_results=min(args.count, 10))

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
