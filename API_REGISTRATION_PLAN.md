# API Registration Plan

**Last updated:** 2026-04-24 (Session 37 — all free-tier APIs registered and tested)
**Status:** API registration phase complete. No further registrations needed before launch.

---

## Active APIs (62 tools registered in run.js)

All keys in `.env` and working. Smoke tested 2026-04-24.

### Core Infrastructure

| API | Variable | Cost | Notes |
|---|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Pay-as-you-go | Claude Haiku (research) + Sonnet (assembly, fact-check) |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` | Free tier | Database + auth + storage |
| Resend | `RESEND_API_KEY` | Free (100/day) | Email delivery |
| GitHub | `GITHUB_TOKEN` | Free (5k req/hr) | Workflow dispatch trigger from admin panel |

### Search & Synthesis

| API | Variable | Cost | Tool Script |
|---|---|---|---|
| Brave Search | `BRAVE_SEARCH_KEY` | $5/mo | `search_brave.py` |
| Perplexity | `PERPLEXITY_API_KEY` | $5-20/mo | `search_perplexity.py` |
| Exa AI | `EXA_API_KEY` | Free (1k/mo) | `search_exa.py` |
| Tavily | `TAVILY_API_KEY` | Free (1k/mo) | `search_tavily.py` |
| Jina Reader | `JINA_API_KEY` | Free | `fetch_jina_reader.py` |
| NewsAPI | `NEWS_API_KEY` | Free (100 req/day) | `search_news.py` — headlines + archive search |
| YouTube | `YOUTUBE_API_KEY` | Free (10k units/day) | `search_youtube.py` — channels, stats, videos, engagement |
| Product Hunt | `PRODUCT_HUNT_DEV_TOKEN` | Free (never expires) | `search_product_hunt.py` — search, trending, category |

### Financial Data

| API | Variable | Cost | Tool Script |
|---|---|---|---|
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | Free (5 req/min) | `fetch_financial_data.py` — company overview, ticker search |
| Finnhub | `FINNHUB_API_KEY` | Free (60 req/min) | `fetch_financial_data.py` — live quotes, company news |
| Massive (Polygon.io) | `MASSIVE_API_KEY` | Free tier | `fetch_financial_data.py` — historical price bars |

### US Government Data (no key required)

| Tool Script | Source | Use Case |
|---|---|---|
| `fetch_fda_data.py` | openFDA (`OPEN_FDA_API_KEY`) | Food/drug recalls, adverse events |
| `fetch_usda_data.py` | USDA FDC + NASS | Nutritional data, agricultural stats |
| `fetch_census_data.py` | Census (`CENSUS_API_KEY`) | Demographics, industry sizing |
| `fetch_bls_data.py` | BLS (`BLS_V2_API_Key`) | Wages, employment |
| `fetch_epa_data.py` | EPA ECHO + TRI | Manufacturing compliance |
| `fetch_itc_data.py` | USITC + Census Trade | Import/export trade data |
| `fetch_sba_data.py` | SBA | Small business benchmarks |
| `fetch_usaspending_data.py` | USASpending.gov | Federal contracts/grants |
| `fetch_sec_edgar.py` | SEC EDGAR | Public company filings |
| `fetch_doe_data.py` | DOE EIA + NREL | Energy costs |
| `fetch_fda_device_data.py` | FDA 510(k) | Medical device clearances |
| `fetch_bis_data.py` | BIS | Export control classifications |
| `fetch_cbp_data.py` | CBP | Import compliance |
| `fetch_ftc_data.py` | FTC | Labelling rules |
| `fetch_cpsc_data.py` | CPSC | Product safety recalls |
| `fetch_patents_data.py` | USPTO | Patents + trademarks |

### International Data (no key required)

| Tool Script | Source | Use Case |
|---|---|---|
| `fetch_un_comtrade.py` | UN Comtrade (`UN_COMTRADE_API_KEY`) | Bilateral trade flows by HS code |
| `fetch_world_bank.py` | World Bank | GDP, income, development indicators |
| `fetch_imf_data.py` | IMF | Macroeconomic + financial indicators |
| `fetch_oecd_data.py` | OECD | Labour, trade, business stats |
| `fetch_eurostat_data.py` | Eurostat | EU production, trade, employment |
| `fetch_fao_data.py` | FAO | Global food/agriculture data |
| `fetch_wto_data.py` | WTO | Tariff rates |
| `fetch_gdelt_news.py` | GDELT | Global news events, 170 countries |
| `fetch_rapex_data.py` | EU Safety Gate | EU product safety alerts |

---

## Blocked APIs

These were investigated and cannot be used for this product.

| API | Status | Why | Fallback |
|---|---|---|---|
| **G2** | ⛔ Blocked | Restricted to G2 vendors managing their own listings. Third-party research use rejected with 401. | Use `site:g2.com` Brave queries for review data |
| **TikTok Research API** | ⛔ Blocked | Academic/non-profit only. Commercial use = permanent account revocation. | Perplexity + Brave for TikTok trend synthesis |
| **Reddit (PRAW)** | ⛔ Blocked | Registration process attempted and failed. | Perplexity + Brave `site:reddit.com` queries |
| **OpenCorporates** | ⛔ Too expensive | No free tier — minimum £2,250/year (~$2,800). | SEC EDGAR for public companies; Brave for private |

---

## Deferred (Pay When a Client Needs It)

Do NOT register these now. Wait until a paying client specifically asks for what they provide.

| API | Variable | Cost | What it unlocks | Trigger to buy |
|---|---|---|---|---|
| **Crunchbase** | `CRUNCHBASE_API_KEY` | $29/mo | Startup funding rounds, valuations, investor lists | Client asks "who's funding competitors?" |
| **SimilarWeb** | `SIMILARWEB_API_KEY` | ~$125/mo | Website traffic, bounce rate, digital market share | Client asks for competitor traffic benchmarks |
| **MediaStack** | `MEDIASTACK_API_KEY` | $9.99/mo | Curated news from 7.5k+ sources | GDELT + NewsAPI prove insufficient for a specific client |
| **X (Twitter) API v2** | `X_API_KEY` | $100/mo | Social sentiment, tweet volume, brand mentions | V3 client in influencer-heavy consumer category |
| **Pinterest API v5** | `PINTEREST_API_KEY` | Free | Pinterest trends for lifestyle/consumer goods | V3 client in home goods, food, fashion, DIY |

**Pinterest note:** Free but requires a privacy policy page URL at registration. Add `/privacy` to the McKeever Consulting website first, then register.

---

## Skipped Intentionally

| API | Why skipped |
|---|---|
| **NewsAPI paid tier** | Dev tier (100 req/day) is sufficient for current run volume |
| **Weatherstack** | Not yet needed — add when an agriculture or energy proposition requires climate data |
| **Instagram (Meta Graph)** | OAuth per client; build when first V3 client needs Instagram analysis |
| **App Store / Google Play** | Client's own app data only; no third-party competitor data available |

---

## GitHub Actions Secrets Still Needed

New keys are in `.env` locally but have NOT yet been added to GitHub repo secrets. Add these before the next scheduled run:

- [ ] `NEWS_API_KEY`
- [ ] `ALPHA_VANTAGE_API_KEY`
- [ ] `MASSIVE_API_KEY`
- [ ] `FINNHUB_API_KEY`
- [ ] `PRODUCT_HUNT_DEV_TOKEN`

Go to: GitHub repo → Settings → Secrets and variables → Actions → New repository secret

---

## Cost Summary

**Monthly API spend to run the product:**

| API | Cost |
|---|---|
| Brave Search | $5/mo |
| Perplexity | ~$15-25/mo (depends on run volume) |
| All others | Free tier |
| **Total** | **~$20-30/mo** |

Each report run costs ~$5-7 in Anthropic API calls. At $500-1,500 per report engagement, API costs are a rounding error.
