# Workflow: Research Distribution Strategy

**Agent tier:** Haiku by default. Escalate to Sonnet if the distribution landscape is complex (e.g. multiple viable channel types, heavily regulated import process, or conflicting data on distributor requirements). Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 72 hours  
**Report section:** 9 — Distribution Strategy  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the available distribution channels for the proposition's product in its target
country. Produce a structured summary covering channel options, requirements and fees,
competitor channel usage, a recommended entry-point channel, logistics and fulfilment
considerations, customs and import process, and key distributors or brokers in the space.

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
python tools/search_brave.py --query "[product_type] distribution channels [target_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "Amazon FBA requirements fees [industry] [target_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] specialty retail entry requirements slotting fees [target_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] distributors brokers [target_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] import customs clearance logistics [target_country] [origin_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] competitors distribution strategy [target_country]" --count 10 --freshness 72
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Distribution channels**
- `[industry] selling channels [target_country] retail online wholesale`
- `how to distribute [product_type] in [target_country] market entry`

**Query 2 — Amazon FBA requirements and fees**
- `Amazon FBA [industry] product requirements seller guide`
- `selling [industry] products on Amazon requirements fees [current_year]`

**Query 3 — Specialty retail entry requirements and slotting fees**
- `[industry] specialty retail store entry requirements [target_country]`
- `slotting fees [industry] brands retail buyer requirements [target_country]`

**Query 4 — Distributors and brokers**
- `[industry] distribution companies [target_country] contact`
- `wholesale [product_type] distributor broker [target_country]`

**Query 5 — Import customs and logistics**
- `importing [product_type] to [target_country] customs documentation`
- `[origin_country] export [product_type] to [target_country] import duties process`

**Query 6 — Competitor distribution strategy**
- `[industry] brand distribution model [target_country] case study`
- `[product_type] market [target_country] how brands sell channels`

