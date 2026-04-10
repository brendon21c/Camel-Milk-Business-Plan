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
- `Amazon FBA food product requirements [industry] seller guide`
- `selling [industry] products on Amazon requirements fees [current_year]`

**Query 3 — Specialty retail entry requirements and slotting fees**
- `[industry] specialty grocery store entry requirements [target_country]`
- `slotting fees food brands retail buyer requirements [target_country]`

**Query 4 — Distributors and brokers**
- `[industry] food distribution companies [target_country] contact`
- `wholesale [product_type] distributor broker [target_country]`

**Query 5 — Import customs and logistics**
- `importing [product_type] to [target_country] customs documentation`
- `[origin_country] food export to [target_country] import duties process`

**Query 6 — Competitor distribution strategy**
- `[industry] brand distribution model [target_country] case study`
- `[product_type] market [target_country] how brands sell channels`

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

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
- **High** — specific figures or named requirements from an authoritative source (Amazon Seller Central, government customs database, major industry publication)
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
  "customs_and_import_process": "<Summary of import duties, required agency registrations (e.g. FDA Prior Notice), documentation needed (commercial invoice, certificate of origin, lab testing), and typical customs clearance timeline. 3–5 sentences.>",
  "narrative_summary": "<3–5 sentence plain-English summary of the distribution landscape for this product in the target market. Covers which channels are most accessible for a new entrant, what the key requirements are, and any significant logistics or customs considerations. Written for the report. No jargon.>",
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
