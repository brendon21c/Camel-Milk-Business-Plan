"""
NewsAPI tool — fetch news articles for market research and competitor monitoring.
Free dev tier: 100 req/day. Requires User-Agent header or returns 401.
Commands: headlines (top stories by topic), everything (full archive search by query + date).
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

API_KEY  = os.getenv('NEWS_API_KEY', '')
BASE_URL = 'https://newsapi.org/v2'
# NewsAPI requires a User-Agent header — anonymous requests are rejected
HEADERS  = { 'User-Agent': 'McKeeverConsulting/1.0', 'X-Api-Key': API_KEY }


def fetch(endpoint, params):
    """Make a GET request to NewsAPI and return parsed JSON."""
    url = f"{BASE_URL}/{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return { 'status': 'error', 'message': str(e) }


def cmd_headlines(args):
    """
    Fetch top headlines filtered by query and/or category.
    Good for: "what's being reported about this market right now?"
    """
    params = { 'pageSize': args.page_size, 'language': 'en' }
    if args.query:    params['q']        = args.query
    if args.category: params['category'] = args.category
    if args.country:  params['country']  = args.country

    data = fetch('top-headlines', params)

    if data.get('status') != 'ok':
        return { 'error': data.get('message', 'Unknown error'), 'source': 'NewsAPI headlines' }

    articles = []
    for a in data.get('articles', []):
        articles.append({
            'title':       a.get('title'),
            'source':      a.get('source', {}).get('name'),
            'published_at': a.get('publishedAt', '')[:10],
            'description': a.get('description'),
            'url':         a.get('url'),
        })

    return {
        'query':         args.query,
        'category':      args.category,
        'total_results': data.get('totalResults', 0),
        'articles':      articles,
        'source':        'NewsAPI top-headlines',
    }


def cmd_everything(args):
    """
    Search full news archive by keyword, date range, and sort order.
    Good for: competitor press coverage, regulatory news, trend tracking over time.
    Default lookback is 30 days (free tier limit is 1 month).
    """
    # Free tier restricts to articles from the past month
    default_from = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

    params = {
        'q':        args.query,
        'language': 'en',
        'sortBy':   args.sort_by,
        'pageSize': args.page_size,
        'from':     args.from_date or default_from,
    }
    if args.to_date: params['to'] = args.to_date
    if args.sources: params['sources'] = args.sources

    data = fetch('everything', params)

    if data.get('status') != 'ok':
        return { 'error': data.get('message', 'Unknown error'), 'source': 'NewsAPI everything' }

    articles = []
    for a in data.get('articles', []):
        articles.append({
            'title':        a.get('title'),
            'source':       a.get('source', {}).get('name'),
            'author':       a.get('author'),
            'published_at': a.get('publishedAt', '')[:10],
            'description':  a.get('description'),
            'url':          a.get('url'),
        })

    return {
        'query':         args.query,
        'from_date':     params['from'],
        'sort_by':       args.sort_by,
        'total_results': data.get('totalResults', 0),
        'articles':      articles,
        'source':        'NewsAPI everything',
    }


def main():
    parser = argparse.ArgumentParser(description='NewsAPI tool for market and competitor news research')
    parser.add_argument('command', choices=['headlines', 'everything'],
                        help='headlines = top stories now; everything = archive search by query + date')
    parser.add_argument('--query',     help='Search query (e.g. "camel milk import", "FDA food recall")')
    parser.add_argument('--category',  help='News category: business, technology, health, science, entertainment, sports (headlines only)')
    parser.add_argument('--country',   default='us', help='Country code for headlines (default: us)')
    parser.add_argument('--from-date', dest='from_date', help='Start date YYYY-MM-DD (everything only, max 30 days ago on free tier)')
    parser.add_argument('--to-date',   dest='to_date',   help='End date YYYY-MM-DD (everything only)')
    parser.add_argument('--sort-by',   dest='sort_by',   default='relevancy',
                        choices=['relevancy', 'popularity', 'publishedAt'],
                        help='Sort order for everything command (default: relevancy)')
    parser.add_argument('--sources',   help='Comma-separated source IDs to restrict results (everything only)')
    parser.add_argument('--page-size', dest='page_size', type=int, default=10,
                        help='Number of articles to return (default 10, max 100)')
    args = parser.parse_args()

    if not API_KEY:
        print(json.dumps({ 'error': 'NEWS_API_KEY not set in .env' }))
        sys.exit(0)

    if args.command == 'headlines':
        result = cmd_headlines(args)
    else:
        if not args.query:
            print(json.dumps({ 'error': 'query is required for the everything command' }))
            sys.exit(0)
        result = cmd_everything(args)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
