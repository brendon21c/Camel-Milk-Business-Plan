"""
Product Hunt API tool — track product launches, upvote velocity, and category trends.
Uses GraphQL API with a non-expiring Developer Token (PRODUCT_HUNT_DEV_TOKEN).
Primarily useful for V3 proposition types: SaaS, digital products, developer tools.
Commands: search (find products by keyword), trending (top products today/week), category (products in a specific category).
"""

import argparse
import json
import os
import sys
import urllib.request
from dotenv import load_dotenv

load_dotenv()

DEV_TOKEN = os.getenv('PRODUCT_HUNT_DEV_TOKEN', '')
GQL_URL   = 'https://api.producthunt.com/v2/api/graphql'


def gql_query(query, variables=None):
    """Execute a GraphQL query against the Product Hunt API."""
    payload = json.dumps({ 'query': query, 'variables': variables or {} }).encode()
    headers = {
        'Authorization': f'Bearer {DEV_TOKEN}',
        'Content-Type':  'application/json',
    }
    req = urllib.request.Request(GQL_URL, data=payload, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return { 'errors': [{ 'message': str(e) }] }


def format_post(node):
    """Flatten a Product Hunt post node into a clean dict for research use."""
    return {
        'name':         node.get('name'),
        'tagline':      node.get('tagline'),
        'votes':        node.get('votesCount', 0),
        'comments':     node.get('commentsCount', 0),
        'topics':       [t['node']['name'] for t in node.get('topics', {}).get('edges', []) if t.get('node')],
        'url':          node.get('url'),
        'website':      node.get('website'),
        'launched':     node.get('featuredAt', '')[:10] if node.get('featuredAt') else None,
    }


def cmd_search(query, limit=10):
    """
    Search Product Hunt for products matching a keyword.
    Use to find competitors in a space and measure their community traction.
    Sorted by upvotes — higher vote count = stronger product-market fit signal.
    """
    gql = """
    query SearchPosts($query: String!, $first: Int!) {
      posts(query: $query, first: $first, order: VOTES) {
        edges {
          node {
            name tagline votesCount commentsCount url website featuredAt
            topics(first: 5) { edges { node { name } } }
          }
        }
      }
    }
    """
    data = gql_query(gql, { 'query': query, 'first': limit })

    if data.get('errors'):
        return { 'error': data['errors'][0].get('message'), 'source': 'Product Hunt' }

    posts = [format_post(e['node']) for e in data.get('data', {}).get('posts', {}).get('edges', [])]

    return {
        'query':  query,
        'posts':  posts,
        'count':  len(posts),
        'source': 'Product Hunt',
    }


def cmd_trending(period='today', limit=10):
    """
    Get top trending products on Product Hunt.
    period='today' = highest voted today; period='week' = highest voted this week.
    Use to spot emerging competitors and market momentum in a space.
    """
    # Product Hunt GraphQL orders by votes by default; 'today' uses featuredAt filter
    order_map = { 'today': 'VOTES', 'week': 'VOTES' }
    order     = order_map.get(period, 'VOTES')

    gql = """
    query TrendingPosts($first: Int!, $order: PostsOrder!) {
      posts(first: $first, order: $order) {
        edges {
          node {
            name tagline votesCount commentsCount url website featuredAt
            topics(first: 5) { edges { node { name } } }
          }
        }
      }
    }
    """
    data = gql_query(gql, { 'first': limit, 'order': order })

    if data.get('errors'):
        return { 'error': data['errors'][0].get('message'), 'source': 'Product Hunt' }

    posts = [format_post(e['node']) for e in data.get('data', {}).get('posts', {}).get('edges', [])]

    return {
        'period': period,
        'posts':  posts,
        'count':  len(posts),
        'source': 'Product Hunt',
    }


def cmd_category(topic, limit=10):
    """
    Get top products in a specific Product Hunt topic/category.
    Use to map the competitive landscape in a niche (e.g. "artificial-intelligence", "productivity").
    Topic slugs use hyphens: 'developer-tools', 'saas', 'productivity', 'marketing', 'design-tools'.
    """
    gql = """
    query TopicPosts($topic: String!, $first: Int!) {
      posts(topic: $topic, first: $first, order: VOTES) {
        edges {
          node {
            name tagline votesCount commentsCount url website featuredAt
            topics(first: 5) { edges { node { name } } }
          }
        }
      }
    }
    """
    data = gql_query(gql, { 'topic': topic, 'first': limit })

    if data.get('errors'):
        return { 'error': data['errors'][0].get('message'), 'source': 'Product Hunt' }

    posts = [format_post(e['node']) for e in data.get('data', {}).get('posts', {}).get('edges', [])]

    return {
        'topic':  topic,
        'posts':  posts,
        'count':  len(posts),
        'source': 'Product Hunt',
    }


def main():
    parser = argparse.ArgumentParser(description='Product Hunt tool for digital product competitive research')
    parser.add_argument('command', choices=['search', 'trending', 'category'],
                        help='search=find by keyword | trending=top products now | category=products in a topic')
    parser.add_argument('--query',    help='Search keyword (search command)')
    parser.add_argument('--period',   default='today', choices=['today', 'week'],
                        help='Trending period: today or week (trending command, default: today)')
    parser.add_argument('--topic',    help='Topic/category slug e.g. "developer-tools", "saas", "marketing" (category command)')
    parser.add_argument('--limit',    type=int, default=10, help='Max results to return (default 10)')
    args = parser.parse_args()

    if not DEV_TOKEN:
        print(json.dumps({ 'error': 'PRODUCT_HUNT_DEV_TOKEN not set in .env' }))
        sys.exit(0)

    if args.command == 'search':
        if not args.query: print(json.dumps({ 'error': 'query required for search' })); sys.exit(0)
        result = cmd_search(args.query, args.limit)
    elif args.command == 'trending':
        result = cmd_trending(args.period, args.limit)
    elif args.command == 'category':
        if not args.topic: print(json.dumps({ 'error': 'topic required for category command' })); sys.exit(0)
        result = cmd_category(args.topic, args.limit)
    else:
        result = { 'error': f"Unknown command: {args.command}" }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
