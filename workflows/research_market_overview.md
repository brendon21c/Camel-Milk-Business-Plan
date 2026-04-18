# Workflow: Research Market Overview

**Agent tier:** Haiku by default. Escalate to Sonnet if search results are sparse or contradictory and require deeper synthesis. Escalate to Opus only if the market landscape is genuinely complex and Sonnet results are poor quality.  
**Cache TTL:** 24 hours  
**Report section:** 4 — Market Overview  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the current market landscape for the proposition's product in its target country.
Produce a structured summary covering market size, growth trajectory, consumer trends,
import volumes, price points, and demand drivers.

This workflow is generic. All proposition-specific details (product, country, demographic)
come from the inputs — do not hard-code anything about camel milk or Somalia.

---

## Inputs

You will receive a JSON object with the following fields from the orchestrator:

```json
{
  "report_id": "<uuid>",
  "proposition_id": "<uuid>",
  "product_type": "e.g. dehydrated camel milk powder",
  "industry": "e.g. specialty dairy / health food",
  "origin_country": "e.g. Somalia",
  "target_country": "e.g. United States",
  "target_demographic": "e.g. health-conscious consumers, lactose-intolerant adults",
  "current_year": "e.g. 2026"
}
```

---

## Steps

### 1. Run Search Queries

Execute the following 6 searches using `tools/search_brave.py`. Replace bracketed
placeholders with values from your inputs. Run them sequentially — do not skip any.

```
python tools/search_brave.py --query "[product_type] market size [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] market growth rate forecast [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] consumer trends [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] import statistics [target_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] retail price per unit [target_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[target_demographic] [industry] demand drivers [target_country]" --count 10 --freshness 24
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Market size:**
```
python tools/search_brave.py --query "[product_type] market revenue [target_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] market size [target_country] [current_year] report" --count 10 --freshness 24
```

**Query 2 — Growth rate / forecast:**
```
python tools/search_brave.py --query "[product_type] industry outlook [current_year] growth" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] CAGR forecast [target_country]" --count 10 --freshness 24
```

**Query 3 — Consumer trends:**
```
python tools/search_brave.py --query "[product_type] buyer behaviour [target_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[target_demographic] purchasing trends [industry] [target_country]" --count 10 --freshness 24
```

**Query 4 — Import statistics:**
```
python tools/search_brave.py --query "[product_type] import export [target_country] trade data" --count 10 --freshness 24
python tools/search_brave.py --query "[origin_country] [product_type] export volume [target_country]" --count 10 --freshness 24
```

**Query 5 — Retail price:**
```
python tools/search_brave.py --query "[product_type] cost [target_country] Amazon Whole Foods" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] price comparison [target_country] online" --count 10 --freshness 24
```

**Query 6 — Demand drivers:**
```
python tools/search_brave.py --query "why consumers buy [product_type] [target_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] growth drivers [target_country] [current_year]" --count 10 --freshness 24
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Government Data Sources

After completing all Brave searches, enrich the research with official US government data.
These sources produce high-confidence data points that directly improve the viability score.
Run all of the following unless a tool errors (log errors in `data_gaps`, continue).

**Census demographic data — target market profile:**
```
python tools/fetch_census_data.py acs5 --geography us:1 --year 2022
```
Use to: validate the size of the target demographic (income levels, education, population).
Extract: total population, median household income, education levels.

**Census industry data — food manufacturing establishment count:**
```
python tools/fetch_census_data.py cbp --naics 311 --geography us:1
python tools/fetch_census_data.py cbp --naics 31151 --geography us:1
```
NAICS 311 = food manufacturing; 31151 = dairy product manufacturing.
Use to: understand the scale and concentration of the domestic food industry.

**USASpending — federal contracts in this industry:**
```
python tools/fetch_usaspending_data.py search --keyword "[product_type]" --award-type contracts --limit 10
python tools/fetch_usaspending_data.py naics --code 311511 --fiscal-year 2023
```
Use to: identify B2G demand, understand government procurement in this category.
Note: Many specialty food products have $0 in government contracts — that is useful
intelligence too (indicates purely consumer/retail market).

**SEC EDGAR — find public competitors and their scale:**
```
python tools/fetch_sec_edgar.py search --query "[product_type]" --form 10-K --limit 10
```
Use to: identify publicly traded companies operating in this space. If you find matches,
note their names — the competitors agent can look up their financials via the facts command.

**Perplexity fallback (use only if Brave market size data is thin):**
```
python tools/search_perplexity.py --query "[product_type] market size [target_country] [current_year] total addressable market"
```
Use when: Brave returned fewer than 3 results with actual market size figures.
Perplexity returns a synthesized answer with citations — add those citations to sources.

**GDELT global news — market sentiment and recent coverage:**
```
python tools/fetch_gdelt_news.py search "[product_type] market [target_country]" --limit 10
```
Use to: find recent news coverage about this product category. Useful for identifying emerging trends, consumer sentiment shifts, or newsworthy market events not yet indexed by web search.

**International economic context (run if origin_country != target_country OR if any market is non-US):**

