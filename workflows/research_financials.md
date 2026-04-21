# Workflow: Research Financial Projections

**Agent tier:** Haiku by default. Escalate to Sonnet if financial modelling requires deeper reasoning or search results are too thin to build reliable unit economics. Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 24 hours (exchange rates and input costs shift frequently — do not use cached results older than 24 hours)  
**Report section:** 11 — Financial Projections  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the financial landscape for the proposition's product — from raw material sourcing
in the origin country through to retail sale in the target country. Produce a structured
summary covering input costs, freight and export costs, import duties, exchange rates,
wholesale and retail pricing benchmarks, gross margins, startup capital requirements,
and ongoing operating cost estimates.

This workflow is generic. All proposition-specific details (product, country, budget)
come from the inputs — do not hard-code anything about specific products or countries.

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
  "current_year": "e.g. 2026",
  "estimated_budget": "<client's stated budget if provided>"
}
```

---

## Steps

### 1. Run Search Queries

#### Domestic vs. Import Check

**Before running queries:** Check if `origin_country == target_country`. If yes, this is a **domestic product** — follow the Domestic Path below. If no, follow the Standard (Import) Path.

---

#### Standard (Import) Path

Execute the following 6 searches using `tools/search_brave.py`. Replace bracketed
placeholders with values from your inputs. Run them sequentially — do not skip any.

```
python tools/search_brave.py --query "[product_type] raw material sourcing cost per kg [origin_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] international shipping freight cost per kg [origin_country] to [target_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] import tariff duty rate [target_country] HS code customs [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[origin_country] currency exchange rate [target_country] currency [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] wholesale price distributor price per kg [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] gross margin benchmark wholesale retail [target_country] [current_year]" --count 10 --freshness 24
```

---

#### Domestic Path

Use these 6 queries instead when `origin_country == target_country`. No tariffs, exchange rates, or international freight apply — focus on domestic COGS, local distribution costs, and domestic shipping rates.

```
python tools/search_brave.py --query "[product_type] domestic cost of goods sold COGS per kg [origin_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] domestic production cost raw material sourcing [origin_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] domestic shipping rates distribution cost per kg [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] local distribution warehousing cost [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] wholesale price distributor price per kg [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] gross margin benchmark wholesale retail [target_country] [current_year]" --count 10 --freshness 24
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Raw material sourcing cost:**
```
python tools/search_brave.py --query "[product_type] production cost farm gate price [origin_country]" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] commodity price per kg [origin_country] export market [current_year]" --count 10 --freshness 24
```

**Query 2 — International shipping and freight:**
```
python tools/search_brave.py --query "freight cost per kg [origin_country] [target_country] air cargo sea shipping" --count 10 --freshness 24
python tools/search_brave.py --query "international logistics cost [origin_country] export [target_country] [product_type]" --count 10 --freshness 24
```

**Query 3 — Import tariffs and duties:**
```
python tools/search_brave.py --query "[target_country] import duty [industry] products customs tariff schedule" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] HS code customs classification [target_country] duty rate" --count 10 --freshness 24
```

**Query 4 — Exchange rate:**
```
python tools/search_brave.py --query "[origin_country] [target_country] currency conversion rate [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[origin_country] economy currency USD exchange rate history [current_year]" --count 10 --freshness 24
```

**Query 5 — Wholesale pricing:**
```
python tools/search_brave.py --query "[industry] wholesale distributor pricing [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[product_type] B2B price per unit bulk [target_country] importer" --count 10 --freshness 24
```

