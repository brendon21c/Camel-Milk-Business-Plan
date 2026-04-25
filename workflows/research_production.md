# Workflow: Research Production & Equipment

**Agent tier:** Haiku by default. Escalate to Sonnet if production complexity is high (e.g. multi-stage processing, specialist equipment, heavily regulated manufacturing). Escalate to Opus only if Sonnet results are poor quality and the production landscape remains unclear.  
**Cache TTL:** 72 hours  
**Report section:** 7 — Production & Equipment  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the equipment, processing requirements, and capital investment needed to produce
the proposition's product at commercial scale in the origin country.

Produce a structured summary covering equipment types and costs, minimum viable production
scale, processing steps, quality control systems, facility requirements, key suppliers,
and realistic capex estimates.

This workflow is generic. All proposition-specific details (product, country, industry)
come from the inputs — do not hard-code anything about specific products or geographies.

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
python tools/search_brave.py --query "[product_type] processing equipment commercial scale cost [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] manufacturing equipment suppliers [industry]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] minimum viable production scale investment [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] production process steps technical requirements" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] quality control equipment [industry] certification [target_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] processing facility requirements energy water infrastructure" --count 10 --freshness 72
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Primary 1:** `[product_type] processing equipment commercial scale cost [current_year]`
```
python tools/search_brave.py --query "[product_type] manufacturing machinery price range [industry]" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] processing equipment capital cost estimate commercial" --count 10 --freshness 72
```

**Primary 2:** `[product_type] manufacturing equipment suppliers [industry]`
```
python tools/search_brave.py --query "[product_type] equipment vendors manufacturers global suppliers" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] processing line equipment companies sourcing" --count 10 --freshness 72
```

**Primary 3:** `[product_type] minimum viable production scale investment [current_year]`
```
python tools/search_brave.py --query "[product_type] small scale commercial production startup cost" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] minimum batch size viable production entry-level operation" --count 10 --freshness 72
```

**Primary 4:** `[product_type] production process steps technical requirements`
```
python tools/search_brave.py --query "how is [product_type] made processing stages overview" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] manufacturing process flow technical specifications" --count 10 --freshness 72
```

**Primary 5:** `[product_type] quality control equipment food safety certification [target_country]`
```
python tools/search_brave.py --query "[product_type] QC testing requirements [target_country] compliance" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] quality inspection standards quality assurance equipment" --count 10 --freshness 72
```

**Primary 6:** `[product_type] processing facility requirements energy water infrastructure`
```
python tools/search_brave.py --query "[product_type] factory setup requirements utilities space" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] production facility specifications footprint infrastructure needs" --count 10 --freshness 72
```

