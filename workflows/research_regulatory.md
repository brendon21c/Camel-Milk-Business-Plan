# Workflow: Research Regulatory Landscape

**Agent tier:** Haiku by default. Escalate to Sonnet if the regulatory picture is complex, ambiguous, or the origin country's status is unclear. Escalate to Opus only if Sonnet results are poor quality.  
**Cache TTL:** 14 days (regulatory rules change slowly — re-run if a policy change is suspected)  
**Report section:** 6 — Regulatory Landscape  
**Output:** JSON written to `agent_outputs` table via `db.js`

---

## Objective

Research the regulatory environment governing the import and sale of the proposition's
product in the target country. Produce a structured summary covering import requirements,
required certifications, labeling rules, permitted and prohibited health claims, food
safety standards, origin country restrictions, and any pending regulatory changes.

This workflow is generic. All proposition-specific details (product, country, demographic)
come from the inputs — do not hard-code anything about specific products or countries.

**High-stakes flag:** If the origin country appears on any import restriction or ban list,
this must be surfaced immediately and prominently in both `import_requirements` and
`regulatory_risks`. Do not bury it.

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

#### Domestic vs. Import Check

**Before running queries:** Check if `origin_country == target_country`. If yes, this is a **domestic product** — follow the Domestic Path below. If no, follow the Standard (Import) Path.

---

#### Standard (Import) Path

Execute the following 6 searches using `tools/search_brave.py`. Replace bracketed
placeholders with values from your inputs. Run them sequentially — do not skip any.

```
python tools/search_brave.py --query "[product_type] import regulations [target_country] federal agency requirements [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] safety standards labeling requirements [target_country] [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] marketing claims allowed prohibited regulatory agency [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "[origin_country] import restrictions banned [target_country] [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] import certification requirements [target_country] organic halal food safety" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] regulatory changes pending [target_country] [current_year]" --count 10 --freshness 336
```

---

#### Domestic Path

Use these 6 queries instead when `origin_country == target_country`. No import restrictions, country-of-origin flags, or customs import alerts apply — focus on domestic safety and compliance law, state-level rules, and domestic certifications.

```
python tools/search_brave.py --query "[product_type] domestic regulatory requirements [target_country] [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] state-level regulations [target_country] compliance [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] domestic labeling requirements regulatory agency [target_country] [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] domestic certifications [target_country] [industry] [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] marketing claims allowed prohibited regulatory agency [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "[product_type] regulatory changes pending [target_country] [current_year]" --count 10 --freshness 336
```

**Rate limiting:** `search_brave.py` enforces a 500ms delay between calls automatically.
Do not add extra delays — the tool handles it.

#### Fallback Queries

> **Fallback rule:** If any primary query returns fewer than 3 results with substantive, usable information, run the corresponding fallback queries below before moving to the next topic.

**Primary 1:** `[product_type] import regulations [target_country] federal agency requirements [current_year]`
```
python tools/search_brave.py --query "[product_type] import rules [target_country] customs entry requirements" --count 10 --freshness 336
python tools/search_brave.py --query "[industry] imported products [target_country] federal requirements" --count 10 --freshness 336
```

**Primary 2:** `[product_type] safety standards labeling requirements [target_country] [current_year]`
```
python tools/search_brave.py --query "[product_type] regulatory compliance labeling rules [current_year]" --count 10 --freshness 336
python tools/search_brave.py --query "[industry] labeling requirements [target_country]" --count 10 --freshness 336
```

**Primary 3:** `[product_type] marketing claims allowed prohibited regulatory agency [target_country]`
```
python tools/search_brave.py --query "[product_type] marketing claims regulatory guidance [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "[industry] marketing claims regulatory rules permitted [target_country]" --count 10 --freshness 336
```

**Primary 4:** `[origin_country] import restrictions banned [target_country] [current_year]`
```
python tools/search_brave.py --query "[origin_country] import alert [product_type] [target_country]" --count 10 --freshness 336
python tools/search_brave.py --query "[origin_country] trade sanctions exports [target_country] restrictions" --count 10 --freshness 336
```

**Primary 5:** `[product_type] import certification requirements [target_country] organic halal food safety`
```
python tools/search_brave.py --query "[product_type] third-party certification [target_country] required documentation" --count 10 --freshness 336
python tools/search_brave.py --query "[industry] import compliance certifications [target_country] accreditation" --count 10 --freshness 336
```

