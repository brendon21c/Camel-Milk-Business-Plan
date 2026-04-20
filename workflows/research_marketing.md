# Workflow: Research Marketing & Influencers

**Agent tier:** Haiku by default. Escalate to Sonnet if the marketing landscape is complex, influencer data is sparse, or health claim validation requires deeper cross-referencing. Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 72 hours  
**Report section:** 10 — Marketing & Influencers  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the marketing landscape for the proposition's product in its target country.
Produce a structured summary covering relevant influencers, effective marketing channels,
health certifications that resonate with buyers, scientific evidence supporting health claims,
competitor marketing strategies, and community or tribe marketing opportunities.

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
python tools/search_brave.py --query "[product_type] influencers content creators [industry] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "best marketing channels [target_demographic] [industry] [target_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] health certifications organic non-GMO grass-fed [target_country] consumer trust" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] health benefits scientific studies evidence [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] competitor marketing strategy advertising [target_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[target_demographic] [industry] community tribe marketing [target_country] [current_year]" --count 10 --freshness 72
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Influencers and content creators:**
```
python tools/search_brave.py --query "[industry] health food influencers [target_country] top creators [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[target_demographic] YouTube Instagram creators [target_country] food wellness" --count 10 --freshness 72
```

**Query 2 — Marketing channels:**
```
python tools/search_brave.py --query "how to market [industry] products [target_country] digital advertising [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[target_demographic] buying behaviour online channels [target_country]" --count 10 --freshness 72
```

**Query 3 — Health certifications:**
```
python tools/search_brave.py --query "food certifications [target_country] health-conscious consumers [industry]" --count 10 --freshness 72
python tools/search_brave.py --query "organic non-GMO certification value consumer trust [target_country] [industry]" --count 10 --freshness 72
```

**Query 4 — Health claims and scientific evidence:**
```
python tools/search_brave.py --query "[product_type] nutritional profile benefits research studies" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] health claims scientific backing peer reviewed [current_year]" --count 10 --freshness 72
```

**Query 5 — Competitor marketing strategies:**
```
python tools/search_brave.py --query "[industry] brand marketing case study [target_country] strategy [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] competing brands advertising channels [target_country]" --count 10 --freshness 72
```