**Required — one local/regional search:**
Commercial production space, workshop rental, and co-packing availability vary widely by city. National benchmarks miss the specific costs the client will actually face.
```
python tools/search_brave.py --query "[product_type] production facility warehouse commercial space [company_location] [current_year]" --count 10 --freshness 72
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Official Data Sources

After completing all Brave searches, enrich production research with authoritative data sources.
Run all of the following unless a tool errors (log errors in `data_gaps`, continue).

**Energy cost benchmarks — always run for manufacturing propositions:**
```
python tools/fetch_doe_data.py fuel_costs --sector [industry_sector]
python tools/fetch_doe_data.py electricity --state [state_if_us_manufacturing]
```
Use to: establish authoritative energy cost inputs for the production cost model. Electricity and natural gas are major operating costs for most manufacturing operations. State-specific rates vary up to 4x — use the state where production will occur.

**IP landscape — run for technology-intensive or innovative product propositions:**
```
python tools/fetch_patents_data.py landscape "[product_type] manufacturing"
```
Use to: assess whether the production process is patent-protected. High patent count in manufacturing methods = IP risk and potential licensing costs. Few patents = opportunity.

**CPSC safety standards — run for all consumer product manufacturing:**
```
python tools/fetch_cpsc_data.py standards [product_type_category]
```
Product category options: furniture, electronics, food, toys, apparel, kitchen, medical.
Use to: identify which safety standards apply to the production process and what quality control systems must be built into the manufacturing line.

**Food and agriculture raw materials — run for food/beverage propositions:**
```
python tools/fetch_fao_data.py production "[primary_input_commodity]" --country [origin_country]
```
Use to: verify authoritative data on raw material production volumes and availability in the origin country. Directly informs supply availability assessment.

### 1c. Multi-Engine Research Layer (Required)

Run all four tool types below on every run. Each serves a different purpose and together they surface content that Brave and official APIs alone cannot reach.

**Required — two Perplexity synthesis queries:**
Perplexity returns a cited, AI-synthesised factual answer — not a list of links to parse. Use it for direct factual questions where Brave returns ten blog posts instead of a clear answer. Ask in plain English, as if briefing an analyst. Replace all bracketed placeholders with your actual input values.
```
python tools/search_perplexity.py --query "What equipment, facility requirements, and total capital investment are typically required to produce [product_type] at commercial scale, and who are the main equipment suppliers globally in [current_year]?"
python tools/search_perplexity.py --query "What are the key production quality control requirements, safety certifications, and manufacturing standards needed to produce [product_type] for sale in [target_country]?"
python tools/search_perplexity.py --query "What production problems, quality failures, and manufacturing cost overruns have caused [product_type] businesses to fail or struggle — what do experienced manufacturers warn new entrants about when setting up production for the first time?"
```

**Required — two Exa semantic searches:**
Exa finds conceptually related content even when exact keywords are absent. Use `--type deep` for equipment and production process questions — technical documentation and trade publications are exactly what deep retrieval surfaces.
```
search_exa search "[manufacturing process, equipment requirements, and production facility specifications for this product type at commercial scale]" --type deep --count 5
search_exa search "[quality control systems, food or product safety certifications, and production standards required to sell this product in the target country]" --type deep-lite --count 5
```

**Required — one Tavily deep research call:**
Tavily fetches full article text and synthesises an answer across sources. Use the `research` command for the most important production figure in this section — equipment cost, facility spec, or capex estimate — where you need full source data, not a snippet.
```
search_tavily research "[specific question for the key production cost or equipment figure you need full context on]" --count 5
```

**Required — Jina batch read of top source URLs:**
After all other searches are complete, identify the 3 most data-rich URLs from any source (Brave result, Exa result, Perplexity citation, official API output). Prioritise equipment manufacturer pages, industry association specs, or facility build guides. Fetch their full content to extract detail that snippets cut off.
```
fetch_jina_reader read "[url1]"
fetch_jina_reader read "[url2]"
fetch_jina_reader read "[url3]"
```

### 1d. Supply Chain & Production News

**NewsAPI — always run:**
Recent supply chain disruptions, raw material price swings, and manufacturing cost trends. Captures commodity news, port delays, and supplier issues that directly affect production cost estimates.
```
search_news everything --query "[raw_material OR product_type] supply chain OR manufacturing cost OR shortage" --sort-by relevancy --page-size 10
search_news headlines --query "[product_category] production" --category business
```

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete figures wherever available.
If a figure has a source URL, note it — it will be saved separately as a citation.

| Field | What to look for |
|---|---|
| `equipment` | Each major piece of equipment: name, purpose, cost range, known suppliers, typical lead time |
| `minimum_viable_scale` | Smallest production volume that is commercially practical (units/month) and the investment it requires |
| `production_steps` | Ordered list of processing stages from raw input to finished product |
| `quality_control_requirements` | Testing, inspection, and certification steps required for the target market |
| `facility_requirements` | Approximate floor space (sq ft), power draw (kW), water usage, and any special conditions (temperature, humidity, sanitation standards) |
| `total_equipment_capex` | Estimated low and high total capital expenditure for a starter operation |
| `key_suppliers` | Named equipment suppliers — company name, country of origin, what they supply |
| `data_gaps` | Any fields above where you could not find reliable data |

### 3. Assess Confidence

For each field, note whether the data is:
- **High** — specific figure with a credible source (equipment manufacturer quote, industry association, established trade publication with named methodology)
- **Medium** — directionally accurate but from a less authoritative source, slightly dated, or a range rather than a specific figure
- **Low** — inferred, estimated, or sourced from a single unreliable result

If a field has Low confidence, flag it in `data_gaps` and explain why.

After completing all field-level assessments, set the top-level `section_summary.confidence`:
- **High** — equipment costs sourced from manufacturer or distributor pages, production steps confirmed from industry sources, facility requirements backed by HACCP or trade body guidance
- **Medium** — costs are estimated from comparable products or secondary sources; process steps are well-documented for the industry even if not for this specific product
- **Low** — most cost figures are guesses, limited published data exists for this production type, or the origin country has no documented commercial production infrastructure

### 4. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 5. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_production",
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
  "agent_name": "research_production",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "production_and_equipment",
  "generated_at": "<ISO timestamp>",
  "equipment": [
    {
      "name": "<equipment name>",
      "purpose": "<what it does in the production process>",
      "estimated_cost_usd": {
        "low": "<value or null>",
        "high": "<value or null>"
      },
      "suppliers": ["<supplier name>", "<supplier name>"],
      "lead_time": "<e.g. 8–12 weeks or null>",
      "confidence": "high | medium | low"
    }
  ],
  "minimum_viable_scale": {
    "units_per_month": "<value or null>",
    "unit_description": "<e.g. kg, cases, units>",
    "investment_required_usd": "<value or null>",
    "confidence": "high | medium | low"
  },
  "production_steps": [
    "<step 1: e.g. Raw material intake and testing>",
    "<step 2>",
    "<step 3>"
  ],
  "quality_control_requirements": [
    "<requirement 1: e.g. Microbial testing at intake>",
    "<requirement 2>"
  ],
  "facility_requirements": {
    "space_sqft": "<value or null>",
    "power_kw": "<value or null>",
    "water_usage": "<e.g. 500 litres/day or null>",
    "special_conditions": "<e.g. temperature-controlled, HACCP-compliant, or null>",
    "confidence": "high | medium | low"
  },
  "total_equipment_capex_estimate": {
    "low_usd": "<value or null>",
    "high_usd": "<value or null>",
    "confidence": "high | medium | low",
    "notes": "<any assumptions or caveats>"
  },
  "key_suppliers": [
    {
      "name": "<company name>",
      "location": "<country or region>",
      "speciality": "<what they supply for this product type>"
    }
  ],
  "narrative_summary": "<3–5 sentence plain-English summary of what it takes to produce this product at commercial scale. Written for the report. No jargon. Should cover the most important equipment, rough cost to get started, and any notable technical hurdles.>",
  "section_summary": {
    "confidence": "high | medium | low",
    "confidence_rationale": "<1 sentence: e.g. 'Equipment costs sourced from manufacturer pages and distributor quotes' or 'Cost estimates inferred from comparable product types — no specific supplier data found for this product'>"
  },
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
| Equipment costs are only available in non-USD currency | Convert at current approximate rate, note currency and rate used in `total_equipment_capex_estimate.notes` |
| Search results describe industrial-scale operations only (no SME data) | Use the industrial figures, note in `data_gaps` that small-scale cost estimates were unavailable |
| Production process varies significantly by method or technology | Document the most common method fully; note alternatives in `data_gaps` |
| Conflicting cost figures from different sources | Use the most recent from the most credible source (manufacturer > trade publication > forum); note the conflict in `data_gaps` |
| All 6 searches return thin results | Complete what you can, populate `data_gaps` thoroughly, set all affected confidence fields to `"low"` |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] `equipment` array has at least 3 entries
- [ ] `production_steps` has at least 3 entries
- [ ] `total_equipment_capex_estimate` has at least a `low_usd` or `high_usd` value populated
- [ ] `key_suppliers` has at least 2 entries
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
- [ ] `section_summary.confidence` is set with a rationale — cost figures must trace to a source, not be invented