**Query 6 — Gross margin benchmarks:**
```
python tools/search_brave.py --query "[industry] profit margin benchmark [target_country] [current_year]" --count 10 --freshness 24
python tools/search_brave.py --query "[industry] gross margin wholesale retail markup [target_country]" --count 10 --freshness 24
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Government and Public Financial Data

After completing all Brave searches, fetch authoritative financial data from government
and public sources. These produce high-confidence benchmarks for financial projections.
Run all unless a tool errors (log error in `data_gaps`, continue).

**SEC EDGAR — find public competitor revenues for margin benchmarking:**
```
python tools/fetch_sec_edgar.py search --query "[product_type]" --form 10-K --limit 10
```
If you find a relevant public company, look up their CIK and fetch revenue data:
```
python tools/fetch_sec_edgar.py company --name "[competitor name]"
python tools/fetch_sec_edgar.py facts --cik [cik_number] --concept Revenues
python tools/fetch_sec_edgar.py facts --cik [cik_number] --concept GrossProfit
```
Use to: establish revenue scale of public competitors, gross profit margins (GrossProfit /
Revenues). These are high-confidence benchmarks for financial projections.

**USASpending — government procurement spend in this industry:**
```
python tools/fetch_usaspending_data.py search --keyword "[product_type]" --award-type grants --limit 10
```
Use to: identify whether government grants exist for producers in this category
(e.g. USDA specialty crop grants, food import facilitation programs). These may
represent non-dilutive funding options for the client.

**Census CBP — industry payroll benchmarks:**

Select the NAICS code that matches this proposition's `industry` input, then run:
```
python tools/fetch_census_data.py cbp --naics [naics_code] --geography us:1
```

| Industry | NAICS code |
|---|---|
| food / beverage | 311 |
| furniture / heirloom / wood goods | 337 |
| wood products / lumber | 321 |
| apparel / textiles | 315 |
| chemicals / materials / cosmetics | 325 |
| electronics / tech hardware | 334 |
| medical devices | 339 |
| general manufacturing (other) | 332 |
| energy / clean tech | 333 |

Use to: estimate industry-specific labour cost benchmarks. Annual payroll divided by employee count gives average salary per employee in that manufacturing sector — useful for staffing projections.

**BLS — labour wage benchmarks (run for all manufacturing propositions):**
```
python tools/fetch_bls_data.py wages
python tools/fetch_bls_data.py employment --sector durable
```
Use to: get authoritative BLS wage data for manufacturing workers. `wages` returns average hourly and weekly earnings for production workers across manufacturing. `employment` with `durable` covers furniture (NAICS 337) and wood products (NAICS 321) — the durable goods sector. If admin context notes specify a target role (e.g. skilled woodworker, cabinet maker), use these benchmarks to anchor labour cost line items in financial projections. Cross-reference with web searches for state-specific wage data where the manufacturing is located.

**Perplexity fallback (use only if margin/pricing data is thin):**
```
python tools/search_perplexity.py --query "[product_type] gross margin wholesale retail markup [target_country]"
python tools/search_perplexity.py --query "[industry] startup capital requirements [target_country]"
```
Use when: Brave returned fewer than 3 results with actual financial figures.

**SBA loan programs — always run to surface financing options for the client:**
```
python tools/fetch_sba_data.py loans --industry [naics_code]
python tools/fetch_sba_data.py standards [naics_code]
```
Use to: identify SBA loan programs available to the client (7a, 504, Microloan) and their size standard eligibility. These are non-dilutive financing paths that should always appear in financial projections.

**Import tariff verification (for import propositions):**
```
python tools/fetch_wto_data.py hts [product_hts_code]
python tools/fetch_wto_data.py tariff [origin_country] [product_hts_code]
```
Use to: get the authoritative MFN tariff rate from USITC HTS schedule and FTA/AGOA eligibility. This is the most accurate input for import duty calculations in financial projections.

**Energy and operating cost benchmarks (for manufacturing propositions):**
```
python tools/fetch_doe_data.py fuel_costs --sector [industry]
```
Use to: add authoritative energy cost line items to production cost modeling when manufacturing is part of the proposition.

**Origin country macro context (for import propositions):**
```
python tools/fetch_world_bank.py indicators [origin_country_iso2]
```
Use to: extract GDP per capita and inflation rate for the origin country. These are inputs for wage cost benchmarks and currency risk assessment in the financial model.

### 1c. Multi-Engine Research Layer (Required)

Run all four tool types below on every run. Each serves a different purpose and together they surface content that Brave and official APIs alone cannot reach.

**Required — two Perplexity synthesis queries:**
Perplexity returns a cited, AI-synthesised factual answer — not a list of links to parse. Use it for direct factual questions where Brave returns ten blog posts instead of a clear answer. Ask in plain English, as if briefing an analyst. Replace all bracketed placeholders with your actual input values.
```
python tools/search_perplexity.py --query "What are the typical gross margins, unit economics, and operating cost structure for a [industry] business selling [product_type] in [target_country] in [current_year]?"
python tools/search_perplexity.py --query "What startup capital is typically required to launch a [industry] business selling [product_type] to [target_demographic] in [target_country], including inventory, licensing, marketing, and working capital needs?"
```

**Required — two Exa semantic searches:**
Exa finds conceptually related content even when exact keywords are absent. Use `--type deep` for financial benchmarks — industry reports and financial case studies are exactly what deep retrieval surfaces.
```
search_exa search "[unit economics, gross margin, and cost structure for businesses in this industry selling this type of product]" --type deep --count 5 --category "financial report"
search_exa search "[startup capital requirements, funding rounds, and investment patterns for early-stage companies in this industry]" --type deep-lite --count 5
```

**Required — one Tavily deep research call:**
Tavily fetches full article text and synthesises an answer across sources. Use the `research` command for the single most important financial figure in this section — the margin benchmark, price point, or cost estimate — where you need full source data, not a snippet.
```
search_tavily research "[specific question for the key financial figure you need full context on]" --count 5
```

**Required — Jina batch read of top source URLs:**
After all other searches are complete, identify the 3 most data-rich URLs from any source (Brave result, Exa result, Perplexity citation, official API output). Prioritise pages with actual financial data, case studies, or industry benchmarks. Fetch their full content to extract detail that snippets cut off.
```
fetch_jina_reader read "[url1]"
fetch_jina_reader read "[url2]"
fetch_jina_reader read "[url3]"
```

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete figures wherever available.
All monetary values must be converted to USD unless noted otherwise.
If a figure has a source URL, note it — it will be saved separately as a citation.

| Field | What to look for |
|---|---|
| `raw_material_cost` | Cost to source or produce the product per kg in the origin country, in USD equivalent |
| `freight_cost` | Air or sea freight cost per kg from origin country to target country |
| `export_fees` | Export handling, documentation, and inspection fees charged at origin |
| `tariff_pct` | Import tariff or duty rate applied by the target country for this product type (%) |
| `customs_fees` | Customs broker fees, port handling, or inspection charges at destination |
| `exchange_rate` | Current exchange rate from origin country currency to target country currency |
| `wholesale_price` | Typical wholesale price per unit (or per kg) in the target country |
| `suggested_retail_price` | Observed or estimated retail price per unit for comparable products |
| `competitor_price_range` | Low / high retail price range observed across competitors |
| `gross_margin_pct` | Estimated gross margin achievable at the wholesale or retail level |
| `industry_margin_benchmark` | Published gross margin benchmark for this industry in the target country |
| `startup_capital` | Estimates for initial capital required to launch (equipment, compliance, inventory, working capital) |
| `operating_costs_monthly` | Recurring monthly costs: warehousing, marketing, staff, compliance, distribution |
| `data_gaps` | Any fields above where you could not find reliable data |

### 3. Build Unit Economics

Using the figures extracted in Step 2, calculate the following unit economics.
Show your working so the orchestrator can verify the logic.

```
cost_per_unit_landed  = raw_material_cost + freight_cost + export_fees + (tariff_pct × raw_material_cost) + customs_fees
gross_profit_per_unit = suggested_retail_price − cost_per_unit_landed
gross_margin_pct      = (gross_profit_per_unit ÷ suggested_retail_price) × 100
```

If any input to these calculations is missing or low-confidence, note it explicitly
in `data_gaps` and flag the unit economics output as `confidence: "low"`.

### 4. Assess Confidence

For each major field, note whether the data is:
- **High** — specific figure from a credible source (government trade data, industry report, established trade publication)
- **Medium** — directionally accurate but from a less authoritative source, slightly dated, or aggregated across a range
- **Low** — inferred, estimated, or sourced from a single unreliable result

If a field has Low confidence, flag it in `data_gaps` and explain why.

### 5. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 6. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_financials",
  "status": "complete",
  "output": <your JSON output object>
}
```

