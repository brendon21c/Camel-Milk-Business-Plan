#!/usr/bin/env python3
"""
Jina AI Reader — converts any URL to clean full-text markdown.
Free, no API key required for basic use.
Use when a Brave or Exa result looks promising and you need the full article,
not just the snippet. Returns the complete page stripped of ads and navigation.

Commands:
  read  <url>         -- Fetch full content of a single URL
  batch <url> <url>   -- Fetch content for multiple URLs (max 5)
"""

import sys
import json
import os
import argparse
import httpx
import time
from dotenv import load_dotenv

load_dotenv()

# Optional: register at jina.ai for a free key and get higher rate limits
JINA_API_KEY = os.getenv("JINA_API_KEY", "")
BASE_URL = "https://r.jina.ai"
MAX_RETRIES = 3


def read_url(url):
    """
    Fetch the full text content of a URL via Jina Reader.
    Returns clean markdown — ads, nav, and boilerplate stripped.
    Free without key (rate limited); register at jina.ai for higher limits.
    """
    headers = {
        "Accept": "application/json",
        "X-Return-Format": "markdown",
        "X-Timeout": "20",
    }
    if JINA_API_KEY:
        headers["Authorization"] = f"Bearer {JINA_API_KEY}"

    target = f"{BASE_URL}/{url}"

    for attempt in range(MAX_RETRIES):
        try:
            with httpx.Client(timeout=35) as client:
                resp = client.get(target, headers=headers)
                resp.raise_for_status()

                try:
                    data = resp.json()
                    content_data = data.get("data", {})
                    content = content_data.get("content", "")
                    title = content_data.get("title")
                except Exception:
                    # Jina sometimes returns plain text instead of JSON
                    content = resp.text
                    title = None

                return {
                    "source": "Jina AI Reader — full page content",
                    "url": url,
                    "title": title,
                    "word_count": len(content.split()) if content else 0,
                    "content": content,
                    "records": [{"url": url, "title": title, "content": content}],
                }

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                # Rate limited — back off longer
                time.sleep(5 * (attempt + 1))
                continue
            return {
                "error": f"HTTP {e.response.status_code} — could not fetch {url}",
                "url": url,
                "records": [],
                "source": "Jina AI Reader",
            }
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            return {
                "error": str(e),
                "url": url,
                "records": [],
                "source": "Jina AI Reader",
            }

    return {"error": "Max retries exceeded", "url": url, "records": [], "source": "Jina AI Reader"}


def read_multiple(urls):
    """Fetch full content for a list of URLs. Cap at 5 to avoid rate limits."""
    urls = urls[:5]
    results = []
    for url in urls:
        result = read_url(url)
        results.append(result)
        time.sleep(0.75)  # Polite delay — Jina is a free service

    successful = sum(1 for r in results if "error" not in r)
    return {
        "source": "Jina AI Reader — batch fetch",
        "total_urls": len(urls),
        "successful": successful,
        "failed": len(urls) - successful,
        "records": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Jina AI Reader — fetch full page content from any URL")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # read — single URL
    r = subparsers.add_parser("read", help="Read full content of a single URL")
    r.add_argument("url", help="URL to fetch")

    # batch — multiple URLs
    b = subparsers.add_parser("batch", help="Read content of multiple URLs (max 5)")
    b.add_argument("urls", nargs="+", help="URLs to fetch")

    args = parser.parse_args()

    if args.command == "read":
        result = read_url(args.url)
    else:
        result = read_multiple(args.urls)

    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
