"""
Financial data tool — stock quotes, company overviews, news, and price history.
Combines three APIs for redundancy and breadth:
  - Finnhub:       fast quotes, company news, earnings (FINNHUB_API_KEY)
  - Alpha Vantage: company overview, ticker search, fundamentals (ALPHA_VANTAGE_API_KEY)
  - Massive:       historical OHLCV price bars — formerly Polygon.io (MASSIVE_API_KEY)
Use for competitor public company research, market benchmarking, financial trend analysis.
Commands: quote, overview, news, history, search.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
from dotenv import load_dotenv

load_dotenv()

FINNHUB_KEY       = os.getenv('FINNHUB_API_KEY', '')
ALPHA_VANTAGE_KEY = os.getenv('ALPHA_VANTAGE_API_KEY', '')
MASSIVE_KEY       = os.getenv('MASSIVE_API_KEY', '')


def get_json(url, headers=None):
    """Make a GET request and return parsed JSON, or an error dict on failure."""
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return { '_fetch_error': str(e) }


def cmd_quote(ticker):
    """
    Current stock price, daily high/low, and percent change via Finnhub.
    Fast and lightweight — use to spot-check if a named competitor is publicly traded.
    """
    url  = f"https://finnhub.io/api/v1/quote?symbol={ticker}&token={FINNHUB_KEY}"
    data = get_json(url)

    if data.get('_fetch_error') or data.get('c') is None:
        return { 'error': f"No quote found for {ticker}", 'ticker': ticker, 'source': 'Finnhub' }

    return {
        'ticker':          ticker.upper(),
        'current_price':   data.get('c'),
        'change':          data.get('d'),
        'change_percent':  data.get('dp'),
        'high_today':      data.get('h'),
        'low_today':       data.get('l'),
        'previous_close':  data.get('pc'),
        'source':          'Finnhub',
    }


def cmd_overview(ticker):
    """
    Company fundamentals: sector, industry, market cap, P/E, revenue, employees.
    Useful for sizing a public competitor — Alpha Vantage OVERVIEW endpoint.
    """
    url  = f"https://www.alphavantage.co/query?function=OVERVIEW&symbol={ticker}&apikey={ALPHA_VANTAGE_KEY}"
    data = get_json(url)

    if data.get('_fetch_error') or not data.get('Symbol'):
        # Alpha Vantage rate-limits and returns a Note field when the key is exhausted
        note = data.get('Note') or data.get('Information')
        if note:
            return { 'error': 'Alpha Vantage rate limit hit', 'detail': note, 'ticker': ticker }
        return { 'error': f"No overview found for {ticker}", 'ticker': ticker, 'source': 'Alpha Vantage' }

    return {
        'ticker':          data.get('Symbol'),
        'name':            data.get('Name'),
        'description':     data.get('Description'),
        'sector':          data.get('Sector'),
        'industry':        data.get('Industry'),
        'country':         data.get('Country'),
        'exchange':        data.get('Exchange'),
        'market_cap':      data.get('MarketCapitalization'),
        'employees':       data.get('FullTimeEmployees'),
        'revenue_ttm':     data.get('RevenueTTM'),
        'gross_profit_ttm': data.get('GrossProfitTTM'),
        'pe_ratio':        data.get('PERatio'),
        'ev_to_revenue':   data.get('EVToRevenue'),
        '52_week_high':    data.get('52WeekHigh'),
        '52_week_low':     data.get('52WeekLow'),
        'analyst_target':  data.get('AnalystTargetPrice'),
        'source':          'Alpha Vantage',
    }


def cmd_news(args):
    """
    Recent news articles for a ticker symbol or general market topic via Finnhub.
    Useful for understanding recent competitor events (acquisitions, earnings, recalls).
    """
    if args.ticker:
        # Company-specific news
        url = (f"https://finnhub.io/api/v1/company-news"
               f"?symbol={args.ticker}&from={args.from_date}&to={args.to_date}&token={FINNHUB_KEY}")
    else:
        # General market news by category (forex, crypto, merger, general)
        category = args.category or 'general'
        url = f"https://finnhub.io/api/v1/news?category={category}&token={FINNHUB_KEY}"

    data = get_json(url)

    if isinstance(data, dict) and data.get('_fetch_error'):
        return { 'error': data['_fetch_error'], 'source': 'Finnhub news' }
    if not isinstance(data, list):
        return { 'error': 'Unexpected response from Finnhub', 'source': 'Finnhub news' }

    articles = []
    for item in data[:args.limit]:
        articles.append({
            'headline':  item.get('headline'),
            'source':    item.get('source'),
            'date':      item.get('datetime', ''),
            'summary':   item.get('summary'),
            'url':       item.get('url'),
            'sentiment': item.get('sentiment'),
        })

    return {
        'ticker':   args.ticker,
        'category': args.category,
        'articles': articles,
        'count':    len(articles),
        'source':   'Finnhub',
    }


def cmd_history(args):
    """
    Historical daily OHLCV price bars via Massive (formerly Polygon.io).
    Use to chart a competitor's stock trajectory over a time window.
    """
    url = (f"https://api.polygon.io/v2/aggs/ticker/{args.ticker}/range/1/day"
           f"/{args.from_date}/{args.to_date}"
           f"?adjusted=true&sort=asc&limit={args.limit}&apiKey={MASSIVE_KEY}")

    data = get_json(url)

    if data.get('_fetch_error'):
        return { 'error': data['_fetch_error'], 'ticker': args.ticker, 'source': 'Massive/Polygon' }
    if data.get('status') == 'ERROR' or not data.get('results'):
        return { 'error': data.get('error', 'No data returned'), 'ticker': args.ticker, 'source': 'Massive/Polygon' }

    bars = []
    for r in data.get('results', []):
        bars.append({
            'date':   str(r.get('t', '')),
            'open':   r.get('o'),
            'high':   r.get('h'),
            'low':    r.get('l'),
            'close':  r.get('c'),
            'volume': r.get('v'),
        })

    return {
        'ticker':       args.ticker,
        'from_date':    args.from_date,
        'to_date':      args.to_date,
        'bars_returned': len(bars),
        'bars':         bars,
        'source':       'Massive (Polygon.io)',
    }


def cmd_search(query):
    """
    Search for a ticker symbol by company name via Alpha Vantage.
    Use when you have a company name but need its ticker for other commands.
    """
    params = urllib.parse.urlencode({ 'function': 'SYMBOL_SEARCH', 'keywords': query, 'apikey': ALPHA_VANTAGE_KEY })
    url    = f"https://www.alphavantage.co/query?{params}"
    data   = get_json(url)

    if data.get('_fetch_error') or not data.get('bestMatches'):
        return { 'error': f"No ticker found for query: {query}", 'source': 'Alpha Vantage' }

    matches = []
    for m in data['bestMatches'][:5]:
        matches.append({
            'ticker':   m.get('1. symbol'),
            'name':     m.get('2. name'),
            'type':     m.get('3. type'),
            'region':   m.get('4. region'),
            'currency': m.get('8. currency'),
        })

    return { 'query': query, 'matches': matches, 'source': 'Alpha Vantage' }


def main():
    from datetime import datetime, timedelta

    today    = datetime.now().strftime('%Y-%m-%d')
    one_month = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

    parser = argparse.ArgumentParser(description='Financial data tool: stock quotes, company profiles, news, price history')
    parser.add_argument('command', choices=['quote', 'overview', 'news', 'history', 'search'],
                        help='quote=current price | overview=company fundamentals | news=recent articles | history=price bars | search=find ticker by name')
    parser.add_argument('--ticker',    help='Stock ticker symbol (e.g. AAPL, MSFT)')
    parser.add_argument('--query',     help='Company name search query (search command only)')
    parser.add_argument('--category',  help='News category for general news: general, forex, crypto, merger (news command, no ticker)')
    parser.add_argument('--from-date', dest='from_date', default=one_month, help='Start date YYYY-MM-DD (history/news, default: 30 days ago)')
    parser.add_argument('--to-date',   dest='to_date',   default=today,     help='End date YYYY-MM-DD (history/news, default: today)')
    parser.add_argument('--limit',     type=int, default=10, help='Max results to return (default 10)')
    args = parser.parse_args()

    if args.command == 'quote':
        if not args.ticker: print(json.dumps({ 'error': 'ticker required for quote' })); sys.exit(0)
        result = cmd_quote(args.ticker.upper())
    elif args.command == 'overview':
        if not args.ticker: print(json.dumps({ 'error': 'ticker required for overview' })); sys.exit(0)
        result = cmd_overview(args.ticker.upper())
    elif args.command == 'news':
        result = cmd_news(args)
    elif args.command == 'history':
        if not args.ticker: print(json.dumps({ 'error': 'ticker required for history' })); sys.exit(0)
        result = cmd_history(args)
    elif args.command == 'search':
        if not args.query: print(json.dumps({ 'error': 'query required for search' })); sys.exit(0)
        result = cmd_search(args.query)
    else:
        result = { 'error': f"Unknown command: {args.command}" }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
