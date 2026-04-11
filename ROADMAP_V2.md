# Product Roadmap — Business Viability Intelligence System

**Author:** Brendon McKeever  
**Last updated:** 2026-04-10 (social media research added to V3)

---

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| V1 | Physical import/export — any product, food-biased gov data | In progress (end-to-end test next) |
| V2 | Any physical product, any industry — adaptive research | Planned |
| V3 | General business ventures — SaaS, services, digital, franchise | Future |

The foundation (WAT architecture, agent pipeline, PDF delivery) carries through all phases unchanged. Each phase adds capability on top without rebuilding from scratch.

---

## V1 — Physical Import/Export (Current)

**Scope:** Physical goods moving from an origin country to a target market. First proposition: camel milk powder, Somalia → US.

**What works for any physical product:**
- All 10 research agents (market, competitors, regulatory, production, packaging, distribution, marketing, financials, origin ops, legal)
- Brave Search + Perplexity (general-purpose — industry-agnostic)
- SEC EDGAR, USASpending, Census (industry-agnostic government data)
- Venture intelligence + landscape briefing (makes agents adapt to the venture type)
- PDF report, Supabase Storage, Resend email delivery

**What is food/agriculture biased:**
- `fetch_fda_data.py` — FDA food enforcement + adverse events (food/drug only)
- `fetch_usda_data.py` — USDA FoodData Central + NASS QuickStats (agriculture only)
- Regulatory workflow Step 1b — explicitly calls FDA/USDA

**Current workaround:** The venture intelligence brief tells agents which agencies are relevant. A solar-panel proposition gets DOE/EPA framing from the brief; agents naturally skip FDA/USDA calls. This works but is not structurally enforced.

**Remaining task:** End-to-end test.
```
node run.js --proposition-id 54f51272-d819-4d82-825a-15603ed48654 --force
```

---

## V2 — Any Physical Product, Any Industry

**Goal:** A client with any physical-goods idea (solar panels, apparel, medical devices, electronics, cosmetics, industrial equipment) gets a complete viability analysis with the right data sources for their industry — without any manual workflow changes.

### Key changes required

#### 1. Industry-aware government data routing

Replace the flat `executeTool` switch statement with a routing layer that selects the right gov APIs based on the proposition's industry:

| Industry category | Relevant gov sources |
|---|---|
| Food / beverage | FDA (openFDA), USDA FoodData Central, USDA NASS |
| Agriculture / commodities | USDA NASS, USDA ERS, FDA |
| Energy / clean tech | DOE (NREL, EIA), EPA, ITC |
| Medical devices / health | FDA (device enforcement), CMS, NIH |
| Chemicals / materials | EPA, OSHA, TSCA |
| Electronics / tech hardware | FCC, ITC, BIS (export controls) |
| Apparel / textiles | CBP, FTC (labelling), CPSC |
| Cosmetics / personal care | FDA cosmetics, CPSC |
| General manufacturing | EPA, OSHA, ITC, Census CBP |
| All categories | SEC EDGAR, USASpending, Census (always included) |

Implementation: add an `industry_category` field to propositions. The `executeTool` dispatcher checks this field and routes to the correct Python scripts. Non-applicable tools return a structured "not applicable" response so agents don't waste iterations.

#### 2. New government data tools (build as needed per industry)

| Tool | Source | Priority |
|---|---|---|
| `fetch_doe_data.py` | DOE EIA energy statistics, NREL clean energy data | High (energy/solar) |
| `fetch_epa_data.py` | EPA regulatory database, enforcement actions | High (chemicals, manufacturing) |
| `fetch_fda_device_data.py` | FDA 510(k) clearances, device recalls | High (medical) |
| `fetch_itc_data.py` | ITC trade remedy cases, import injury reports | Medium (any import) |
| `fetch_bls_data.py` | BLS industry employment, wage benchmarks | Medium (labour cost research) |
| `fetch_bis_data.py` | BIS export control classifications (ECCN) | Medium (tech/defence-adjacent) |

#### 3. Proposition intake enrichment

Add `industry_category` to the intake CLI and DB schema:
```
node tools/intake.js --name "..." --email "..." --product "Solar panels" \
  --industry-category "energy" --origin "China" --target "US"
```

