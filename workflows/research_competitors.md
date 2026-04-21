# Workflow: Research Competitors

**Agent tier:** Haiku by default. Escalate to Sonnet if the competitive landscape is complex, data is contradictory, or more than two competitors require deep cross-referencing. Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 72 hours  
**Report section:** 5 — Competitor Analysis  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Identify and profile the active competitors selling the proposition's product type in the
target country. Produce a structured summary covering competitor brands, product lines,
price points, distribution channels, market positioning, strengths and weaknesses, and
gaps in the market that competitors are not currently serving.

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
python tools/search_brave.py --query "[product_type] brands [target_country] [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] price per unit [target_country] buy online" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] where to buy [target_country] distribution retail" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] [target_country] market positioning premium niche" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] [target_country] new brand startup funding [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] reviews [target_country] customer sentiment [current_year]" --count 10 --freshness 72
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Query 1 — Competitor brands:**
```
python tools/search_brave.py --query "[product_type] companies [target_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] brands selling [product_type]" --count 10 --freshness 72
```

**Query 2 — Price per unit:**
```
python tools/search_brave.py --query "[product_type] how much does it cost [target_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] retail pricing [target_country] shop" --count 10 --freshness 72
```

**Query 3 — Distribution and retail:**
```
python tools/search_brave.py --query "[product_type] sold at [target_country] retail stores" --count 10 --freshness 72
python tools/search_brave.py --query "buy [product_type] online [target_country] retailer" --count 10 --freshness 72
```

**Query 4 — Market positioning:**
```
python tools/search_brave.py --query "[product_type] brand differentiation [target_country]" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] [target_country] marketing angle positioning [current_year]" --count 10 --freshness 72
```

**Query 5 — New entrants / startups:**
```
python tools/search_brave.py --query "[product_type] [target_country] new company launch [current_year]" --count 10 --freshness 72
python tools/search_brave.py --query "[industry] startup [target_country] investment [current_year]" --count 10 --freshness 72
```