**Primary 6:** `[product_type] regulatory changes pending [target_country] [current_year]`
```
python tools/search_brave.py --query "[product_type] new regulations proposed rule [target_country] upcoming" --count 10 --freshness 336
python tools/search_brave.py --query "[industry] policy changes [target_country] [current_year] regulatory update" --count 10 --freshness 336
```

#### Agent-Generated Queries

After running all primary and triggered fallback queries, assess the overall quality of results. If any major research area still has thin or unreliable coverage, generate up to 3 additional search queries of your own based on the proposition context and what you know is missing. Log any agent-generated queries in the `data_gaps` field so the assembler knows which areas required deeper searching.

### 1b. Supplement with Government Data Sources

After completing all Brave searches, fetch authoritative regulatory data directly from
government APIs. These produce high-confidence citations that significantly improve
the regulatory section's credibility. Run all unless a tool errors (log, continue).

**openFDA — product recalls and enforcement actions:**
```
python tools/fetch_fda_data.py --endpoint food_enforcement --search "[product_type]" --limit 20
python tools/fetch_fda_data.py --endpoint food_enforcement --search "[industry]" --limit 10
```
Use to: find if this product type has a history of FDA enforcement actions or recalls.
A clean recall record supports regulatory confidence; a history of Class I/II recalls
is a material risk that must be disclosed in `regulatory_risks`.

**openFDA — consumer adverse event reports:**
```
python tools/fetch_fda_data.py --endpoint food_event --search "[product_type]" --limit 10
```
Use to: identify reported consumer safety concerns. Useful for health claims research
and flagging product-category risks that FDA has on record.

**USDA FoodData Central — nutritional composition:**
```
python tools/fetch_usda_data.py fdc --query "[product_type]" --limit 5
```
Use to: validate nutritional claims, understand what facts panel data looks like for
this product type, and verify that health claims align with actual composition.

**Perplexity fallback (use only if Brave regulatory data is thin):**
```
python tools/search_perplexity.py --query "What are the federal import and safety requirements for [product_type] sourced from [origin_country] and sold in [target_country] in [current_year]?"
python tools/search_perplexity.py --query "What agency certifications and approval process apply to [product_type] sold in [target_country] — which regulatory body governs this product category?"
```
Use when: Brave returned fewer than 3 results with specific regulatory requirements.
Perplexity returns synthesized regulatory summaries with cited sources.

**CBP import compliance checklist (run for ALL import propositions where origin != target):**
```
python tools/fetch_cbp_data.py requirements [product_category] --origin [origin_country]
```
Product category options: food, furniture, electronics, apparel, medical_device, cosmetics.
Use to: surface the full CBP import compliance checklist — agencies, required documents, certifications, and any country-specific notes (Section 301 tariffs, AGOA eligibility, etc.).

**FTC marketing claim rules (run based on proposition type):**

For food, beverage, or health products:
```
python tools/fetch_ftc_data.py guidance health_claims
python tools/fetch_ftc_data.py guidance food_labelling
```

For apparel or textile products:
```
python tools/fetch_ftc_data.py guidance textile_labelling
```

For any product with sustainability/eco claims:
```
python tools/fetch_ftc_data.py guidance green_environmental
```

For any product with "Made in USA" claims:
```
python tools/fetch_ftc_data.py guidance made_in_usa
```

Use to: establish the FTC marketing claim boundaries that will constrain how the product can be marketed in the US. This directly affects the marketing section.

**CPSC product safety (run for all physical consumer product propositions):**
```
python tools/fetch_cpsc_data.py recalls --query "[product_type]"
python tools/fetch_cpsc_data.py standards [product_type_category]
```
Product category options: furniture, electronics, food, toys, apparel, kitchen, medical.
Use to: check if this product category has a history of recalls and identify which safety standards apply. A recall history is a material regulatory risk.

**Medical device propositions only:**
```
python tools/fetch_fda_device_data.py clearances "[device_type]" --limit 10
python tools/fetch_fda_device_data.py recalls "[device_type]" --limit 10
```
Use to: find predicate devices cleared under 510(k) and any recall history for this device type.

**Electronics/chemicals/software with export implications:**
```
python tools/fetch_bis_data.py eccn [product_type]
python tools/fetch_bis_data.py screening [origin_country]
```
Use to: identify ECCN classification and any export control concerns for the origin country.

