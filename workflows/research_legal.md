# Workflow: Research Legal

**Agent tier:** Haiku by default. Escalate to Sonnet if legal landscape is complex or jurisdiction-specific nuance is required. Escalate to Opus only if Sonnet results are poor.
**Cache TTL:** 14 days (legal structures change slowly)
**Report section:** Feeds into Risk Assessment (section 12) and Recommendations (section 13)
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the legal and structural requirements for operating this business in the target country.
Cover business entity formation, insurance requirements, intellectual property considerations,
and import/export compliance obligations beyond FDA/regulatory (which is handled separately
in `research_regulatory.md`).

This workflow is generic. All proposition-specific details come from the inputs.

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

Execute the following 6 searches using `tools/search_brave.py`. Replace bracketed
placeholders with values from your inputs. Run them sequentially.

```
python tools/search_brave.py --query "business entity types importing [product_type] [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "LLC vs corporation [industry] business [target_country] [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "product liability insurance [industry] importer [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "trademark registration [product_type] brand [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "import compliance obligations [product_type] [target_country] customs broker" --count 10 --freshness 336
python tools/search_brave.py --query "[origin_country] [target_country] trade compliance sanctions restrictions [current_year]" --count 10 --freshness 336
```

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Business entity types for importers**
- `best business structure [industry] [target_country] startup`
- `how to set up import company [target_country] [product_type]`

**Query 2 — LLC vs corporation comparison**
- `LLC vs C-Corp importer tax liability [target_country]`
- `choosing business entity type [target_country] [industry]`

**Query 3 — Product liability and cargo insurance**
- `[industry] insurance requirements [target_country] [current_year]`
- `[industry] product liability insurance cost coverage [target_country]`

**Query 4 — Trademark and brand protection**
- `[target_country] trademark filing process [industry] brand [current_year]`
- `intellectual property protection importer [product_type] [target_country]`

**Query 5 — Import compliance and customs obligations**
- `importer of record requirements [target_country] customs`
- `customs broker [industry] [target_country] ISF filing requirements`

**Query 6 — Trade compliance, sanctions, and restrictions**
- `OFAC sanctions [origin_country] trade [current_year]`
- `[origin_country] export controls banned goods [target_country] compliance`

**Required — one local/regional search:**
State and city-level permits, licences, and zoning requirements are not covered by federal regulatory databases. These can be blocking issues for a new business.
```
python tools/search_brave.py --query "[product_type] business licence permit [company_location] state requirements [current_year]" --count 10 --freshness 72
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.

### 1b. Supplement with Official Legal and Compliance Data

After completing all Brave searches, fetch authoritative compliance data.
Run all of the following unless a tool errors (log in `data_gaps`, continue).

**Trademark conflict screening — always run:**
```
python tools/fetch_patents_data.py trademarks "[product_type]"
python tools/fetch_patents_data.py trademarks "[proposed_brand_name_if_known]"
```
Use to: surface existing US trademark registrations in this product category. A conflicting live trademark is a material legal risk that must be disclosed.

**Export control and sanctions screening (run for all import propositions):**
```
python tools/fetch_bis_data.py screening [origin_country]
```
Use to: check whether the origin country appears on any BIS embargoed or enhanced-scrutiny list. OFAC sanctions involving the origin country must be disclosed as a legal risk.

**Electronics/chemicals/software propositions — ECCN classification:**
```
python tools/fetch_bis_data.py eccn [product_type]
```
Use to: determine if BIS export controls affect sourcing or resale of the product.

**CBP import compliance obligations (for import propositions):**
```
python tools/fetch_cbp_data.py requirements [product_category] --origin [origin_country]
```
Use to: establish the legal compliance checklist for importing — Importer of Record obligations, customs bond requirement, ISF filing, and any country-specific restrictions.

**FTC marketing claim compliance:**
```
python tools/fetch_ftc_data.py guidance health_claims
python tools/fetch_ftc_data.py guidance endorsements
```
Use to: establish FTC legal boundaries for how the product can be marketed. FTC violations are legal risks that belong in the legal section.

### 1c. Multi-Engine Research Layer (Required)

Run all four tool types below on every run. Each serves a different purpose and together they surface content that Brave and official APIs alone cannot reach.

**Required — two Perplexity synthesis queries:**
Perplexity returns a cited, AI-synthesised factual answer — not a list of links to parse. Use it for direct factual questions where Brave returns ten blog posts instead of a clear answer. Ask in plain English, as if briefing an analyst. Replace all bracketed placeholders with your actual input values.
```
python tools/search_perplexity.py --query "What business structure, licences, and legal registrations does a new [industry] company need to import and sell [product_type] in [target_country] in [current_year]?"
python tools/search_perplexity.py --query "What are the trademark registration process, IP protection options, and key contract considerations for a [industry] business sourcing [product_type] from [origin_country] and selling in [target_country]?"
python tools/search_perplexity.py --query "What legal disputes, regulatory enforcement actions, and compliance failures have most commonly affected [industry] businesses importing [product_type] into [target_country] — what legal mistakes do new entrants consistently make and what enforcement actions have caught founders off guard?"
```

**Required — two Exa semantic searches:**
Exa finds conceptually related content even when exact keywords are absent. Use `--type deep` for legal requirements — official guidance and legal analysis documents are exactly what deep retrieval surfaces.
```
search_exa search "[business registration, licensing, and legal compliance requirements for an import business in this industry in the target country]" --type deep --count 5
search_exa search "[trademark registration, intellectual property protection, and supplier contract structure for a brand importing from a foreign country]" --type deep-lite --count 5
```

**Required — one Tavily deep research call:**
Tavily fetches full article text and synthesises an answer across sources. Use the `research` command for the most important legal requirement in this section — business formation rules, a specific licence, or an IP protection process — where you need full detail, not a summary.
```
search_tavily research "[specific question for the key legal requirement you need full context on]" --count 5
```

**Required — Jina batch read of top source URLs:**
After all other searches are complete, identify the 3 most data-rich URLs from any source (Brave result, Exa result, Perplexity citation, official API output). Prioritise official government, SBA, or bar association pages. Fetch their full content to extract detail that snippets cut off.
```
fetch_jina_reader read "[url1]"
fetch_jina_reader read "[url2]"
fetch_jina_reader read "[url3]"
```

### 1d. Legal & Regulatory News

**NewsAPI — always run:**
Recent court decisions, legislative changes, and enforcement actions relevant to the product category. Legal landscapes change — a ruling from 6 months ago may have shifted the risk picture significantly.
```
search_news everything --query "[product_type] lawsuit OR litigation OR legal OR court OR legislation" --sort-by publishedAt --page-size 10
search_news headlines --query "[product_category] law regulation" --category business
```

### 2. Extract and Synthesise

From the search results, extract the following:

| Field | What to look for |
|---|---|
| `entity_options` | Recommended business structures for an importer in target country (LLC, C-Corp, S-Corp, sole trader) |
| `recommended_entity` | The most appropriate structure for this type of import business, with rationale |
| `formation_cost` | Estimated cost and time to form the recommended entity |
| `insurance_types` | Types of insurance required or strongly recommended (product liability, cargo, general liability) |
| `insurance_cost_estimate` | Annual cost range for relevant policies |
| `ip_considerations` | Trademark registration, brand protection steps worth taking early |
| `customs_compliance` | Customs broker requirement, importer of record obligations, ISF filing |
| `sanctions_or_restrictions` | Any OFAC sanctions, trade restrictions, or compliance flags involving origin country |
| `ongoing_legal_obligations` | Annual filings, renewal requirements, compliance obligations |
| `data_gaps` | Fields where no reliable data was found |

### 3. Assess Confidence

For each field, rate confidence as:
- **High** — specific, sourced from a credible legal or government resource
- **Medium** — directionally accurate but from a secondary source or slightly dated
- **Low** — inferred or from a single unreliable result

### 4. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Synthesise only — do not include raw search results.

### 5. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_legal",
  "status": "complete",
  "output": <your JSON output object>
}
```