New migration: `006_add_industry_category.sql`
```sql
ALTER TABLE propositions ADD COLUMN industry_category TEXT;
```

#### 4. Workflow generalisation

Audit the 10 research workflows and remove food-specific language. The regulatory workflow's Step 1b should reference the `industry_category` to pick the right tool calls, rather than hardcoding FDA/USDA.

Option A (simpler): Keep workflows generic, rely on venture intelligence brief to steer tool selection.  
Option B (more robust): Add an `industry_category` substitution block at the top of each workflow that lists the applicable gov tools for this run.

Recommendation: Start with Option A (already partially working via venture intelligence) and move to Option B if Option A produces poor results for non-food industries.

#### 5. Consultant Intelligence Brief (admin-only)

**What it is:** A private, candid debrief generated from the same research data as the client report — sent only to Brendon after every successful run. Not polished. Not filtered for the client. Written like a smart colleague briefing you before a meeting.

**Why it matters:** Delivering a report is a data transfer. Consulting is knowing what the data means for *this client*, what they should really be worried about, and what questions to ask them. This brief is how you build that skill — every run gives you a private analytical layer to study and eventually internalize.

**When it runs:** After the main report is generated and delivered. Uses the same `agent_outputs` already in the DB — no additional API calls to research agents. One new Sonnet call.

**What it contains:**

| Section | Description |
|---|---|
| Plain-language summary | What this business actually is and what the data shows, in 2–3 paragraphs. No jargon. |
| The real story | What stands out in the research — the 2–3 findings that actually matter for whether this works |
| Opportunities to surface | Things the data hints at that the client may not have considered — angles worth bringing up |
| Challenges to flag | Red flags, structural risks, or market realities the client needs to hear directly |
| Where the data was thin | Research gaps and what that uncertainty means for confidence in the analysis |
| Independent research ideas | Things Brendon can investigate himself that the system can't automate — industry contacts, on-the-ground checks, expert calls |
| Questions to ask the client | Conversation starters for a follow-up — gaps in their thinking, assumptions to pressure-test |
| Honest viability take | Brendon's internal read: would you put money into this? What would need to be true for it to work? |

**Tone:** Direct and candid. Written to Brendon, not to the client. Should read like a trusted analyst telling you what they actually think, not what they'd put in a formal document.

