# Workflow: Research Origin Country Operations

**Agent tier:** Haiku by default. Escalate to Sonnet if the origin country situation is complex or unstable (high political risk, active conflict, sanctions, or currency crisis) and results require deeper synthesis. Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 72 hours  
**Report section:** Origin Country Operations — Supply Chain, Export Logistics, Local Risk  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the origin country's operational landscape for the proposition's product.
Produce a structured summary covering supply availability, local supplier landscape,
export documentation requirements, freight and logistics options, political and
currency risk, trade agreements, and quality control challenges.

This workflow is generic. All proposition-specific details (product, origin country,
target country) come from the inputs — do not hard-code anything about any specific
product, country, or trade corridor.

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
  "current_year": "e.g. 2026"
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
python tools/search_brave.py --query "[product_type] supply producers suppliers [origin_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[origin_country] export permit documentation requirements [product_type]" --count 10 --freshness 72
python tools/search_brave.py --query "freight shipping [origin_country] to [target_country] [industry] logistics routes" --count 10 --freshness 72
python tools/search_brave.py --query "[origin_country] political stability business environment risk [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "trade agreement [origin_country] [target_country] tariff import access [product_type]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] quality control sourcing challenges [origin_country]" --count 10 --freshness 72
```

---

#### Domestic Path

Use these 6 queries instead when `origin_country == target_country`. No export permits, cross-border freight, or foreign country risk apply — focus on domestic sourcing, supply chain, and logistics.

```
python tools/search_brave.py --query "[product_type] domestic suppliers sourcing [origin_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] domestic producers farms cooperatives [origin_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] domestic logistics warehousing distribution [origin_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[origin_country] domestic [industry] supply chain risks disruptions [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] domestic quality control testing certification [origin_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] regional supply chain infrastructure [origin_country] cold chain storage" --count 10 --freshness 72
```

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Supply and producers**
- `[product_type] production volume exporters [origin_country]`
- `[origin_country] [industry] supply chain farms cooperatives`

**Query 2 — Export permits and documentation**
- `[origin_country] food export certificate requirements agricultural products`
- `how to export [product_type] from [origin_country] government requirements`

**Query 3 — Freight and logistics**
- `air freight sea freight [origin_country] [target_country] food cargo`
- `[origin_country] port logistics international shipping options`

**Query 4 — Political stability and business risk**
- `[origin_country] country risk assessment [current_year] business`
- `World Bank fragile states index [origin_country] operating environment`

**Query 5 — Trade agreements and tariffs**
- `[origin_country] import tariff [target_country] [product_type] customs duty`
- `preferential trade access [origin_country] exports [target_country]`

**Query 6 — Quality control and sourcing challenges**
- `[product_type] supply chain quality issues [origin_country] certification`
- `[origin_country] cold chain food safety infrastructure challenges`

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

### 1b. Supplement with Official Data Sources

After completing all Brave searches, enrich the origin country assessment with authoritative data.
Run all of the following unless a tool errors (log errors in `data_gaps`, continue).

**Origin country economic and political context (ALWAYS run for import propositions):**
```
python tools/fetch_world_bank.py indicators [origin_country_iso2]
```
Use to: get authoritative GDP, inflation, trade openness, FDI inflows, and internet penetration for the origin country. World Bank data provides the credible foundation for country risk assessment. Extract: GDP per capita (proxy for wage costs), inflation (currency stability signal), trade (% of GDP) (openness of the economy).

**IMF macro stability — run when origin country has elevated currency or debt risk:**
```
python tools/fetch_imf_data.py indicators [origin_country_3letter]
```
Use to: cross-check inflation trajectory, government debt-to-GDP ratio, and current account balance. IMF data is the authoritative source for macroeconomic stability assessment.

**GDELT recent news — always run for origin country:**
```
python tools/fetch_gdelt_news.py search "[origin_country] business trade export" --country [origin_country] --limit 10
```
Use to: surface very recent news (last 30 days) about the origin country's political and trade environment. GDELT updates every 15 minutes — catches developments that web search may miss.

**Tariff corridor context (run for all import propositions):**
```
python tools/fetch_wto_data.py tariff [origin_country] [product_hts_code]
```
Use to: establish FTA status, AGOA eligibility (for African countries), and any Section 301 tariff exposure for the trade corridor. This directly feeds the financials section's import duty estimate.

**Food and agriculture supply — run for food/beverage/agricultural propositions:**
```
python tools/fetch_fao_data.py production "[product_commodity]" --country [origin_country]
python tools/fetch_fao_data.py trade "[product_commodity]" --reporter [origin_country]
```
Use to: get authoritative FAO production volume data for the origin country. This is the highest-confidence supply availability signal available — a country producing large volumes in FAO data is a reliable sourcing base.

**UN Comtrade — confirm the export route exists in official trade data:**
```
fetch_un_comtrade bilateral [origin_iso3] [target_iso3] [hs_code]
fetch_un_comtrade top_partners [origin_iso3] [hs_code] --flow X --count 10
```
Use to: verify whether the origin country currently exports this product class to the target country, and who else it exports to. Zero bilateral trade does not mean the route is impossible — it may mean it is untested, which is itself a key insight.
**Important:** HS codes cover a full commodity class. Cross-reference with web search to confirm what specifically comprises the reported export volume.

### 1c. Search Quality Escalation (Required)

Before concluding your research you **must** make at least these two calls — every run,
regardless of how much Brave returned. They surface content keyword search misses.

**Required — one Exa search:**
Exa uses semantic/neural search. Best for niche competitors, emerging angles, and topics
where exact terminology is uncertain. Rephrase your most important question conceptually.
```
search_exa search "[your key research question reframed conceptually]" --type neural --count 5
```

**Required — one Tavily search:**
Tavily returns full article text, not snippets. Use it for the most important quantitative
claim you found via Brave — get the complete data behind the number.
```
search_tavily search "[specific question for the key stat you need full detail on]" --count 3
```

**Optional — Jina to read a full URL:**
If a result links to a page with data you need but the snippet is truncated:
```
fetch_jina_reader read "[url]"
```

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete figures and named
entities wherever available. If a detail has a source URL, note it — it will be
saved separately as a citation.

| Field | What to look for |
|---|---|
| `supply_availability` | How reliably and abundantly is the product produced in the origin country |
| `local_suppliers` | Named producers, cooperatives, exporters, or aggregators in the origin country |
| `export_requirements` | Specific permits, certificates, or licences required to export this product from the origin country |
| `logistics_options` | Freight routes (port of origin → port of entry), carriers, transit times, estimated cost per kg |
| `political_stability` | Current stability level, any active conflicts, sanctions, or governance concerns |
| `currency_risk` | Currency volatility, USD convertibility, payment infrastructure |
| `trade_agreements` | Any bilateral or multilateral trade deals that reduce tariffs or ease market access |
| `quality_control_risks` | Known challenges with product consistency, cold chain, testing, or certification from origin country |
| `data_gaps` | Any fields above where you could not find reliable data |

### 3. Assess Confidence

For each field, note whether the data is:
- **High** — specific detail with a credible source (government body, international trade authority, major logistics provider, established publication)
- **Medium** — directionally accurate but from a less authoritative source or slightly dated
- **Low** — inferred, estimated, or sourced from a single unreliable result

If a field has Low confidence, flag it in `data_gaps` and explain why.

### 4. Flag High-Risk Conditions

Before formatting output, check explicitly for the following high-stakes conditions
and flag them prominently in the output if present:

- **Political instability:** active armed conflict, state fragility index in the "high alert" tier, or active international sanctions involving the origin country
- **Currency crisis:** hyperinflation, USD peg failure, capital controls, or inability to repatriate funds
- **Export restrictions:** government bans or quotas on the product category, or embargoes from the target country

If any of these apply, set the corresponding risk field to `"high"` and add a
plain-English warning sentence at the top of `narrative_summary`. Do not bury
high-risk findings — they are critical for the business viability assessment.

### 5. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 6. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_origin_ops",
  "status": "complete",
  "output": <your JSON output object>
}
```