**Query 6 — Community and tribe marketing:**
```
python tools/search_brave.py --query "[target_demographic] online communities forums groups [target_country] [industry]" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] niche communities dietary movements [target_country] [current_year]" --count 10 --freshness 72
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Official Data Sources

After completing all Brave searches, enrich the marketing picture with authoritative regulatory and news data.
Run all of the following unless a tool errors (log errors in `data_gaps`, continue).

**FTC health claim and endorsement compliance — always run for health food propositions:**
```
python tools/fetch_ftc_data.py guidance health_claims
python tools/fetch_ftc_data.py guidance endorsements
```
Use to: establish the legal boundaries for marketing claims before drafting any recommended strategy. Health claims that exceed FTC safe harbour rules are a legal risk that must be flagged in `data_gaps`. Endorsement rules apply to all influencer and affiliate partnerships.

**FTC food labelling compliance — run for food and beverage propositions:**
```
python tools/fetch_ftc_data.py guidance food_labelling
```
Use to: determine what labelling language is permitted for marketing and packaging copy. Feeds `health_claims[].fda_compliant` assessments.

**GDELT consumer and market news — always run:**
```
python tools/fetch_gdelt_news.py search "[product_type] consumer market [target_country]" --limit 10
python tools/fetch_gdelt_news.py search "[target_demographic] [industry] trend [target_country]" --limit 10
```
Use to: surface very recent consumer sentiment, market trend coverage, and brand launches that Brave searches may have missed. Feeds `community_opportunities` and validates `marketing_channels` data.

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

From the search results, extract the following. Pull concrete figures wherever available.
If a figure has a source URL, note it — it will be saved separately as a citation.

**Influencers and content creators:**

| Field | What to look for |
|---|---|
| `name` | Influencer or creator name or handle |
| `platform` | Primary platform (Instagram, YouTube, TikTok, podcast, blog, etc.) |
| `audience_size` | Follower or subscriber count — note the platform and date if available |
| `niche` | Specific focus area (e.g. gut health, ancestral diet, lactose intolerance, functional food) |
| `relevance_score` | 1–5 scale: how directly aligned this creator is to the product and demographic |
| `confidence` | High / Medium / Low — how well-evidenced is the audience size and niche alignment |

**Marketing channels:**

| Field | What to look for |
|---|---|
| `channel` | Channel type (e.g. Instagram, Amazon ads, influencer gifting, health food trade shows, email, podcast sponsorship) |
| `fit` | Why this channel suits the product and demographic — evidence-based, not assumed |
| `estimated_cac_usd` | Estimated customer acquisition cost in USD if any data is available — otherwise null |
| `notes` | Any important constraints, timing considerations, or platform-specific nuances |

**Health certifications:**

| Field | What to look for |
|---|---|
| `name` | Certification name (e.g. USDA Organic, Non-GMO Project, Certified Paleo, Kosher, Halal) |
| `value_to_consumer` | Why buyers in this demographic respond to this certification |
| `cost_to_obtain` | Estimated cost or cost range — null if not available |
| `mandatory_or_optional` | Whether any certification is legally required for this product category in the target country |

**Health claims:**

| Field | What to look for |
|---|---|
| `claim` | Specific health benefit claim (e.g. "supports gut health", "lower in lactose than cow milk") |
| `scientific_support` | strong / moderate / weak — based on peer-reviewed studies found in results |
| `fda_compliant` | yes / no / unclear — whether the claim can be made under FDA rules for this product category |

**Competitor marketing strategies:**

For each competitor strategy identified, note the brand (if named), the strategy or tactic observed,
the channel used, and any evidence of its effectiveness.

**Community and tribe opportunities:**

Identify specific online or offline communities, dietary movements, health groups, or cultural
groups where the product has natural fit. Note how to reach them and why the fit is strong.

### 3. Assess Confidence

For each section, note whether the data is:
- **High** — specific data with a credible source (industry report, verified influencer profile, peer-reviewed study, official FDA guidance)
- **Medium** — directionally accurate but from a less authoritative source or slightly dated
- **Low** — inferred, estimated, or sourced from a single unreliable result

Flag any health claim with weak scientific support or unclear FDA compliance in `data_gaps`
with a plain-language explanation of the risk. Do not suppress these flags — they are important
for the report reader.

### 4. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 5. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_marketing",
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
  "agent_name": "research_marketing",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "marketing_and_influencers",
  "generated_at": "<ISO timestamp>",
  "influencers": [
    {
      "name": "<influencer name or handle>",
      "platform": "<primary platform>",
      "audience_size": "<follower or subscriber count, or null>",
      "niche": "<specific focus area>",
      "relevance_score": "<1–5 integer>",
      "confidence": "high | medium | low"
    }
  ],
  "marketing_channels": [
    {
      "channel": "<channel name>",
      "fit": "<why this channel suits the product and demographic>",
      "estimated_cac_usd": "<value or null>",
      "notes": "<constraints, timing, or platform nuances>"
    }
  ],
  "health_certifications": [
    {
      "name": "<certification name>",
      "value_to_consumer": "<why buyers respond to this certification>",
      "cost_to_obtain": "<estimated cost or null>",
      "mandatory_or_optional": "mandatory | optional"
    }
  ],
  "health_claims": [
    {
      "claim": "<specific health benefit statement>",
      "scientific_support": "strong | moderate | weak",
      "fda_compliant": "yes | no | unclear"
    }
  ],
  "competitor_marketing_strategies": [
    {
      "brand": "<brand name or 'unnamed competitor'>",
      "strategy": "<tactic or approach observed>",
      "channel": "<channel used>",
      "effectiveness_evidence": "<what evidence exists that this is working, or null>"
    }
  ],
  "community_opportunities": [
    {
      "community": "<community name, platform, or movement>",
      "fit_rationale": "<why this product belongs in this community>",
      "how_to_reach": "<recommended entry point or tactic>"
    }
  ],
  "recommended_strategy": "<2–3 sentence summary of the highest-leverage marketing approach for this product and demographic. Evidence-based. No jargon.>",
  "narrative_summary": "<3–5 sentence plain-English summary of the marketing landscape. Written for the report. No bullet points. No jargon.>",
  "data_gaps": [
    "<any fields with low confidence, missing data, weak health claims, or unclear FDA compliance — with plain-language explanation of the risk>"
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
| No influencers can be identified for the exact product type | Search one level up (e.g. the broader industry or dietary category) and flag in `data_gaps` that results are indirect |
| A health claim has weak scientific support | Include it in `health_claims` with `"scientific_support": "weak"` and flag in `data_gaps` with the specific risk — do not omit or suppress it |
| An FDA compliance determination cannot be made | Set `fda_compliant` to `"unclear"` and flag in `data_gaps` — recommend the orchestrator route this to a legal or regulatory research step |
| No competitor marketing data is found | Set `competitor_marketing_strategies` to an empty array, note in `data_gaps`, and infer from general industry patterns in `recommended_strategy` |
| Conflicting data on audience size or CAC across sources | Use the most recent figure from the most credible source; note the conflict in `data_gaps` |
| All 6 searches return thin results | Complete what you can, rely more heavily on general industry knowledge for `recommended_strategy`, and note in narrative that marketing data is limited for this product category |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] `recommended_strategy` is present and grounded in at least one finding from the search results — not generic advice
- [ ] `influencers` has at least 1 entry with `"confidence": "medium"` or higher — if not, explain in `data_gaps`
- [ ] `marketing_channels` has at least 2 entries
- [ ] `health_claims` is populated — if the product has known health claims, they must appear here with scientific support and FDA compliance assessed
- [ ] Any health claim flagged `"scientific_support": "weak"` or `"fda_compliant": "unclear"` is also present in `data_gaps` with a plain-language risk note
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