**Required — one local/regional search:**
Find local distributors and wholesalers near the client's operating location. National distribution directories often miss regional players that are more accessible for a new entrant.
```
python tools/search_brave.py --query "[product_type] distributors wholesalers [company_location] [current_year]" --count 10 --freshness 72
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Official Data Sources

After completing all Brave searches, enrich the distribution picture with authoritative structured data.
Run all of the following unless a tool errors (log errors in `data_gaps`, continue).

**CBP import compliance obligations (run for all import propositions where origin_country != target_country):**
```
python tools/fetch_cbp_data.py requirements [product_category] --origin [origin_country]
```
Use to: establish the official customs compliance checklist for this trade corridor — Importer of Record obligations, customs bond, ISF filing, and any country-specific entry restrictions. Feeds directly into `customs_and_import_process`.

**WTO tariff data (run for all import propositions):**
```
python tools/fetch_wto_data.py hts [product_hts_code]
python tools/fetch_wto_data.py tariff [origin_country] [product_hts_code]
```
Use to: establish the MFN tariff rate and any FTA or AGOA preferential rate for the trade corridor. Feeds landed cost modeling in the financials section and informs import duty disclosure in `customs_and_import_process`.

**GDELT competitor and distribution news (run for all international propositions):**
```
python tools/fetch_gdelt_news.py search "[product_type] distribution channel [target_country]" --limit 10
```
Use to: surface recent news about distribution channel shifts, new retail partnerships, or logistics disruptions relevant to this product category. Helps validate or challenge data from Brave searches.

### 1c. Multi-Engine Research Layer (Required)

Run all four tool types below on every run. Each serves a different purpose and together they surface content that Brave and official APIs alone cannot reach.

**Required — two Perplexity synthesis queries:**
Perplexity returns a cited, AI-synthesised factual answer — not a list of links to parse. Use it for direct factual questions where Brave returns ten blog posts instead of a clear answer. Ask in plain English, as if briefing an analyst. Replace all bracketed placeholders with your actual input values.
```
python tools/search_perplexity.py --query "What are the main distribution channels, retailer entry requirements, and typical wholesale and retail margins for [product_type] in [target_country] in [current_year]?"
python tools/search_perplexity.py --query "How do successful [industry] brands reach [target_demographic] customers in [target_country] — what mix of online, direct-to-consumer, and retail distribution works best for [product_type]?"
python tools/search_perplexity.py --query "What distribution mistakes, retailer rejection reasons, and logistical failures have caused [product_type] brands to struggle in [target_country] — what do founders wish they had known about distribution before launching?"
```

**Required — two Exa semantic searches:**
Exa finds conceptually related content even when exact keywords are absent. Use `--type deep` for channel structure questions. The `similar` command finds more distributors or retailers like a known example — always run it if you found a strong distributor or retailer URL in any earlier search.
```
search_exa search "[distribution channels, retailer entry requirements, and margin structure for this product type in the target country]" --type deep --count 5
search_exa similar [best_distributor_or_retailer_url_found_in_brave_or_perplexity] --count 5
```
If no distributor URL was found, replace the `similar` call with:
```
search_exa search "[how brands reach this target demographic through retail, DTC, and online channels in the target country]" --type deep-lite --count 5
```

**Required — one Tavily deep research call:**
Tavily fetches full article text and synthesises an answer across sources. Use the `research` command for the most important distribution figure in this section — margin benchmarks, retailer requirements, or channel cost data — where you need full source detail, not a snippet.
```
search_tavily research "[specific question for the key distribution stat you need full context on]" --count 5
```

**Required — Jina batch read of top source URLs:**
After all other searches are complete, identify the 3 most data-rich URLs from any source (Brave result, Exa result, Perplexity citation, official API output). Prioritise retailer vendor pages, distributor websites, or trade association guides. Fetch their full content to extract detail that snippets cut off.
```
fetch_jina_reader read "[url1]"
fetch_jina_reader read "[url2]"
fetch_jina_reader read "[url3]"
```

### 1d. Logistics & Distribution News

**NewsAPI — always run:**
Freight rate changes, port disruptions, cold chain news, and logistics cost trends. These directly affect distribution cost estimates and should be the most recent data available.
```
search_news everything --query "[product_type] OR [target_country] shipping OR freight OR logistics OR distribution" --sort-by publishedAt --page-size 10
search_news headlines --query "supply chain logistics" --category business
```

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete figures wherever available.
If a figure has a source URL, note it — it will be saved separately as a citation.

| Field | What to look for |
|---|---|
| `channels` | All viable distribution channels (Amazon, DTC, wholesale, specialty retail, ethnic grocery, health food stores, etc.) |
| `channel_requirements` | For each channel: what a new brand needs to qualify (certifications, MOQs, insurance, labelling) |
| `channel_fees_or_margins` | For each channel: Amazon FBA fees, distributor margins (%), slotting fees, platform commissions |
| `competitor_channels` | Which channels existing competitors in this product category use |
| `recommended_entry_channel` | The most practical channel for a new market entrant — lowest friction, lowest capital requirement |
| `key_distributors` | Named distributors or brokers specialising in this product category or industry |
| `logistics_considerations` | Cold chain requirements (if any), warehousing needs, fulfilment model, lead times |
| `customs_and_import_process` | Import duties, FDA or equivalent agency registration, required documentation, clearance timeline |
| `data_gaps` | Any fields above where you could not find reliable data |

### 3. Assess Confidence

For each channel and each key field, note whether the data is:
- **High** — specific figures or named requirements from an authoritative source (Amazon Seller Central, government customs database, major industry publication, direct distributor contact)
- **Medium** — directionally accurate but from a less authoritative source or slightly dated
- **Low** — inferred, estimated, or sourced from a single unreliable result

If a field has Low confidence, flag it in `data_gaps` and explain why.

After completing all field-level assessments, set the top-level `section_summary.confidence`:
- **High** — channel fees and entry requirements sourced from primary platform or distributor documentation; customs process confirmed from CBP or equivalent authority
- **Medium** — channel requirements directionally correct but sourced from industry blogs rather than primary documentation; customs process from trade publication
- **Low** — channel data largely inferred; no named distributors found; customs process not verified for this specific trade corridor

### 4. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 5. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_distribution",
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
  "agent_name": "research_distribution",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "distribution_strategy",
  "generated_at": "<ISO timestamp>",
  "channels": [
    {
      "name": "<e.g. Amazon FBA, Whole Foods, DTC e-commerce, specialty distributor>",
      "type": "<online | retail | wholesale | direct>",
      "requirements": "<what a new brand needs to qualify — certifications, MOQs, labelling, etc.>",
      "fees_or_margins": "<e.g. 30–40% distributor margin, $X FBA fulfillment fee per unit>",
      "pros": "<why this channel suits this product type>",
      "cons": "<barriers, costs, or risks>",
      "fit_for_new_entrant": "high | medium | low",
      "confidence": "high | medium | low"
    }
  ],
  "recommended_entry_channel": {
    "name": "<channel name>",
    "rationale": "<2–3 sentences explaining why this is the best starting point for a new entrant>"
  },
  "key_distributors": [
    {
      "name": "<distributor or broker name>",
      "speciality": "<product categories or industries they focus on>",
      "contact_or_website": "<URL or contact info if available>"
    }
  ],
  "logistics_considerations": [
    "<e.g. cold chain not required for shelf-stable powder — standard dry freight>",
    "<e.g. typical lead time from origin country to US warehouse: 4–6 weeks by sea>",
    "<e.g. 3PL warehousing recommended for DTC fulfilment at launch scale>"
  ],
  "customs_and_import_process": {
    "summary": "<Summary of import duties, required agency registrations (e.g. FDA Prior Notice), documentation needed (commercial invoice, certificate of origin, lab testing), and typical customs clearance timeline. 3–5 sentences.>",
    "confidence": "high | medium | low"
  },
  "narrative_summary": "<3–5 sentence plain-English summary of the distribution landscape for this product in the target market. Covers which channels are most accessible for a new entrant, what the key requirements are, and any significant logistics or customs considerations. Written for the report. No jargon.>",
  "section_summary": {
    "confidence": "high | medium | low",
    "confidence_rationale": "<1 sentence: e.g. 'Channel fees confirmed from Amazon and distributor published rate cards; customs process verified from CBP.gov' or 'Distribution channel data estimated from comparable categories — no direct broker or distributor quotes obtained'>"
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
| No named distributors found for this category | Leave `key_distributors` as an empty array, note the gap — do not fabricate names |
| Conflicting fee or margin figures from different sources | Use the most recent from the most credible source; note the conflict in `data_gaps` |
| Import/customs process is not findable for origin-country-specific routes | Document what is known for the target country generally; flag the origin-specific gap |
| All 6 searches return thin results | Complete what you can, set all channel `confidence` values to `"low"`, note in narrative that distribution data is limited |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] `channels` array has at least 3 entries covering meaningfully different channel types
- [ ] `recommended_entry_channel` is populated with a rationale (not just a name)
- [ ] `customs_and_import_process` is present and describes the target-country import process
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
- [ ] No proposition-specific details (product names, country names) are hard-coded in this file — all values come from inputs
- [ ] `section_summary.confidence` is set with a rationale — channel fees and customs process must trace to primary sources
