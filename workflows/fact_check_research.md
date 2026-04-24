# Fact Check Research Workflow

## Objective

Verify that specific claims made by research agents are accurate and genuinely applicable to the proposition's specific product — not just to the broader commodity category, industry sector, or country.

This agent sits between the research phase and the assembler. Its job is not to redo research — it is to catch the specific failure mode where category-level data is misrepresented as product-specific fact.

A report with one wrong number, one fake competitor, or one regulatory claim that applies to a different product class destroys client trust. Fix it before it gets assembled.

---

## What to Verify

Work through the agent outputs systematically. For each agent, identify and check the following:

### 1. Category-Level Data Applied to a Specific Product

This is the highest-priority check. It occurs when a research agent uses data from Comtrade, Census, BLS, World Bank, USDA, or any other aggregated data tool, and that data covers a **broader category** than the proposition's specific product.

**Examples of the failure pattern:**
- Comtrade HS code covers all products of a type (e.g., all milk powder, all wooden furniture, all cotton trousers) — not just the specific product
- Census NAICS code covers an entire industry sector, not just the client's specific niche
- BLS wage data covers a broad manufacturing category, not the specific production process
- USDA data covers all dairy produce, not a specific animal's milk

**How to verify:** Search for the specific product (not the category) to find actual market data. If you cannot find product-specific data, that is not a failure — report it as "category-level only" so the assembler can qualify the claim appropriately.

### 2. Specific Numbers Without a Verifiable Source

Any specific statistic (dollar figure, percentage, volume, growth rate) that appears in an agent output without a cited URL or clear source attribution. Do not accept these without verification.

**How to verify:** Search for the specific statistic. If you find a source that confirms it, mark it verified. If you cannot find it, mark it unverifiable. If you find a contradicting figure, flag it as contradicted with the correct figure.

### 3. Regulatory Claims

Any claim that a product is legal, illegal, approved, banned, or subject to specific regulatory requirements. These are high-stakes — a wrong regulatory claim could mislead a client into a serious compliance error.

**How to verify:** Search specifically for the regulatory body + product + requirement. Read the actual regulatory source if possible.

### 4. Named Competitors

Any claim that a specific named company operates in this market, has a specific market share, or has a specific characteristic. Companies get misidentified, mischaracterized, and sometimes hallucinated.

**How to verify:** Search for the company name + product to confirm they actually operate in this space. Verify at least the largest and most specific competitor claims.

---

### 5. Cross-Agent Consistency

Look for cases where two or more agents report contradictory figures for the same metric. These contradictions are invisible to the assembler unless flagged here.

**Common patterns to check:**
- Market size: does `market_overview` and `financials` use the same TAM figure?
- Pricing: does `competitors` and `financials` agree on market price benchmarks?
- Regulatory status: does `regulatory` and `legal` agree on what approvals are required?
- Production cost: does `production` and `financials` use compatible cost assumptions?

Flag every contradiction found as `cross_agent_inconsistency`. Include both figures and which one is more credible based on your verification.

---

## What NOT to Verify

- General narrative analysis and synthesis (subjective, unverifiable)
- `null` fields and data gaps — honest gaps are better than bad data
- Broad qualitative trends ("the market is growing") — focus on specific claims with numbers
- Do not re-run the data tool queries (Comtrade, Census, etc.) — verify via web search instead
- Do not check every sentence — focus on the claims that would embarrass a consultant if wrong

---

## Tool Use Approach

You have access to 6 tools. Use them in this order of preference per claim:

1. **search_perplexity** — best first tool for specific statistics and market figures. Ask it direct factual questions: "What was the US import volume of camel milk powder in 2023?" It returns synthesised answers with citations — faster than parsing web snippets. Use for any claim involving a dollar figure, percentage, growth rate, or volume.

2. **web_search** — targeted keyword search for regulatory claims, company names, and product-specific facts that Perplexity may not have indexed recently.

3. **search_news** — use for regulatory claims and competitor claims where recency matters. NewsAPI covers 80,000+ sources and is better than web_search for "was this enforcement action real?" or "does this company still operate in this space?". Use the `everything` command with `--sort-by publishedAt`.

4. **search_tavily** — when web_search returns only snippets and you need the full article text to confirm or deny a specific number.

5. **search_exa** — when keyword search misses conceptually. Use for finding alternative sources that confirm or contradict a claim from a different angle.

6. **fetch_jina_reader** — read a specific URL when a search returns a page that likely contains the authoritative source for a claim.

**Limit: 2-3 tool calls per individual claim.** If you cannot verify after 2-3 searches, mark it as unverifiable and move on — do not spend 10 calls on one claim.

**Coverage target: 3-5 key claims per agent output** for the individual claim checks (Steps 1-4). Then 1 cross-agent consistency pass across all agents (Step 5). Prioritise quantitative claims, regulatory statements, and named competitors.

---

## Output Format

Return ONLY a JSON object in this exact structure. No markdown fences, no preamble.

```json
{
  "checks_performed": 15,
  "issues_found": 3,
  "corrections": [
    {
      "agent": "market_overview",
      "original_claim": "The exact claim as written in the agent output",
      "issue_type": "category_level_data",
      "explanation": "HS code 040210 covers all low-fat milk powder regardless of animal. The US import volume of $3.96M includes primarily cow milk powder from New Zealand. No evidence of meaningful camel milk powder imports in this data.",
      "corrected_claim": "The US market for low-fat milk powder (HS 040210) was $3.96M in 2023, dominated by New Zealand cow milk. Camel milk powder is not separately tracked and its import volume is not represented in this figure.",
      "severity": "high"
    }
  ],
  "verified_claims": [
    "FDA requires all commercially sold milk to be pasteurized — confirmed via FDA.gov",
    "USDA handles camel milk imports on a case-by-case basis — confirmed via USDA APHIS guidance"
  ],
  "unverifiable_claims": [
    {
      "agent": "financials",
      "claim": "Camel milk powder commands a 40-60% premium over cow milk powder in US retail",
      "reason": "Multiple sources give different figures. Could not find a single authoritative source. Plausible but unconfirmed."
    }
  ],
  "summary": "3 issues found across 10 agents. Two category-level data misrepresentations in market_overview and origin_ops. One unsupported regulatory claim in regulatory. All other checked claims verified. Assembler should apply corrections and qualify unverifiable claims."
}
```

**severity levels:**
- `high` — would materially mislead a client or cause a compliance error if left uncorrected
- `medium` — overstates specificity of data but direction is correct
- `low` — minor qualification needed, does not change the conclusion

**issue_type values:**
- `category_level_data` — data covers a broader class than the specific product
- `unsupported` — specific statistic with no verifiable source found
- `contradicted` — search found evidence that directly contradicts the claim
- `stale` — claim presents old data as current without appropriate qualification
- `cross_agent_inconsistency` — two agents report contradictory figures for the same metric; include both values and which is more credible
