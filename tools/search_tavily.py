#!/usr/bin/env python3
"""
Tavily AI Search — purpose-built search API for AI research agents.
Unlike Brave (150-word snippets), Tavily returns complete article text
with ads and noise filtered out. Ideal when snippet-level data is insufficient.

Commands:
  search   <query>  -- Standard search, returns full content per result
  research <query>  -- Advanced depth + synthesized answer across sources
"""

import sys
import json
import os
import argparse
import httpx
import time
from dotenv import load_dotenv

load_dotenv()

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
BASE_URL = "https://api.tavily.com/search"
MAX_RETRIES = 3


def search(query, depth="basic", max_results=5, include_answer=False, include_domains=None):
    """
    Run a Tavily search.
    depth='basic' costs 1 credit/result; depth='advanced' costs 2 (more thorough).
    include_answer=True returns an AI-synthesized summary across all results.
    """
    if not TAVILY_API_KEY:
        return {
            "error": "TAVILY_API_KEY not set in .env — sign up at tavily.com",
            "records": [],
            "source": "Tavily AI Search",
        }

    payload = {
        "api_key": TAVILY_API_KEY,
        "query": query,
        "search_depth": depth,
        "max_results": max_results,
        "include_answer": include_answer,
        "include_raw_content": False,
        "include_images": False,
    }
    if include_domains:
        payload["include_domains"] = include_domains

    for attempt in range(MAX_RETRIES):
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.post(BASE_URL, json=payload)
                resp.raise_for_status()
                data = resp.json()

                records = [
                    {
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "content": r.get("content"),  # Full article text — not a snippet
                        "score": r.get("score"),
                        "published_date": r.get("published_date"),
                    }
                    for r in data.get("results", [])
                ]

                output = {
                    "source": "Tavily AI Search — full-content results for AI agents",
                    "query": query,
                    "search_depth": depth,
                    "total_results": len(records),
                    "records": records,
                }
                if include_answer and data.get("answer"):
                    output["synthesized_answer"] = data["answer"]

                return output

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            return {
                "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}",
                "records": [],
                "source": "Tavily AI Search",
            }
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            return {"error": str(e), "records": [], "source": "Tavily AI Search"}

    return {"error": "Max retries exceeded", "records": [], "source": "Tavily AI Search"}


def main():
    parser = argparse.ArgumentParser(description="Tavily AI Search — full-content search for AI agents")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # search — standard full-content search
    s = subparsers.add_parser("search", help="Full-content search")
    s.add_argument("query", help="Search query")
    s.add_argument("--count", type=int, default=5, help="Results (max 10)")
    s.add_argument("--answer", action="store_true", help="Include synthesized answer")
    s.add_argument("--domains", nargs="+", help="Restrict to specific domains")
    s.add_argument("--depth", choices=["basic", "advanced"], default="basic")

    # research — advanced depth + synthesized answer, for deep dives
    r = subparsers.add_parser("research", help="Deep research: advanced depth + synthesized answer")
    r.add_argument("query", help="Research question")
    r.add_argument("--count", type=int, default=5)

    args = parser.parse_args()

    if args.command == "search":
        result = search(
            query=args.query,
            depth=args.depth,
            max_results=min(args.count, 10),
            include_answer=args.answer,
            include_domains=getattr(args, "domains", None),
        )
    else:
        result = search(
            query=args.query,
            depth="advanced",
            max_results=min(args.count, 10),
            include_answer=True,
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