If any step fails (search returns no results, DB write fails), set `status` to `"failed"`
and include an `"error"` key in the output describing what went wrong. Do not halt the
whole run — return what you have and flag the gaps.

### 7. Save Sources

For every URL you cite in your output, call `db.js → saveReportSource()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_origin_ops",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "origin_ops",
  "generated_at": "<ISO timestamp>",
  "supply_availability": {
    "assessment": "strong | moderate | limited",
    "notes": "<explanation of availability, seasonality, scale>",
    "confidence": "high | medium | low"
  },
  "local_suppliers": [
    {
      "name": "<supplier name or 'unknown'>",
      "type": "<e.g. cooperative, processor, broker, farm>",
      "notes": "<any relevant detail>"
    }
  ],
  "export_requirements": [
    {
      "document_or_permit": "<name of the requirement>",
      "issuing_authority": "<government body or agency>",
      "notes": "<process notes, estimated lead time, cost if known>"
    }
  ],
  "logistics_options": [
    {
      "route": "<port/city of origin → port/city of entry>",
      "carriers": ["<carrier or freight forwarder name>"],
      "transit_time": "<e.g. 18–22 days or null>",
      "estimated_cost_per_kg": "<value with currency or null>",
      "reliability": "high | medium | low"
    }
  ],
  "country_risk": {
    "political_stability": "low risk | medium risk | high risk",
    "currency_risk": "low | medium | high",
    "business_environment_notes": "<plain-English summary of operating environment>"
  },
  "trade_agreements": [
    {
      "agreement_name": "<name of treaty or trade framework>",
      "benefit": "<what advantage it confers — tariff reduction, preferential access, etc.>",
      "applicability": "<how directly it applies to this product and trade corridor>"
    }
  ],
  "quality_control_risks": [
    "<risk 1 — e.g. inconsistent testing infrastructure>",
    "<risk 2 — e.g. cold chain gaps between farm and port>"
  ],
  "overall_supply_chain_risk": "low | medium | high",
  "narrative_summary": "<3–5 sentence plain-English summary of the origin country's operational landscape. If high-risk conditions exist, the first sentence must flag them explicitly. Written for the report. No jargon.>",
  "data_gaps": [
    "<any fields with low confidence, missing data, or unverifiable claims>"
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
| Origin country has no formal export permit system documented online | Note in `export_requirements` that documentation is unverified; flag in `data_gaps`; set confidence to `"low"` |
| No named local suppliers found | Populate `local_suppliers` with a single entry: name `"unknown"`, type `"unverified"`, and note the gap |
| Conflicting risk assessments from different sources | Use the most recent from the most credible source (e.g. World Bank, UN, State Dept); note the conflict in `data_gaps` |
| No direct freight route found between origin and target country | Document the closest available routing (e.g. via connecting hub); note indirect routing in `logistics_options.route` |
| Trade agreement exists but it is unclear whether the product category is covered | Include the agreement, set `applicability` to `"unconfirmed — product category coverage unclear"`, and flag in `data_gaps` |
| High political or currency risk detected | Set risk fields to `"high"`, lead `narrative_summary` with an explicit warning sentence, and set `overall_supply_chain_risk` to at least `"high"` |
| `origin_country == target_country` | Follow Domestic Path in Step 1. Skip all export/import/cross-border fields in output. Populate domestic equivalents instead. |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] If political or currency risk is `"high"`, `narrative_summary` opens with an explicit warning
- [ ] `supply_availability.assessment` is populated (never null)
- [ ] `logistics_options` has at least one entry, even if partially populated
- [ ] `export_requirements` has at least one entry, even if confidence is low
- [ ] `overall_supply_chain_risk` is set and reflects the combined weight of all risk fields
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
