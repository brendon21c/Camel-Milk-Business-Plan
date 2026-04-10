# Workflow: Research Packaging

**Agent tier:** Haiku by default. Escalate to Sonnet if packaging requirements are complex (e.g. multiple regulated materials, intricate labeling regimes, or thin supplier data requiring deeper synthesis). Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 72 hours  
**Report section:** 8 — Packaging  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research packaging formats, materials, suppliers, costs, regulatory labeling requirements,
shelf life implications, and consumer preference trends for the proposition's product in its
target country. Produce a structured summary that gives the report a complete picture of
viable packaging options and what they cost at different production scales.

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
python tools/search_brave.py --query "[product_type] packaging formats types pouches tins jars" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] packaging suppliers MOQ minimum order quantity" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] packaging cost per unit wholesale [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[target_country] FDA packaging labeling requirements [industry] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] packaging shelf life barrier materials options" --count 10 --freshness 72
python tools/search_brave.py --query "[target_demographic] [industry] packaging trends preferences [target_country] [current_year]" --count 10 --freshness 72
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Packaging formats and types**
- `[product_type] packaging options containers retail [target_country]`
- `[industry] product packaging types comparison pouches canisters`

**Query 2 — Packaging suppliers and MOQ**
- `[product_type] packaging manufacturer wholesale minimum order`
- `custom food packaging supplier [industry] small batch`

**Query 3 — Packaging cost per unit**
- `[industry] packaging cost breakdown per unit small scale production`
- `food product packaging price range retail [current_year]`

**Query 4 — FDA labeling requirements**
- `[target_country] food labeling rules [industry] imported products requirements`
- `FDA food label compliance checklist [industry] [current_year]`

**Query 5 — Shelf life and barrier materials**
- `[product_type] shelf life storage requirements packaging type`
- `[industry] food packaging barrier properties moisture oxygen protection`

**Query 6 — Consumer packaging preferences**
- `[industry] consumer packaging preferences survey [target_country]`
- `[target_demographic] packaging sustainability preferences health food`

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete figures wherever available.
If a figure has a source URL, note it — it will be saved separately as a citation.

| Field | What to look for |
|---|---|
| `packaging_options` | Available formats (pouch, tin, jar, sachet, canister, etc.) and what materials they use |
| `material_pros_cons` | Barrier properties, sustainability profile, cost, and shelf life impact for each material |
| `recommended_format` | The single best-fit format given the product type and target market, with rationale |
| `labeling_requirements` | Mandatory label fields under target country regulations (nutrition facts, ingredient list, allergen warnings, net weight, country of origin, contact info, etc.) |
| `shelf_life_by_format` | Expected shelf life for the product under each packaging format |
| `key_suppliers` | Names, locations, MOQs, and typical lead times for packaging suppliers |
| `cost_at_scale` | Estimated per-unit packaging cost at 1k, 10k, and 100k units |
| `consumer_trends` | 2–4 notable packaging preferences or trends in the target market and industry |
| `data_gaps` | Any fields above where you could not find reliable data |

### 3. Assess Confidence

For each packaging option and cost figure, note whether the data is:
- **High** — specific figure with a credible source (supplier quote, industry report, government regulation text)
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
  "agent_name": "research_packaging",
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
  "agent_name": "research_packaging",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "packaging",
  "generated_at": "<ISO timestamp>",
  "packaging_options": [
    {
      "format": "<e.g. stand-up pouch, tin canister, glass jar>",
      "materials": "<e.g. multi-layer foil laminate, HDPE, PET>",
      "pros": "<barrier strength, cost, branding surface, consumer preference, etc.>",
      "cons": "<recyclability concerns, MOQ, cost, fragility, etc.>",
      "estimated_cost_per_unit": "<value or null>",
      "moq": "<minimum order quantity or null>",
      "confidence": "high | medium | low"
    }
  ],
  "recommended_format": {
    "format": "<best-fit format name>",
    "rationale": "<why this format suits the product type, target market, and cost structure>"
  },
  "labeling_requirements": [
    "<required label field 1 — e.g. Nutrition Facts panel (FDA 21 CFR 101)>",
    "<required label field 2 — e.g. Ingredient list in descending order by weight>",
    "<required label field 3 — e.g. Major allergen declaration>",
    "<required label field 4 — e.g. Net weight in both imperial and metric>",
    "<required label field 5 — e.g. Country of origin>",
    "<required label field 6 — e.g. US distributor or importer name and address>"
  ],
  "shelf_life_by_format": {
    "<format name>": "<expected shelf life — e.g. 18 months unopened>",
    "<format name>": "<expected shelf life>"
  },
  "key_suppliers": [
    {
      "name": "<supplier name>",
      "location": "<city, country>",
      "moq": "<minimum order quantity>",
      "lead_time": "<e.g. 4–6 weeks>"
    }
  ],
  "cost_at_scale": {
    "per_unit_1k": "<estimated cost per unit at 1,000 units or null>",
    "per_unit_10k": "<estimated cost per unit at 10,000 units or null>",
    "per_unit_100k": "<estimated cost per unit at 100,000 units or null>",
    "confidence": "high | medium | low",
    "notes": "<any caveats on these estimates>"
  },
  "consumer_trends": [
    "<trend 1 — e.g. resealable formats strongly preferred by health food buyers>",
    "<trend 2>"
  ],
  "narrative_summary": "<3–5 sentence plain-English summary of packaging options, key regulatory requirements, realistic costs, and the recommended approach. Written for the report. No jargon.>",
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
| No supplier MOQ data found | Note in `data_gaps`; provide general industry MOQ ranges if known from other results |
| Cost data only available for one scale (e.g. 10k units) | Populate that field; set the others to `null` and note in `cost_at_scale.notes` |
| Labeling requirements differ by product sub-type or claim (e.g. organic, allergen-free) | List the base mandatory requirements; note any claim-specific additions in `data_gaps` |
| Conflicting cost figures from different sources | Use the most recent from the most credible source; note the conflict in `data_gaps` |
| All 6 searches return thin results | Complete what you can, set affected confidence fields to `"low"`, and populate `data_gaps` with every missing field |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] `packaging_options` has at least 2 entries
- [ ] `recommended_format.rationale` explains the choice in terms of the specific product type and target market
- [ ] `labeling_requirements` has at least 4 entries (regulatory requirements rarely number fewer)
- [ ] `cost_at_scale` has at least one non-null value
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