If target country is NOT the US — fetch target market economic profile:
```
python tools/fetch_world_bank.py indicators [target_country_iso2]
```
Use to: validate market size assumptions with GDP per capita, population, and income data. Provides the economic foundation for demand estimates.

If target country is an OECD member (EU, Japan, Canada, Australia, South Korea, etc.):
```
python tools/fetch_oecd_data.py indicators [target_country_iso3]
```
Use to: supplement World Bank data with OECD-specific labour market and trade statistics.

If target country is an EU country:
```
python tools/fetch_eurostat_data.py market [eu_country_code]
```
Use to: get EU-specific GDP per capita (in EUR), population, and household income for the target EU market.

**Food and agriculture propositions only (if product is food, beverage, or agricultural):**
```
python tools/fetch_fao_data.py production "[product_commodity]" --country [target_country]
python tools/fetch_fao_data.py trade "[product_commodity]"
```
Use to: find authoritative production volume and global trade flow data for the commodity. FAO data provides the highest-confidence numbers for food market sizing.

**SBA small business context (US domestic propositions):**
```
python tools/fetch_sba_data.py stats
```
Use to: add national small business formation and survival rate context when the proposition involves entering the US as a small business.

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete figures wherever available.
If a figure has a source URL, note it — it will be saved separately as a citation.

| Field | What to look for |
|---|---|
| `market_size_global` | Global market value in USD (most recent year available) |
| `market_size_target_country` | Market value in the target country specifically |
| `growth_rate_cagr` | Compound annual growth rate (%) and forecast period |
| `market_size_forecast` | Projected market value at end of forecast period |
| `import_volume` | Annual import volume or value into target country if available |
| `avg_retail_price` | Typical retail price per unit (note unit size) |
| `price_range` | Low / high price range observed |
| `top_demand_drivers` | 3–5 key reasons consumers want this product |
| `top_consumer_segments` | Who is buying it — age groups, lifestyle, health conditions |
| `market_maturity` | Nascent / growing / mature / declining — your assessment |
| `key_trends` | 2–4 notable trends shaping the market right now |
| `data_gaps` | Any fields above where you could not find reliable data |

### 3. Assess Confidence

For each field, note whether the data is:
- **High** — specific figure with a credible source (market research firm, government data, major publication)
- **Medium** — directionally accurate but from a less authoritative source or slightly dated
- **Low** — inferred, estimated, or sourced from a single unreliable result

If a field has Low confidence, flag it in `data_gaps` and explain why.

### 4. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 5. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_market_overview",
  "status": "complete",
  "output": <your JSON output object>
}
```

If any step fails (search returns no results, DB write fails), set `status` to `"failed"`
and include an `"error"` key in the output describing what went wrong. Do not halt the
whole run — return what you have and flag the gaps.

### 6. Save Sources

For every URL you cite in your output, call `db.js → saveReportSource()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_market_overview",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "market_overview",
  "generated_at": "<ISO timestamp>",
  "market_size": {
    "global_usd": "<value or null>",
    "global_year": "<year or null>",
    "target_country_usd": "<value or null>",
    "target_country_year": "<year or null>",
    "confidence": "high | medium | low"
  },
  "growth": {
    "cagr_pct": "<value or null>",
    "forecast_period": "<e.g. 2026–2031 or null>",
    "market_size_at_forecast_end_usd": "<value or null>",
    "confidence": "high | medium | low"
  },
  "imports": {
    "annual_volume_or_value": "<value or null>",
    "unit": "<e.g. metric tons, USD or null>",
    "year": "<year or null>",
    "confidence": "high | medium | low"
  },
  "pricing": {
    "avg_retail_price": "<value or null>",
    "unit": "<e.g. per 100g, per lb or null>",
    "price_range_low": "<value or null>",
    "price_range_high": "<value or null>",
    "confidence": "high | medium | low"
  },
  "demand_drivers": [
    "<driver 1>",
    "<driver 2>",
    "<driver 3>"
  ],
  "consumer_segments": [
    "<segment 1>",
    "<segment 2>"
  ],
  "market_maturity": "nascent | growing | mature | declining",
  "key_trends": [
    "<trend 1>",
    "<trend 2>"
  ],
  "narrative_summary": "<3–5 sentence plain-English summary of the market. Written for the report. No jargon.>",
  "data_gaps": [
    "<any fields with low confidence or missing data>"
  ],
  "sources": [
    {
      "url": "<url>",
      "title": "<title>",
      "relevance": "<what this source was used for>"
    }
  ]
}
```

---

## Edge Cases

| Situation | How to handle |
|---|---|
| Brave returns 0 results for a query | Log the query in `data_gaps`, continue with remaining queries |
| Market data is only available globally (no country-specific figure) | Use global figure, note it in `data_gaps` |
| Conflicting figures from different sources | Use the most recent from the most credible source; note the conflict in `data_gaps` |
| All 6 searches return thin results | Set `market_maturity` to `"nascent"`, note in narrative that market data is limited, complete what you can |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] At least one of `market_size.global_usd` or `market_size.target_country_usd` is populated
- [ ] `demand_drivers` has at least 2 entries
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
