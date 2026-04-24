"""
YouTube Data API v3 tool — competitor channel research and content strategy analysis.
Free tier: 10,000 units/day (search = 100 units, channel/video lookup = 1 unit).
Use to: find competitors on YouTube, measure their reach and engagement,
understand content strategy, and gauge market education investment.
Commands: search_channels, channel_stats, search_videos, channel_videos.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
from dotenv import load_dotenv

load_dotenv()

API_KEY  = os.getenv('YOUTUBE_API_KEY', '')
BASE_URL = 'https://www.googleapis.com/youtube/v3'


def yt_get(endpoint, params):
    """Make a YouTube Data API request. Returns parsed JSON or error dict."""
    params['key'] = API_KEY
    url = f"{BASE_URL}/{endpoint}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return { 'error': { 'message': str(e) } }


def cmd_search_channels(query, max_results=5):
    """
    Find YouTube channels matching a keyword.
    Returns channel names, IDs, and descriptions — use IDs with channel_stats for metrics.
    """
    data = yt_get('search', { 'q': query, 'type': 'channel', 'maxResults': max_results, 'part': 'snippet' })

    if data.get('error'):
        return { 'error': data['error'].get('message', 'API error'), 'source': 'YouTube' }

    channels = []
    for item in data.get('items', []):
        channels.append({
            'channel_id':   item['id']['channelId'],
            'name':         item['snippet']['title'],
            'description':  item['snippet']['description'][:200],
            'published_at': item['snippet']['publishedAt'][:10],
        })

    return {
        'query':    query,
        'channels': channels,
        'count':    len(channels),
        'source':   'YouTube Data API v3',
        'tip':      'Use channel_id values with the channel_stats command for subscriber counts and engagement metrics',
    }


def cmd_channel_stats(channel_id):
    """
    Get full statistics for a known channel: subscribers, total views, video count, country.
    Use after search_channels to get hard metrics on a specific competitor.
    """
    data = yt_get('channels', { 'id': channel_id, 'part': 'snippet,statistics,brandingSettings' })

    if data.get('error'):
        return { 'error': data['error'].get('message', 'API error'), 'source': 'YouTube' }
    if not data.get('items'):
        return { 'error': f"Channel not found: {channel_id}", 'source': 'YouTube' }

    ch = data['items'][0]
    stats = ch.get('statistics', {})

    return {
        'channel_id':   channel_id,
        'name':         ch['snippet']['title'],
        'description':  ch['snippet']['description'][:300],
        'country':      ch['snippet'].get('country', 'N/A'),
        'created':      ch['snippet']['publishedAt'][:10],
        'subscribers':  int(stats.get('subscriberCount', 0)),
        'total_views':  int(stats.get('viewCount', 0)),
        'video_count':  int(stats.get('videoCount', 0)),
        'url':          f"https://youtube.com/channel/{channel_id}",
        'source':       'YouTube Data API v3',
    }


def cmd_search_videos(query, max_results=10):
    """
    Search for videos by keyword. Returns title, channel, date, and video ID.
    Use to understand what content exists in a space and who the content leaders are.
    """
    data = yt_get('search', {
        'q': query, 'type': 'video', 'maxResults': max_results,
        'order': 'relevance', 'part': 'snippet'
    })

    if data.get('error'):
        return { 'error': data['error'].get('message', 'API error'), 'source': 'YouTube' }

    videos = []
    for item in data.get('items', []):
        videos.append({
            'video_id':     item['id']['videoId'],
            'title':        item['snippet']['title'],
            'channel':      item['snippet']['channelTitle'],
            'channel_id':   item['snippet']['channelId'],
            'published_at': item['snippet']['publishedAt'][:10],
            'description':  item['snippet']['description'][:200],
            'url':          f"https://youtube.com/watch?v={item['id']['videoId']}",
        })

    return {
        'query':  query,
        'videos': videos,
        'count':  len(videos),
        'source': 'YouTube Data API v3',
    }


def cmd_channel_videos(channel_id, max_results=10):
    """
    Get the most recent videos from a channel plus engagement metrics (views, likes, comments).
    Calculates engagement rate to measure audience quality vs. raw view count.
    """
    # Step 1: Get recent video IDs from the channel
    search_data = yt_get('search', {
        'channelId': channel_id, 'maxResults': max_results,
        'order': 'date', 'type': 'video', 'part': 'snippet'
    })

    if search_data.get('error'):
        return { 'error': search_data['error'].get('message', 'API error'), 'source': 'YouTube' }

    items = search_data.get('items', [])
    if not items:
        return { 'error': f"No videos found for channel: {channel_id}", 'source': 'YouTube' }

    video_ids = [i['id']['videoId'] for i in items]

    # Step 2: Fetch statistics for all video IDs in one call
    stats_data = yt_get('videos', { 'id': ','.join(video_ids), 'part': 'statistics,snippet' })

    videos = []
    for v in stats_data.get('items', []):
        stats     = v.get('statistics', {})
        views     = int(stats.get('viewCount',   0))
        likes     = int(stats.get('likeCount',   0))
        comments  = int(stats.get('commentCount', 0))
        # Engagement rate = (likes + comments) / views — measures audience quality
        eng_rate  = round((likes + comments) / views * 100, 2) if views > 0 else 0

        videos.append({
            'title':           v['snippet']['title'],
            'published_at':    v['snippet']['publishedAt'][:10],
            'views':           views,
            'likes':           likes,
            'comments':        comments,
            'engagement_rate': f"{eng_rate}%",
            'url':             f"https://youtube.com/watch?v={v['id']}",
        })

    return {
        'channel_id': channel_id,
        'videos':     videos,
        'count':      len(videos),
        'source':     'YouTube Data API v3',
    }


def main():
    parser = argparse.ArgumentParser(description='YouTube competitor research tool')
    parser.add_argument('command', choices=['search_channels', 'channel_stats', 'search_videos', 'channel_videos'],
                        help='search_channels=find by keyword | channel_stats=metrics for a channel | search_videos=find videos | channel_videos=engagement for a channel')
    parser.add_argument('--query',      help='Search query (search_channels, search_videos)')
    parser.add_argument('--channel-id', dest='channel_id', help='YouTube channel ID (channel_stats, channel_videos)')
    parser.add_argument('--max-results', dest='max_results', type=int, default=10, help='Max results to return (default 10)')
    args = parser.parse_args()

    if not API_KEY:
        print(json.dumps({ 'error': 'YOUTUBE_API_KEY not set in .env' }))
        sys.exit(0)

    if args.command == 'search_channels':
        if not args.query: print(json.dumps({ 'error': 'query required for search_channels' })); sys.exit(0)
        result = cmd_search_channels(args.query, args.max_results)
    elif args.command == 'channel_stats':
        if not args.channel_id: print(json.dumps({ 'error': 'channel_id required for channel_stats' })); sys.exit(0)
        result = cmd_channel_stats(args.channel_id)
    elif args.command == 'search_videos':
        if not args.query: print(json.dumps({ 'error': 'query required for search_videos' })); sys.exit(0)
        result = cmd_search_videos(args.query, args.max_results)
    elif args.command == 'channel_videos':
        if not args.channel_id: print(json.dumps({ 'error': 'channel_id required for channel_videos' })); sys.exit(0)
        result = cmd_channel_videos(args.channel_id, args.max_results)
    else:
        result = { 'error': f"Unknown command: {args.command}" }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