**Implementation:**
- New workflow: `workflows/assemble_consultant_brief.md`
- New function in `run.js`: `runConsultantBriefAgent()` — called after `sendAdminReportCopy()`
- New script: `tools/generate_consultant_brief_pdf.py` — separate PDF generator with distinct visual treatment
- Model: Claude Sonnet (same as assembler — synthesis, not research)
- Input: all 10 `agent_outputs` + assembled report content JSON + viability score + confidence score
- Output: branded PDF — same McKeever Consulting brand but visually distinct (e.g. dark header marked "Internal / Confidential", different accent treatment so it's immediately clear this is not the client document)
- Delivery: Resend email to `ADMIN_EMAIL` only with PDF attached, subject: `[Internal] Consultant Brief — {client name} — {month}`
- Stored: uploaded to Supabase Storage alongside the client report (`{proposition_id}/{reportId}_consultant_brief.pdf`) so it's retrievable per run

**Why PDF over email body:** This is a working document — something to open alongside the client report before a meeting, annotate, pull talking points from, and reference on a call. It should live as a file, not in an inbox.

**Wishlist:** Consolidate the two admin emails into one. Instead of receiving the client report copy and the consultant brief as separate emails, send a single admin email with both PDFs attached — the client report and the consultant brief together. One email to open, both documents ready to review side by side. Resend supports multiple attachments so this is straightforward when implementing.

**Note:** This feature doesn't depend on industry routing and could technically be backported to V1. Scoped to V2 because V1's priority is proving the core pipeline works first.

#### 6. Prompt caching on the assembler

**Why:** The assembler sends the full research context (~150k tokens) to Sonnet once per section — 15 calls per run. Without caching, this costs ~$7.65 in input tokens alone, roughly 65% of total run cost. With prompt caching, subsequent calls pay the cached rate ($0.30/MTok vs $3.00/MTok), dropping assembler cost to ~$2. Saving of ~$5 per run.

**Must be in place before V3.** V3 ventures (SaaS, services, digital) will produce larger and more varied agent outputs, making the context window even heavier. Caching becomes more valuable, not less, as the system scales.

**Implementation:** Add explicit `cache_control: { type: "ephemeral" }` breakpoints to the assembler's API calls in `run.js`:
- Mark the `system` prompt as cacheable (shared across all 15 section calls)
- Mark the `researchContext` block as cacheable (same content across all 15 calls, changes only between runs)
- Anthropic's SDK requires these markers to be set on the relevant content blocks in `messages` — the large block that doesn't change call-to-call is the right place

**Expected savings:** ~$5 per run (~40% total cost reduction). At retainer pricing ($150/month), this makes each run margin-positive without any pricing change.

**Note:** Verify the 5-minute cache TTL fits the inter-section delay (currently 20s). It does — 15 sections × 20s = 300s = exactly 5 minutes. Consider reducing the inter-section delay slightly (e.g. 18s) to stay safely within the TTL window if needed.

#### 7. Test propositions to validate V2

| Proposition | Industry category | Key non-food tools needed |
|---|---|---|
| Solar panels, China → US | energy | DOE EIA, EPA, ITC |
| Apparel / activewear, Bangladesh → US | apparel | CBP, FTC, CPSC |
| Medical diagnostic device, Germany → US | medical | FDA device, CMS |
| Consumer electronics, Taiwan → US | electronics | FCC, BIS, ITC |

---

## V3 — General Business Ventures

**Goal:** Any business idea — SaaS, services, digital products, franchises, marketplaces — gets a tailored viability analysis with the right research dimensions for that venture type.

### Why V3 is a separate phase

Physical products share a common research spine: supply chain, regulatory import path, production, distribution, packaging. The 10-agent set maps cleanly onto this.

Non-physical ventures need different dimensions:
- **SaaS:** TAM/SAM/SOM, pricing benchmarks, churn/LTV/CAC, competitive feature matrix, integration ecosystem, developer tools landscape — no supply chain, no import regulatory path
- **Services business:** Labour market, licensing/credentialing, client acquisition, capacity model, geographic territory — no product manufacturing
- **Marketplace / platform:** Network effects, liquidity strategy, take-rate benchmarks, regulatory (payments, data, gig economy) — fundamentally different unit economics
- **Franchise:** Brand strength, territory analysis, FDD review, unit-level P&L benchmarks, support quality — requires franchise-specific data sources

### Key changes required for V3

#### 1. New workflow sets per venture type

Each venture type needs its own set of research workflows. The agent names may change (e.g. `research_acquisition.md` instead of `research_origin_ops.md` for a SaaS).

| Proposition type | Core research dimensions |
|---|---|
| `saas_software` | Market sizing, competitive landscape, pricing, unit economics, technical feasibility, go-to-market, legal (IP/data) |
| `service_business` | Market demand, labour/credentialing, competitive landscape, pricing, client acquisition, financials, legal |
| `digital_product` | Market sizing, competitive landscape, monetisation model, distribution/platform, marketing, financials, legal |
| `franchise` | Brand strength, territory analysis, FDD review, unit economics, support quality, legal |
| `marketplace` | Liquidity strategy, network effects, take-rate, regulatory (payments/gig), competitive, financials |

#### 2. Dynamic agent selection

Not all 10 agents are relevant for every venture type. V3 introduces an agent manifest per proposition type:

```javascript
const AGENT_MANIFEST = {
  physical_import_export: ['market_overview', 'competitors', 'regulatory', 'production',
                           'packaging', 'distribution', 'marketing', 'financials', 'origin_ops', 'legal'],
  saas_software:          ['market_overview', 'competitors', 'regulatory', 'pricing',
                           'unit_economics', 'go_to_market', 'technical', 'financials', 'legal'],
  service_business:       ['market_overview', 'competitors', 'regulatory', 'labour',
                           'pricing', 'acquisition', 'financials', 'legal'],
};
```

`runResearchAgents()` reads the manifest for the proposition type and only runs the relevant agents.

#### 3. New data sources for non-physical ventures

| Source | Venture types | Notes |
|---|---|---|
| Crunchbase (paid) | SaaS, marketplace | Funding data, competitive landscape |
| G2 / Capterra | SaaS | User reviews, competitive positioning |
| SBA loan data | All SMB | Small business benchmarks |
| BLS Occupational Employment | Services | Labour cost benchmarks |
| App store analytics | Digital product | Download/revenue estimates |
| FTC franchise data | Franchise | FDD filings, enforcement history |

#### 4. Proposition intake for V3

The intake form needs to capture the right metadata per venture type. A SaaS proposition needs target customer segment, pricing model, and technical stack — not origin country and product weight.

Likely implementation: `intake.js` branches on `--proposition-type` and prompts for the relevant fields.

#### 5. Social media research and analysis

Add a dedicated social media intelligence layer to the marketing agent — moving beyond web-search-based influencer lookups to direct API access for live data, client account audits, and trend signals.

**Three use cases this unlocks:**
- **Influencer discovery:** Find and score candidate creators by niche, audience size, engagement rate, and platform — not just names scraped from web results
- **Client social media audit:** Pull a client's own account metrics (follower growth, top content, reach, engagement) and benchmark against competitors or industry norms
- **Trend research:** Surface rising topics, hashtags, and content formats in a niche before they peak — useful for content strategy advice

**Platform priority and build order:**

| Priority | Platform | API | Notes |
|---|---|---|---|
| 1 | YouTube | YouTube Data API v3 | Already have API key. Channel search, subscriber counts, video performance, trending by category. Highest data quality of any platform. |
| 2 | Reddit | Reddit API (PRAW) | Free, no approval needed. Best signal for community trends and micro-influencer discovery. Health/food niches are very active. |
| 3 | Instagram | Meta Graph API | OAuth per client. Excellent for owned-account analytics (reach, impressions, top posts). Competitor/influencer research is restricted — client's own account only without special access. |
| 4 | TikTok | TikTok Research API + Business API | Apply for Research API access early — approval takes time but is obtainable for business tools. Good for trend discovery and owned-account analytics. |
| 5 | Pinterest | Pinterest API v5 | Free with app registration. Relevant for food/health/lifestyle clients — drives high purchase intent. |
| 6 | X (Twitter) | X API v2 | Low priority. Basic tier is $100/mo with limited read access. Only worth it if a specific client's audience lives on X. |

**Tools to build (when ready):**
- `tools/search_youtube_influencers.py` — search channels by keyword/topic, return ranked list with stats
- `tools/fetch_youtube_analytics.py` — pull owned channel metrics for a client audit
- `tools/search_reddit_trends.py` — search subreddits by niche, surface trending posts and power users
- `tools/fetch_instagram_analytics.py` — pull client's Instagram metrics via OAuth
- `tools/fetch_tiktok_analytics.py` — client TikTok account metrics + Research API trend queries
- `tools/fetch_pinterest_analytics.py` — owned account metrics and trending pin search

**Workflow changes:** `research_marketing.md` currently uses Brave Search for all influencer and trend research. When these tools exist, update the workflow to call them first and fall back to Brave only when API data is unavailable or the platform isn't supported.

**Note on Perplexity's role:** The existing `tools/search_perplexity.py` can complement direct API calls in this space. Perplexity's strength is synthesising information across many sources in natural language — it can answer questions like "who are the top 10 gut health creators on YouTube right now?" or "what TikTok trends are driving camel milk interest in 2026?" faster than assembling that picture from raw API results. The recommended pattern is: use Perplexity for **discovery and framing** (who to look at, what topics are trending, what the competitive landscape looks like), then use the platform-specific API tools for **verification and live data** (actual follower counts, engagement rates, recent content). This keeps Perplexity in a reasoning role and the APIs in an execution role — consistent with the WAT architecture.

---

## Web App — Post-V2 Phase

**Timing:** After V2 is complete and validated.

### Project structure decision (evaluate before starting)

> **The web app should likely be a separate project that connects to this one — not built into this repo.**

This pipeline is a backend report engine: it runs on a schedule or on-demand, calls APIs, and delivers PDFs. A web app is a different concern — client intake, admin dashboard, status tracking, report viewing. Mixing them risks bloating this repo and making both harder to maintain.

**Recommended approach:** New project (e.g. `mckeever-consulting-web`) that talks to this engine via:
- **Supabase** as the shared data layer (propositions, reports, clients already live there — the web app reads/writes the same DB)
- **A trigger mechanism** to kick off report runs (a Supabase webhook, a lightweight API endpoint in this project, or a cron that polls the DB)

This keeps the report engine clean and independently deployable. The web app becomes a front-end to the same data, not a wrapper around the engine.

**Evaluate at project start:**
- Is Supabase the right shared layer, or do we need an explicit API between the two?
- Should report runs be triggered by a DB row insert (web app writes → engine picks up) or a direct API call?
- Authentication model for the admin panel — Supabase Auth vs external provider

### MCP — evaluate for the web app phase

> **Review MCP (Model Context Protocol) before building the web app.** Do not assume the current tool architecture carries over unchanged.

**What MCP is:** Anthropic's open standard for connecting AI to external tools and data. Instead of hand-rolling tool execution (as this project does via Python subprocesses), MCP servers expose tools over a standard protocol that any compatible client can use.

**Why it may be relevant for the web app:**
- The web app will likely need Claude-powered features (report Q&A, client onboarding assistance, admin summaries)
- Rather than duplicating the tool layer, MCP servers could expose Brave Search, FDA, Census, USDA, etc. as shared services that both this pipeline and the web app consume
- MCP is gaining broad adoption (OpenAI, Google DeepMind both support it as of 2025) — likely to be a stable foundation

**What to evaluate:**
1. Is MCP mature enough and well-supported by the time we start the web app?
2. Would converting the existing Python tools to MCP servers provide enough benefit to justify the rewrite?
3. Does the web app's Claude integration benefit from shared MCP servers, or is the tool usage different enough that it doesn't matter?

**Decision rule:** If the web app needs Claude with tool access and the same tools this pipeline uses — MCP is worth it. If the web app's Claude usage is narrow (Q&A over existing report data, no external API calls) — skip MCP and keep it simple.

---

## Architectural principles that carry through all phases

1. **WAT stays intact.** Workflows → Agents → Tools. Adding a new industry or venture type means adding new workflow markdown files and optionally new tool scripts. The orchestrator (`run.js`) changes minimally.

2. **Venture intelligence scales.** The Perplexity venture intelligence brief already partially bridges the gap between phases. As new proposition types are added, the brief's framing improves the output even before dedicated workflow sets exist.

3. **Model tiers hold.** Haiku for research agents (fast, narrow), Sonnet for assembly (synthesis). Escalation to Sonnet on failure. This holds for all venture types.

4. **Delivery pipeline is unchanged.** PDF → Supabase Storage → Resend email. The report format may grow more sections, but the delivery mechanism stays the same.

5. **New propositions = new DB rows, not new code** (as much as possible). The goal in V2/V3 is that adding a new industry or venture type only requires new workflow markdown files and possibly one new tool script — not a rewrite of the orchestrator.

6. **Data retention is automated.** `agent_outputs` are purged after every run. A monthly cron runs `node tools/cleanup.js --prune --confirm` to enforce the 6-month report retention window (reports, sources, Storage files) and sweep expired `api_cache` entries (7-day TTL). Set this up once the V1 end-to-end test passes and real client data starts accumulating.

---

## Decision log

| Decision | Outcome | Rationale |
|---|---|---|
| V2 before V3 | Physical products first | Shared research spine (supply chain, regulatory, manufacturing) makes generalisation lower risk |
| Venture intelligence as bridge | Implement now, rely on it for V2 | Perplexity brief already makes agents adapt to industry — reduces workflow rewrite scope |
| Option A workflow generalisation | Start with brief-driven adaptation | Less work, test it before committing to per-industry workflow blocks |
| Industry category field | Add in migration 006 | Clean DB signal for gov tool routing — better than inferring from product description |