**Query 6 — Customer sentiment / reviews:**
```
python tools/search_brave.py --query "[product_type] [target_country] Reddit review opinion" --count 10 --freshness 72
python tools/search_brave.py --query "[product_type] [target_country] best brand comparison" --count 10 --freshness 72
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Official Data Sources

After completing all Brave searches, enrich the competitive picture with structured data.
Run all of the following unless a tool errors (log in `data_gaps`, continue).

**IP landscape — run for all propositions:**
```
python tools/fetch_patents_data.py landscape "[product_type]"
```
Use to: identify which companies hold the most patents in this technology/product area. Top patent assignees are often the strongest competitors or most defensible incumbents. Few patents = open market.

**Trademark screening — always run:**
```
python tools/fetch_patents_data.py trademarks "[product_type]"
```
Use to: find registered US trademarks in this product category. Reveals active brand names and potential naming conflicts the client should know about before brand development.

**GDELT competitor news — run for international propositions:**
```
python tools/fetch_gdelt_news.py search "[product_type] brand market [target_country]" --limit 10
```
Use to: surface recent news coverage about competitor products in the target market. Useful for identifying competitive events (acquisitions, product launches, recalls) that web search may have missed.

**SEC EDGAR — run to find public competitors' financials:**
```
python tools/fetch_sec_edgar.py search --query "[product_type] [industry]" --form 10-K --limit 10
```
Use to: identify publicly traded companies in this space. If found, look up CIK to get revenue scale — public competitor revenues provide the strongest financial benchmarks.

### 1c. Multi-Engine Research Layer (Required)

Run all four tool types below on every run. Each serves a different purpose and together they surface content that Brave and official APIs alone cannot reach.

**Required — two Perplexity synthesis queries:**
Perplexity returns a cited, AI-synthesised factual answer — not a list of links to parse. Use it for direct factual questions where Brave returns ten blog posts instead of a clear answer. Ask in plain English, as if briefing an analyst. Replace all bracketed placeholders with your actual input values.
```
python tools/search_perplexity.py --query "Who are the leading brands selling [product_type] in [target_country] in [current_year], what are their retail price points, and how is each brand differentiated in the market?"
python tools/search_perplexity.py --query "What gaps or underserved customer segments exist in the [product_type] category in [target_country] that current [industry] brands are failing to address?"
```

**Required — two Exa semantic searches:**
Exa finds conceptually related content even when exact keywords are absent. Use `--type deep` for comprehensive results. The `similar` command finds more companies like a known competitor — always run it if you found a strong competitor URL in any earlier search.
```
search_exa search "[the competitive landscape for this product type in the target country — who are the players and how do they compete]" --type deep --count 5 --category company
search_exa similar [best_competitor_url_found_in_brave_or_perplexity] --count 5
```
If no competitor URL was found, replace the `similar` call with:
```
search_exa search "[emerging or niche brands entering this product category in the target country]" --type deep-lite --count 5 --category company
```

**Required — one Tavily deep research call:**
Tavily fetches full article text and synthesises an answer across sources. Use the `research` command for the single most important quantitative claim in this section — price data, market share, or sales figures — where you need the complete article, not a snippet.
```
search_tavily research "[specific question for the key competitive stat you need full context on]" --count 5
```

**Required — Jina batch read of top source URLs:**
After all other searches are complete, identify the 3 most data-rich URLs from any source (Brave result, Exa result, Perplexity citation, official API output). Fetch their full content to extract detail that snippets cut off.
```
fetch_jina_reader read "[url1]"
fetch_jina_reader read "[url2]"
fetch_jina_reader read "[url3]"
```

### 2. Extract and Synthesise

From the search results, extract the following for each identified competitor.
Pull concrete figures wherever available. If a figure has a source URL, note it —
it will be saved separately as a citation.

**Per-competitor fields:**

| Field | What to look for |
|---|---|
| `name` | Brand or company name |
| `products` | Product lines and formats offered (e.g. powder, liquid, flavoured) |
| `price_points` | Retail price per unit — note unit size (e.g. $25 per 250g) |
| `distribution_channels` | Where they sell: Amazon, Whole Foods, DTC website, specialty retailers, etc. |
| `positioning` | Premium / budget / niche — and what angle they lead with (e.g. gut health, ancestral diet) |
| `estimated_market_share` | If available from any source — otherwise omit, do not guess |
| `strengths` | 2–3 genuine advantages based on evidence (brand recognition, reviews, price, certifications) |
| `weaknesses` | 2–3 vulnerabilities based on evidence (limited range, poor reviews, narrow distribution) |
| `confidence` | High / Medium / Low — how well-evidenced is this profile overall |

**Market-level fields:**

| Field | What to look for |
|---|---|
| `market_gaps` | Segments, demographics, geographies, formats, or price tiers no competitor is serving well |
| `competitive_intensity` | Low (few players, fragmented) / Medium / High (crowded, price wars, heavy ad spend) |

### 3. Assess Confidence

For each competitor profile, note whether the data is:
- **High** — brand confirmed, product and price verified from a retailer or official site, distribution channels confirmed
- **Medium** — brand confirmed but some details (price, channels) inferred or from secondary sources
- **Low** — brand mentioned in passing, few verifiable details, may be inactive or niche to the point of irrelevance

If a competitor profile has Low confidence, flag it in `data_gaps` and explain why.
If fewer than 2 competitors can be identified at any confidence level, flag this as a market gap
and set `competitive_intensity` to `"low"`.

### 4. Format Output

Structure your findings as the JSON object defined in the Output Format section below.
Do not include raw Brave search results — synthesise only.

### 5. Save to Database

Call `db.js → saveAgentOutput()` with:

```json
{
  "report_id": "<from inputs>",
  "agent_name": "research_competitors",
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
  "agent_name": "research_competitors",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "competitor_analysis",
  "generated_at": "<ISO timestamp>",
  "competitors": [
    {
      "name": "<brand or company name>",
      "products": [
        "<product line or format>"
      ],
      "price_points": [
        "<price per unit, e.g. $25 per 250g>"
      ],
      "distribution_channels": [
        "<channel, e.g. Amazon, Whole Foods, DTC>"
      ],
      "positioning": "<premium | budget | niche — and the angle they lead with>",
      "estimated_market_share": "<value or null if unavailable>",
      "strengths": [
        "<strength 1>",
        "<strength 2>"
      ],
      "weaknesses": [
        "<weakness 1>",
        "<weakness 2>"
      ],
      "confidence": "high | medium | low"
    }
  ],
  "market_gaps": [
    "<gap 1 — specific and evidence-based>",
    "<gap 2>"
  ],
  "competitive_intensity": "low | medium | high",
  "narrative_summary": "<3–5 sentence plain-English summary of the competitive landscape. Written for the report. No jargon. Cover who dominates, how they compete, and where openings exist.>",
  "data_gaps": [
    "<any competitor profiles with low confidence, missing fields, or searches that returned no useful results>"
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
| Fewer than 2 competitors can be identified | Set `competitive_intensity` to `"low"`, note in narrative that the market is early-stage or poorly documented |
| Conflicting price or distribution data across sources | Use the most recent figure from the most credible source (retailer page preferred over blog post); note the conflict in `data_gaps` |
| A brand appears in results but has no active products or is defunct | Exclude from `competitors` array; note in `data_gaps` that it was found but appears inactive |
| All 6 searches return thin results | Complete what you can, set `competitive_intensity` to `"low"`, note in narrative that competitor data is limited and this may indicate a nascent market |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] `competitors` array has at least 1 entry with `"confidence": "medium"` or higher — if not, explain in `data_gaps`
- [ ] Every competitor in the array has `name`, `positioning`, `strengths`, and `weaknesses` populated
- [ ] `market_gaps` has at least 1 entry based on evidence from search results, not assumed
- [ ] `competitive_intensity` is set and justified by the number and activity of competitors found
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