If any step fails (search returns no results, calculation cannot be completed, DB write fails),
set `status` to `"failed"` and include an `"error"` key in the output describing what went wrong.
Do not halt the whole run — return what you have and flag the gaps.

### 7. Save Sources

For every URL you cite in your output, call `db.js → saveReportSource()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_financials",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "financial_projections",
  "generated_at": "<ISO timestamp>",
  "input_costs": {
    "raw_material_per_kg_usd": "<value or null>",
    "year": "<year of data or null>",
    "notes": "<sourcing context, e.g. farm-gate vs. processor price>",
    "confidence": "high | medium | low"
  },
  "export_costs": {
    "freight_per_kg_usd": "<value or null>",
    "freight_mode": "<air | sea | mixed | unknown>",
    "export_fees_usd": "<flat fee or per-kg estimate or null>",
    "notes": "<any relevant context, e.g. refrigeration surcharges, consolidation>",
    "confidence": "high | medium | low"
  },
  "import_costs": {
    "tariff_pct": "<value or null>",
    "tariff_basis": "<e.g. CIF value, FOB value, or unknown>",
    "customs_fees_usd": "<flat fee or per-kg estimate or null>",
    "notes": "<HS code used, any preferential trade agreements that may apply>",
    "confidence": "high | medium | low"
  },
  "exchange_rate": {
    "origin_currency": "<ISO currency code, e.g. SOS>",
    "target_currency": "<ISO currency code, e.g. USD>",
    "rate": "<units of origin currency per 1 target currency unit, or null>",
    "as_of_date": "<ISO date or null>",
    "confidence": "high | medium | low"
  },
  "pricing": {
    "wholesale_per_unit_usd": "<value or null>",
    "wholesale_unit_size": "<e.g. per kg, per 500g bag or null>",
    "suggested_retail_per_unit_usd": "<value or null>",
    "retail_unit_size": "<e.g. per 500g bag or null>",
    "competitor_price_range": {
      "low_usd": "<value or null>",
      "high_usd": "<value or null>"
    },
    "confidence": "high | medium | low"
  },
  "margins": {
    "gross_margin_pct_estimate": "<value or null>",
    "industry_benchmark_pct": "<value or null>",
    "benchmark_source": "<publication or data source or null>",
    "confidence": "high | medium | low"
  },
  "startup_capital_estimate": {
    "low_usd": "<value or null>",
    "high_usd": "<value or null>",
    "major_components": [
      "<e.g. initial inventory purchase>",
      "<e.g. regulatory compliance and certifications>",
      "<e.g. branding and packaging design>",
      "<e.g. working capital buffer>"
    ],
    "confidence": "high | medium | low"
  },
  "operating_costs_monthly_estimate": {
    "low_usd": "<value or null>",
    "high_usd": "<value or null>",
    "major_line_items": [
      "<e.g. warehousing and cold storage>",
      "<e.g. digital marketing>",
      "<e.g. staff or contractor costs>",
      "<e.g. compliance and insurance>"
    ],
    "confidence": "high | medium | low"
  },
  "unit_economics": {
    "cost_per_unit_landed_usd": "<calculated value or null>",
    "suggested_retail_usd": "<value used in calculation or null>",
    "gross_profit_per_unit_usd": "<calculated value or null>",
    "gross_margin_pct": "<calculated value or null>",
    "calculation_notes": "<show inputs used and flag any assumptions>",
    "confidence": "high | medium | low"
  },
  "narrative_summary": "<3–5 sentence plain-English summary of the financial picture. Written for the report. No bullet points, no jargon. Cover landed cost, margin potential, and whether the estimated budget is likely to be sufficient if provided.>",
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
| Exchange rate not found via search | Use a well-known public rate from your training data, set confidence to `"low"`, and note the date it was last known |
| Tariff rate is ambiguous or depends on HS code classification | Record the most likely rate, note the HS code uncertainty in `data_gaps`, recommend the operator confirm with a licensed customs broker |
| Freight cost varies significantly by volume or mode | Record the range, note the mode (air vs. sea) that the range applies to, flag in `data_gaps` that volume-based quotes should be obtained |
| Unit economics cannot be calculated due to missing inputs | Populate the fields that can be calculated, set `confidence: "low"` on `unit_economics`, and list missing inputs in `data_gaps` |
| Client budget is provided and appears insufficient | Note this plainly in `narrative_summary` — do not soften it |
| Conflicting figures from different sources | Use the most recent from the most credible source; note the conflict in `data_gaps` |
| All 6 searches return thin results | Complete what you can, set all confidence values to `"low"`, escalate agent tier to Sonnet, and note data scarcity prominently in `narrative_summary` |
| `origin_country == target_country` | Follow Domestic Path in Step 1. Skip all export/import/cross-border fields in output. Populate domestic equivalents instead. |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] `unit_economics` is populated, or `data_gaps` explains specifically why it could not be calculated
- [ ] `input_costs.raw_material_per_kg_usd` is populated or flagged in `data_gaps`
- [ ] `pricing.suggested_retail_per_unit_usd` is populated or flagged in `data_gaps`
- [ ] `margins.gross_margin_pct_estimate` is populated or flagged in `data_gaps`
- [ ] `startup_capital_estimate` has at least a low/high range or an explicit note in `data_gaps`
- [ ] If `estimated_budget` was provided in inputs, `narrative_summary` addresses whether it appears sufficient
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] All monetary values are in USD (or explicitly noted otherwise)
- [ ] No field contains raw search result HTML or markdown — synthesised text only