On failure, set `status` to `"failed"` and include an `"error"` key. Return what you
have — do not halt the run.

### 6. Save Sources

For every URL cited, call `db.js → saveReportSource()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_legal",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "legal",
  "generated_at": "<ISO timestamp>",
  "entity_options": [
    {
      "type": "<e.g. LLC>",
      "pros": ["<pro 1>"],
      "cons": ["<con 1>"],
      "fit_for_this_business": "high | medium | low"
    }
  ],
  "recommended_entity": {
    "type": "<entity type>",
    "rationale": "<why this structure fits>",
    "estimated_formation_cost_usd": "<value or null>",
    "estimated_formation_time": "<e.g. 1-2 weeks or null>",
    "confidence": "high | medium | low"
  },
  "insurance": [
    {
      "type": "<e.g. Product Liability>",
      "mandatory_or_recommended": "mandatory | recommended",
      "estimated_annual_cost_usd": "<range or null>",
      "confidence": "high | medium | low"
    }
  ],
  "ip_considerations": [
    "<consideration 1>",
    "<consideration 2>"
  ],
  "customs_compliance": {
    "customs_broker_required": true,
    "importer_of_record_obligations": "<summary>",
    "key_filings": ["<e.g. ISF filing>"],
    "confidence": "high | medium | low"
  },
  "sanctions_or_restrictions": {
    "flagged": true,
    "details": "<description of any OFAC, trade restriction, or compliance issue — null if none>",
    "confidence": "high | medium | low"
  },
  "ongoing_legal_obligations": [
    "<obligation 1>",
    "<obligation 2>"
  ],
  "narrative_summary": "<3–5 sentence plain-English summary. Written for the report. No jargon.>",
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
| Sanctions or trade restrictions found involving origin country | Set `sanctions_or_restrictions.flagged` to `true`, describe in detail — this must surface clearly in the report |
| No legal information found for target country | Note in `data_gaps`, recommend client consult a local attorney |
| Conflicting entity recommendations | Present top 2 options, note the conflict, recommend professional legal advice |
| DB write fails | Log error to stderr, return JSON to orchestrator directly |

---

## Quality Bar

Before saving output, verify:
- [ ] `recommended_entity` is populated with a rationale
- [ ] At least 2 `insurance` entries are present
- [ ] `sanctions_or_restrictions` is explicitly addressed (even if `flagged: false`)
- [ ] `customs_compliance` is populated
- [ ] `narrative_summary` is present and written in plain English
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