**EU market propositions only:**
```
python tools/fetch_rapex_data.py summary [product_category]
```
Product category options: furniture, electronics, clothing_apparel, food, toys, cosmetics.
Use to: understand EU safety alert patterns and regulatory scrutiny level for this product category in the EU market.

### 1c. Multi-Engine Research Layer (Required)

Run all four tool types below on every run. Each serves a different purpose and together they surface content that Brave and official APIs alone cannot reach.

**Required — two Perplexity synthesis queries:**
Perplexity returns a cited, AI-synthesised factual answer — not a list of links to parse. Use it for direct factual questions where Brave returns ten blog posts instead of a clear answer. Ask in plain English, as if briefing an analyst. Replace all bracketed placeholders with your actual input values.
```
python tools/search_perplexity.py --query "What are the complete federal regulatory requirements for importing and selling [product_type] from [origin_country] in [target_country] in [current_year], including required approvals, testing standards, and labeling rules?"
python tools/search_perplexity.py --query "What is the step-by-step process and realistic timeline for a new [industry] company to obtain all required import permits and safety approvals to sell [product_type] in [target_country]?"
```

**Required — two Exa semantic searches:**
Exa finds conceptually related content even when exact keywords are absent. Use `--type deep` for regulatory questions — official guidance and rule text are exactly what deep retrieval surfaces.
```
search_exa search "[regulatory and safety requirements for this product category imported into the target country]" --type deep --count 5
search_exa search "[recent regulatory changes, enforcement actions, or compliance issues for this product type in the target country]" --type deep-lite --count 5 --category news
```

**Required — one Tavily deep research call:**
Tavily fetches full article text and synthesises an answer across sources. Use the `research` command for the most important regulatory requirement you found — get the full rule text or official guidance, not a summary snippet.
```
search_tavily research "[specific question for the key regulatory requirement you need full context on]" --count 5
```

**Required — Jina batch read of top source URLs:**
After all other searches are complete, identify the 3 most data-rich URLs from any source (Brave result, Exa result, Perplexity citation, official API output). Prioritise official government or regulatory body pages. Fetch their full content to extract detail that snippets cut off.
```
fetch_jina_reader read "[url1]"
fetch_jina_reader read "[url2]"
fetch_jina_reader read "[url3]"
```

### 2. Extract and Synthesise

From the search results, extract the following. Pull concrete details wherever available.
If a rule or requirement has a source URL, note it — it will be saved separately as a citation.

| Field | What to look for |
|---|---|
| `import_requirements` | Entry permits, prior notice requirements, FDA registration, customs classification (HS code), and — critically — whether the origin country is on any restricted or banned list |
| `certifications_required` | Each certification by name, the issuing body, and whether it is mandatory or recommended |
| `labeling_requirements` | Mandatory label elements (ingredients, net weight, country of origin, allergen disclosures, nutrition facts panel, etc.) |
| `health_claims` | Which claims are explicitly allowed and which are prohibited or require pre-approval |
| `food_safety_standards` | Applicable standards the product must meet (e.g. HACCP, pasteurisation requirements, pathogen limits, moisture content for powders) |
| `regulatory_risks` | Any identified risk that could block or complicate import or sale |
| `pending_changes` | Proposed rules, open comment periods, or known upcoming changes that could affect the business |
| `overall_regulatory_complexity` | Your assessment: low / medium / high |
| `data_gaps` | Any fields above where you could not find reliable or current information |

### 3. Assess Origin Country Status

Before proceeding to output formatting, explicitly check whether the origin country
appears in any of the following:

- US import alert lists (FDA Import Alerts for food/drug/device; CBP admissibility for all goods)
- Agency-specific restrictions for this product type (e.g. USDA for food/agriculture, CPSC for consumer products, FCC for electronics)
- OFAC sanctions lists or State Department trade restrictions
- Any product-specific import ban for this origin country

If the origin country is flagged on any list, set `banned_or_restricted` to `true` and
populate `restriction_details` with the specifics. This is the single highest-stakes
finding in this workflow — do not understate it.

### 4. Assess Confidence

