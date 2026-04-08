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
- [ ] `sources` has at least 3 URLs
- [ ] No field contains raw search result HTML or markdown — synthesised text only