For each major field, note whether the data is:
- **High** — specific rule or requirement cited from FDA, USDA, FTC, or equivalent government source
- **Medium** — directionally accurate but from a trade publication, law firm summary, or slightly dated source
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
  "agent_name": "research_regulatory",
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
  "agent_name": "research_regulatory",
  "url": "<source url>",
  "title": "<page title if available>",
  "retrieved_at": "<ISO timestamp>"
}
```

---

## Output Format

```json
{
  "section": "regulatory_landscape",
  "generated_at": "<ISO timestamp>",
  "import_requirements": {
    "banned_or_restricted": true,
    "restriction_details": "<describe any bans, alerts, or restrictions — null if none found>",
    "prior_notice_required": "<yes / no / unknown>",
    "federal_registration_required": "<yes / no / unknown — e.g. FDA facility registration for food/drug, FCC certification for electronics, N/A for domestic-only businesses>",
    "hs_code": "<harmonised system code for this product type or null>",
    "other_entry_requirements": "<free text or null>",
    "confidence": "high | medium | low"
  },
  "certifications_required": [
    {
      "name": "<certification name>",
      "issuing_body": "<e.g. FDA, USDA, third-party certifier>",
      "mandatory": true,
      "notes": "<any conditions or caveats>"
    }
  ],
  "labeling_requirements": [
    {
      "requirement": "<e.g. Nutrition Facts panel>",
      "governing_body": "<e.g. FDA>",
      "mandatory": true,
      "notes": "<any conditions or caveats>"
    }
  ],
  "health_claims": {
    "allowed": [
      "<claim 1>",
      "<claim 2>"
    ],
    "prohibited": [
      "<claim 1>",
      "<claim 2>"
    ],
    "confidence": "high | medium | low"
  },
  "product_safety_standards": [
    {
      "standard": "<e.g. HACCP, pasteurisation requirement>",
      "governing_body": "<e.g. FDA, USDA>",
      "notes": "<specific thresholds or conditions if known>"
    }
  ],
  "regulatory_risks": [
    {
      "risk": "<description of the risk>",
      "likelihood": "low | medium | high",
      "impact": "low | medium | high"
    }
  ],
  "pending_changes": [
    {
      "change": "<description of proposed or pending rule>",
      "expected_date": "<date or 'unknown'>",
      "potential_impact": "<how this could affect the business>"
    }
  ],
  "overall_regulatory_complexity": "low | medium | high",
  "narrative_summary": "<3–5 sentence plain-English summary of the regulatory landscape. Written for the report. No bullet points, no jargon. If the origin country is banned or restricted, this must be stated plainly in the first sentence.>",
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
| Origin country ban status is unclear from search results | Set `banned_or_restricted` to `null`, note it in `data_gaps` as high-priority, and flag it explicitly in `regulatory_risks` with `likelihood: "unknown"` and `impact: "high"` |
| Conflicting information from different sources | Use the most authoritative source (official government pages over trade press); note the conflict in `data_gaps` |
| Regulatory information is outdated (>12 months old) | Use it but set confidence to `"low"` and note the age in `data_gaps` |
| Product falls into an ambiguous regulatory category | Note the ambiguity in `regulatory_risks` and `data_gaps`; recommend the operator seek legal counsel |
| All 6 searches return thin results | Set `overall_regulatory_complexity` to `"unknown"`, note in narrative that regulatory data was limited, complete what you can, escalate agent tier to Sonnet |
| `origin_country == target_country` | Follow Domestic Path in Step 1. Skip all export/import/cross-border fields in output. Populate domestic equivalents instead. |
| DB write fails | Log the error to stderr, return the JSON output to the orchestrator directly so the run isn't lost |

---

## Quality Bar

Before saving output, verify:
- [ ] `narrative_summary` is present and written in plain English (no bullet points, no jargon)
- [ ] If `banned_or_restricted` is `true`, the narrative summary states this plainly in the first sentence
- [ ] `certifications_required` has at least 1 entry (or an explicit note in `data_gaps` explaining why none were found)
- [ ] `labeling_requirements` has at least 2 entries
- [ ] `regulatory_risks` has at least 1 entry
- [ ] `overall_regulatory_complexity` is set to one of: `low`, `medium`, `high`, or `unknown`
- [ ] `sources` has at least 8 URLs — aim for 10+. Each search query should contribute at least 1 cited source
- [ ] No field contains raw search result HTML or markdown — synthesised text only
