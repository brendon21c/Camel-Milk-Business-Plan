# Product Roadmap — Business Viability Intelligence System

**Author:** Brendon McKeever  
**Last updated:** 2026-04-23 (Session 34 — V2 E2E confirmed complete; consultant brief cancelled)

---

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| V1 | Physical import/export — any product, food-biased gov data | ✅ Complete |
| Website | Main page, intake form, admin panel | ✅ Complete |
| V2 | Any physical product, any industry — adaptive research | ✅ Complete — E2E furniture test confirmed 2026-04-23 |
| V3 | General business ventures — SaaS, services, digital, franchise | Future |
| Existing Business Analysis | Audit + strategy report for operating businesses (after V3) | Future |

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

**Remaining task:** V2 end-to-end test — furniture manufacturing, Minnesota → US. Requires industry routing to be built first so the right gov APIs are called.

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

| Tool | Source | Status |
|---|---|---|
| `fetch_itc_data.py` | Federal Register trade remedy cases + Census annual import stats by NAICS | ✅ Built |
| `fetch_epa_data.py` | EPA ECHO facility compliance search + Toxic Release Inventory | ✅ Built |
| `fetch_bls_data.py` | BLS manufacturing wage benchmarks + employment trends (v2 API) | ✅ Built |
| `fetch_doe_data.py` | DOE EIA energy statistics, NREL clean energy data | Build before solar test proposition |
| `fetch_fda_device_data.py` | FDA 510(k) clearances, device recalls | Build before medical test proposition |
| `fetch_bis_data.py` | BIS export control classifications (ECCN) | Build before electronics test proposition |

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

#### 4. Workflow generalisation ✅ Complete (Session 33)

All 10 research workflows audited and fully generalized. Last food-specific reference (`assemble_report.md` — "influencer list + health claims") removed. Regulatory workflow Step 1b no longer hardcodes FDA/USDA. Marketing workflow FDA framing removed. All workflows now use `[product_type]`, `[industry]`, `[target_country]`, `[target_demographic]`, and `[current_year]` throughout — no proposition-specific language remains.

Option A confirmed working via NHD test run (scored 80.5/100 Moderate viability without FDA/USDA routing). Venture intelligence brief + generalized workflows is sufficient for the E2E furniture test. Option B (per-industry substitution blocks in workflow headers) remains available if Option A proves insufficient for a specific industry.

#### 5. ~~Consultant Intelligence Brief~~ — CANCELLED

Not being built. Not a service we offer. Removed from roadmap.

#### 6. Failed-run resume from saved content

**Problem:** If a run fails at the PDF step (or any post-research step), re-triggering starts completely from scratch — redoing all research agents even though the content JSON was already generated and uploaded to Supabase Storage. A 40-minute run costs full API spend again just to rebuild the PDF.

**Fix:** At the start of `run.js`, before spawning research agents, check if a `failed` report already exists for this proposition with `content_storage_path` set. If found, download that content JSON and jump straight to the PDF step — skipping all research.

**Implement alongside prompt caching** — both touch the same section of `run.js`.

#### 7. Prompt caching on the assembler

**Why:** The assembler sends the full research context (~150k tokens) to Sonnet once per section — 15 calls per run. Without caching, this costs ~$7.65 in input tokens alone, roughly 65% of total run cost. With prompt caching, subsequent calls pay the cached rate ($0.30/MTok vs $3.00/MTok), dropping assembler cost to ~$2. Saving of ~$5 per run.

**Must be in place before V3.** V3 ventures (SaaS, services, digital) will produce larger and more varied agent outputs, making the context window even heavier. Caching becomes more valuable, not less, as the system scales.

**Implementation:** Add explicit `cache_control: { type: "ephemeral" }` breakpoints to the assembler's API calls in `run.js`:
- Mark the `system` prompt as cacheable (shared across all 15 section calls)
- Mark the `researchContext` block as cacheable (same content across all 15 calls, changes only between runs)
- Anthropic's SDK requires these markers to be set on the relevant content blocks in `messages` — the large block that doesn't change call-to-call is the right place

**Expected savings:** ~$5 per run (~40% total cost reduction). At retainer pricing ($150/month), this makes each run margin-positive without any pricing change.

**Note:** Verify the 5-minute cache TTL fits the inter-section delay (currently 20s). It does — 15 sections × 20s = 300s = exactly 5 minutes. Consider reducing the inter-section delay slightly (e.g. 18s) to stay safely within the TTL window if needed.

#### 8. International & Multilingual Research Pipeline

**Goal:** When researching a market where the primary language is not English, the system should find, translate, and normalize local-language sources — not just rely on English-language coverage of that market. A UAE market analysis should pull Arabic regulatory portals and trade publications. A German market analysis should pull Bundesanzeiger filings and German trade press.

**Why it matters for accuracy:** English-language reports about foreign markets are secondhand. They summarize local news, lag by days or weeks, and reflect Western framing. Primary local-language sources carry regulatory language, consumer sentiment, and business culture that never makes it into English coverage.

**Workflow:** `workflows/international_research.md` — defines the full pipeline: keyword translation → source discovery → language detection → content translation → normalization → agent handoff.

**International data tools — status:**

| Tool | Status | Notes |
|---|---|---|
| `tools/fetch_un_comtrade.py` | ✅ Built (Session 31) | Bilateral trade flows by HS code. `bilateral` + `top_partners` commands. Key in `.env`. |
| `tools/fetch_world_bank.py` | ✅ Built (Session 30) | GDP, population, inflation, trade openness — all countries. No key. |
| `tools/fetch_gdelt_news.py` | ✅ Built (Session 30) | Global news, 170 countries, 65 languages. No key. |
| `tools/translate_text.py` | ~~DROPPED~~ | Agents translate non-English sources inline using Claude. No external API needed. |
| `tools/detect_language.py` | ~~DROPPED~~ | Agents detect language inline. |
| `tools/normalize_international_data.py` | ~~DROPPED~~ | Agents normalize inline. |
| `tools/fetch_opencorporates.py` | SKIPPED | $2,000/year for API access. Brave `site:opencorporates.com` covers the use case for free. |

**Search quality tools — status (all active, upgraded Session 33):**

| Tool | Key | What it adds |
|---|---|---|
| `tools/search_perplexity.py` | `PERPLEXITY_API_KEY` ✅ | Proactive synthesis — 2 mandatory calls per workflow. Returns AI-synthesized answers with inline citations. Called for direct factual questions where Brave returns blog posts. Uses all intake variables (product, industry, country, demographic, year) for targeted results. |
| `tools/search_exa.py` | `EXA_API_KEY` ✅ | Semantic/neural search — 2 mandatory calls per workflow. 6 depth modes: `instant` (~200ms), `fast` (~450ms), `auto` (~1s), `deep-lite` (2–10s), `deep` (5–60s, default), `deep-reasoning` (10–60s). `similar` command finds competitor/brand pages from a known URL. `category` filter: `company`, `news`, `research paper`, `financial report`, `personal site`, `people`. |
| `tools/search_tavily.py` | `TAVILY_API_KEY` ✅ | Full-text synthesis — 1 mandatory `research` mode call per workflow (upgraded from basic `search`). Fetches full article text and synthesizes an answer across sources. |
| `tools/fetch_jina_reader.py` | `JINA_API_KEY` ✅ | URL reader — mandatory 3-URL batch read per workflow (upgraded from optional single-URL). Fetches full clean markdown from the top data-rich URLs found in any prior search. |

All 10 research workflows updated with Step 1c "Multi-Engine Research Layer" — all four tools are mandatory on every run, not optional or conditional. Perplexity was previously a fallback; it is now the first synthesis layer called alongside Brave.

**International economic data APIs (all free, no key):**

| API | What it provides |
|---|---|
| World Bank Open Data | GDP, income, population, inflation, FDI — all countries |
| IMF Data API | Macroeconomic stability, inflation trajectory, government debt |
| OECD API | OECD member country stats — labour, trade, taxes |
| Eurostat API | EU statistical data — industry production, import/export |
| FAO STAT API | Global food and agriculture data — critical for food/beverage propositions |
| WTO Tariff API | Bound and applied tariff rates, all WTO members |
| GDELT Project | Global news, 170 countries, 65 languages, 15-min updates |

**Translation approach:** Agents translate non-English sources inline using Claude's native multilingual capability. No external translation API. Agents generate native-language Brave queries directly from `target_country` input. `international_research.md` documents this approach.

---

### Future — Multi-Market Parallel Research

**Goal:** A client selling into multiple markets (e.g. US + EU, or global rollout) gets a side-by-side viability analysis per market, not a blended single-market report.

**Why it's deferred:** The APIs are not the bottleneck — Eurostat, World Bank, IMF, OECD, UN Comtrade, WTO tariffs, and EU RAPEX are all available (most already built or registered). The gap is architectural: the current pipeline runs one sequential research pass against one `target_country`. Running multi-market research properly requires:

1. **Parallel research pipelines** — run all 10 agents once per market (or per regulatory region). Two markets = two full agent runs.
2. **Market comparison synthesizer** — a new assembler agent that reads results from both runs and writes a structured side-by-side comparison (regulatory burden, market size, distribution complexity, estimated cost-to-enter per market).
3. **Report format change** — sections like Regulatory, Distribution, and Market Overview need a per-market sub-structure instead of a single narrative.
4. **Intake form update** — allow clients to specify multiple target markets (already stubbed as `market_scope: 'international'` in the intake form — expand this to a multi-select when the backend is ready).

**Current handling:** Clients who select "Planning to expand internationally" get a single-market report anchored to their primary market. International expansion intent is written into `client_context` so agents can note export considerations where relevant, but no structured multi-market analysis runs.

**When to build:** After V3 is complete and the agent manifest system (dynamic agent selection per proposition type) is in place. Multi-market is essentially "run V2 twice and compare" — the infrastructure for dynamic agent sets makes parallelising straightforward.

**Test proposition for validation:**

| Proposition | Target language | Key non-English sources |
|---|---|---|
| Camel milk powder, Somalia → UAE | Arabic | UAE Ministry of Climate Change & Environment, ESMA (Emirates Authority for Standardization), Arabic trade press |

This is a natural V2 test since the current camel milk proposition targets the US (English). Running the same product against the UAE market is a clean before/after comparison.

---

#### 7. Test propositions to validate V2

| Proposition | Industry category | Key tools needed | Notes |
|---|---|---|---|
| Furniture manufacturing, Minnesota → US | general_manufacturing | ITC, EPA, BLS | **First V2 test — E2E test proposition.** US market only. Requires industry routing first. |
| Furniture manufacturing, Minnesota → US + Europe | general_manufacturing + international | ITC, EPA, BLS, UN Comtrade, GDELT | Europe version — deferred until international pipeline built |
| Solar panels, China → US | energy | DOE EIA, EPA, ITC | — |
| Apparel / activewear, Bangladesh → US | apparel | CBP, FTC, CPSC | — |
| Medical diagnostic device, Germany → US | medical | FDA device, CMS | — |
| Consumer electronics, Taiwan → US | electronics | FCC, BIS, ITC | — |
| Camel milk powder, Somalia → UAE | food_beverage + Arabic | translate_text, detect_language, GDELT, UAE sources | Arabic market — deferred until international pipeline built |

---

## V3 — General Business Ventures

**Goal:** Any business idea — SaaS, services, digital products, franchises, real estate, content creation, marketplaces — gets a rigorous viability analysis with research shaped to the specific proposition, not just its category.

### Architectural foundation: universal agents

All 10 research agents run for every proposition type. They are not product-specific roles — they ask 10 universal business questions that apply to every venture:

| Agent | Universal question |
|---|---|
| `market_overview` | What is the market and is there real demand? |
| `competitors` | Who is already doing this and how would you compete? |
| `regulatory` | What are the rules and what compliance is required? |
| `production` | What does it cost to make or deliver the thing? |
| `packaging` | How is the offering structured and presented? |
| `distribution` | How does it reach the customer? |
| `marketing` | Who specifically will buy this and what reaches them? |
| `financials` | Do the numbers work? |
| `origin_ops` | Where do inputs, supply, or operational dependencies come from? |
| `legal` | What are the legal exposures and structures required? |

For a real estate portfolio: `production` = renovation costs, `origin_ops` = deal sourcing and property pipeline, `packaging` = deal structure and lease design. For a SaaS: `production` = build cost and infrastructure, `origin_ops` = talent and vendor dependencies, `packaging` = pricing model and tier design. The questions are universal; the vocabulary adapts.

**AGENT_MANIFEST is not being built.** The routing-table approach (select which agents run per venture type) was superseded by this architecture. No agents are eliminated — they all contribute, reframed for the venture type.

### Key changes required for V3

#### 1. The `curiosity_agent` — first V3 prerequisite

The most important addition to the pipeline. Runs after the two Perplexity pre-briefings, before the 10 research agents.

**What it does:** Reads the proposition and client intake, runs one Perplexity curiosity call ("what does standard research miss about this type of proposition?"), and produces a per-agent research agenda of specific, non-obvious questions that supplement standard research. It also identifies cross-agent connections — where two agents need to address complementary sides of the same underlying question — which the assembler uses to align findings.

**Philosophy:** A smart colleague who says *"for this client specifically, also check X"* — not a manager who issues directives. Standard research is mandatory regardless. The curiosity agenda is additive.

**Model:** Opus. One bounded call. Its output cascades through all 10 agents — reasoning quality here compounds.

**Pipeline position:**
```
Perplexity venture intel brief
Perplexity landscape briefing
curiosity_agent (Opus + 1 Perplexity curiosity call)   ← NEW
10 research agents (each receives curiosity agenda as additive block)
Fact-check agent (independent — does not see curiosity agenda)
Assembler (receives full curiosity output for section alignment)
```

**Non-fatal:** If curiosity_agent fails, research agents proceed on standard workflows. No run blocked.

**Workflow file:** `workflows/curiosity_agent.md` — written and complete.

**Output schema summary:**
- `proposition_read` — how the agent interpreted this specific proposition
- `core_tension` — the single most important unknown that determines success or failure
- `cross_agent_connections` — where 2+ agents need to address complementary sides of the same issue
- `agent_agenda` — per-agent: `priority_questions`, `bear_case_question`, `watch_for`
- `agenda_confidence` + `agenda_confidence_rationale`

**Key design rules:**
- Questions must be specific and searchable — not topic areas
- `bear_case_question` required for every agent — adversarial framing enforced
- All questions framed as investigations, never assertions
- Only non-obvious questions — if standard research covers it anyway, it doesn't belong
- Minimum 2 priority questions per agent

**Admin panel review — design pending:**
The curiosity agenda should be visible in the admin panel and optionally editable by Brendon before research agents fire. Three possible workflows (pre-step trigger, mid-run pause, or next-run review) each have different UX and pipeline implications. Needs a dedicated design decision before building. See HANDOFF.md for detail.

#### 2. Make all 10 agents proposition-type aware

Each research workflow needs explicit guidance on how to reframe its universal question for non-physical venture types. The venture intelligence brief does this partially today — agents adapt based on what Perplexity tells them. The workflows need to make this explicit so agents don't default to physical-product assumptions when the proposition is a service, SaaS, or content business.

This is vocabulary adaptation, not agent replacement. `research_origin_ops.md` for a SaaS is: where does your talent come from, what are your infrastructure dependencies, what vendor lock-in risks exist? The question is the same; the research is different.

#### 3. New workflow sets per venture type (additive)

As each new venture type is tested E2E, the workflow files for agents that need significant adaptation get a venture-type-specific section. Not rewrites — additions. The physical product path remains the default; non-physical venture types get explicit handling blocks within each workflow.

| Proposition type | Key adaptation areas |
|---|---|
| `service_business` | production = delivery cost/capacity; origin_ops = talent sourcing; packaging = service tiers and contracts |
| `saas_software` | production = build cost and infrastructure; origin_ops = talent/vendor deps; distribution = go-to-market and acquisition |
| `digital_product` | packaging = monetisation model; distribution = platform and app store strategy; origin_ops = content/IP pipeline |
| `franchise` | production = unit buildout cost; origin_ops = franchisor relationship; legal = FDD review |
| `real_estate` | production = renovation cost; origin_ops = deal sourcing and property pipeline; packaging = deal structure |

#### 3. New data sources for non-physical ventures

| API | Variable | Venture Types | Notes | Action |
|---|---|---|---|---|
| **Crunchbase API** | `CRUNCHBASE_API_KEY` | SaaS, marketplace, digital | Startup funding, valuations, VC activity, competitive landscape. Best competitive intelligence source for venture-stage businesses. $29/month minimum. | data.crunchbase.com/docs |
| **SimilarWeb API** | `SIMILARWEB_API_KEY` | SaaS, digital, services | Website traffic, engagement, digital market share. Essential for digital product competitive analysis. ~$125/month. | similarweb.com/corp/developer |
| **G2 API** | `G2_API_KEY` | SaaS | Software reviews, competitive positioning, satisfaction scores. Free with app registration. | g2.com/api |
| **Reddit API (PRAW)** | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | All — especially SaaS, services, digital | Community sentiment, micro-influencer discovery, niche trend signals. Free, 60 req/min. | reddit.com/prefs/apps |
| **SBA Small Business Data** | *(no key)* | Services, franchise | Small business benchmarks, loan approvals, industry failure rates. | api.sba.gov |
| **BLS Occupational Employment** | *(uses existing `BLS_V2_API_Key`)* | Services | Wage benchmarks by occupation — labour cost modeling for services propositions. | Already active |
| **GitHub API** | `GITHUB_API_TOKEN` | SaaS (developer tools) | Repository activity, developer adoption, open-source ecosystem mapping. 5k req/hour free. | github.com/settings/tokens |
| **Product Hunt API** | `PRODUCT_HUNT_API_KEY` | SaaS, digital | Launch tracking, upvote velocity, product discovery trends. Free. | api.producthunt.com |
| **App Store (Apple)** | *(OAuth per client)* | Digital product | Client's own iOS app metrics. No competitor data available without special access. | Apple developer account |
| **Google Play Developer API** | *(OAuth per client)* | Digital product | Client's own Android app stats. | Google Play developer account |
| **FTC Franchise Data** | *(no key)* | Franchise | FDD filings, enforcement history. | FTC.gov franchise rule database |

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

## Website — Complete ✅

**Repo:** `mckeever-consulting-website` (sibling repo, deployed on Vercel)  
**Stack:** Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui + Supabase JS + Supabase Auth

**How it connects to this backend:**
- Shared Supabase project — website writes intake data, backend reads it
- GitHub Actions `workflow_dispatch` — admin panel "Run Now" calls GitHub API → fires `reports.yml` with `proposition_id` input
- Supabase Storage — PDFs uploaded by backend, retrieved via signed URL by the web app

| Page | Status |
|---|---|
| `/` | ✅ Landing page |
| `/intake` | ✅ Branching form — physical branch fully implemented, V3 types stubbed |
| `/login` | ✅ Supabase `signInWithPassword` |
| `/admin` | ✅ Dashboard — 4 stat cards |
| `/admin/propositions` | ✅ List with status badges |
| `/admin/propositions/[id]` | ✅ Full detail — params, client info, reports, RunPanel, ContextPanel, PDF download |
| `/admin/reports` | ✅ 100 most recent runs, PDF download per row |
| `/admin/clients` | ✅ Org list with status toggle, plan tier select, nested contacts |
| `/admin/clients/[id]` | ✅ Org detail |
| `/admin/settings` | ✅ Settings page |

**Decisions locked:**
- MCP ruled out (2026-04-13) — declining adoption. Tool layer stays as Python subprocesses.
- Run trigger via GitHub Actions `workflow_dispatch` — no new servers needed.
- Separate repos, shared Supabase — backend and website deploy and scale independently.

---

## Website — Phase 2 (Future Enhancements)

### Client Portal — Intake Form View & Edit

Clients currently have no way to review or update their intake answers after submission. This adds a read/edit view to the client-facing experience.

**Behaviour:**
- Client can view all their intake form answers as originally submitted
- Client can edit any field and resubmit
- Resubmission **updates the existing proposition record** — it does not create a new contact, organization, or proposition row
- A `updated_at` timestamp is written to the proposition record on every resubmission
- Brendon sees a flag in the admin panel if a proposition was updated after the last report ran (signal to consider a rerun)

**Access pattern:** Magic-link via the contract token (same mechanism as the billing support form) — no new auth needed. Linked from the report delivery email as "Update your intake answers."

**Route:** `/portal/intake?token=<contract_token>`

**DB change:** No new tables. Existing `propositions` columns are updated in-place. Add a `last_intake_updated_at TIMESTAMPTZ` column to track edits.

**What it does NOT do:**
- Does not trigger a new run automatically — that remains a manual or scheduled action
- Does not create a new proposition or duplicate the contact record

---

### Admin Panel — Intake Form View

Admins should be able to see exactly what a client answered on their intake form, directly from the client and proposition detail pages. Currently the data lives in the DB but is not surfaced in the admin UI.

**Where to add it:**
- `/admin/clients/[id]` — show intake form answers for each contact/proposition under that org
- `/admin/propositions/[id]` — add an "Intake Answers" panel alongside the existing ContextPanel

**Display format:** Read-only rendered summary of all intake fields with labels — same field names and order as the intake form. Not raw JSON. If the client has resubmitted (see Client Portal above), show both the original submission date and the last-updated date.

---

### Billing Support — Client requests + Admin inbox

Clients need a way to request invoices, request refunds, and ask billing questions without emailing directly. Admins need a single place to see and respond to all open requests.

#### Client side

There is currently no authenticated client portal — clients only interact via the intake form, the contract signing page (magic link), and the report email. Billing support can be delivered without a full portal by adding a **magic-link support form** linked from the report delivery email and the contract signed confirmation email.

| Feature | Implementation |
|---|---|
| Request invoice | Link in report email → pre-filled form with their name/email/proposition. Triggers Stripe invoice generation (Stripe has `invoices.create` + `invoices.sendInvoice` API). |
| Request refund | Form with required reason field. Creates a `support_tickets` row with `type = 'refund'`. Admin sees it, reviews, processes manually via Stripe dashboard or API. |
| Billing question | Same form, `type = 'billing_question'`. Free text. |
| Confirmation | On submit: "We received your request and will respond within 1 business day." Resend email to client confirming receipt. |

The form page lives at `/support/billing?token=<contract_token>` — uses the existing contract token for identity (no new auth needed). Token is included in the report delivery email and contract confirmation email as a "Billing help" link.

#### Admin side

New admin page: `/admin/support`

| Feature | Implementation |
|---|---|
| Inbox | List of all open tickets — client name, type, date submitted, message preview. Sorted by newest first. |
| Ticket detail | Full message, client/org/proposition context, status (open / in progress / resolved). |
| Reply | Compose and send a Resend email to the client directly from the admin panel. Reply stored as a `support_ticket_replies` row. |
| Resolve | Mark ticket resolved — removes from open queue, stays in history. |
| Invoice generation | For invoice requests: one-click button that calls Stripe `invoices.create` + `invoices.sendInvoice` and marks the ticket resolved. |

#### DB schema additions

```sql
CREATE TABLE support_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  client_id     UUID REFERENCES clients(id),
  proposition_id UUID REFERENCES propositions(id),
  type          TEXT NOT NULL CHECK (type IN ('invoice_request', 'refund_request', 'billing_question')),
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE support_ticket_replies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  sent_by    TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Sequencing

Build after the current Regen PDF fix and V2 E2E test — this is a website enhancement, not a backend pipeline requirement. It becomes more pressing once real clients start signing contracts and submitting reports.

---

### Pricing & Terms — Open Items for Decision

#### Rerun Pricing (Updated Intake)

When a client updates their intake form and requests a new run, the cost to run is the same as the original (~$12 API cost + margin). The question is what to charge them.

**Options to decide between:**

| Option | Rationale for | Rationale against |
|---|---|---|
| Full price (same as first run) | Clean, consistent, no confusion. Same compute cost to us. | May discourage clients from keeping data current, which degrades report quality over time. |
| Discounted rerun rate | Rewards clients for staying engaged and keeping data fresh. Creates upsell hook. | More pricing tiers = more explanation. Could be abused to get cheap refreshes. |
| Free within X days of last run | Removes friction when a client catches an error shortly after submitting. | Requires tracking and logic. Opens edge cases. |
| Included in monthly retainer | Simplest client experience — just update and it refreshes. | Margin pressure if clients update frequently. |

**Open question:** Decide pricing tier and document the decision here before launch. Monthly retainer clients and one-time clients should probably have different rerun policies.

---

#### Monthly Plan — Language & Pricing Review

The monthly retainer plan language and pricing need review before the site goes live. Flag for a dedicated session to lock in:

- Pricing tiers (one-time vs. monthly vs. annual)
- What "monthly" means in terms of deliverables (1 report per month? unlimited reruns?)
- Rerun policy under the monthly plan
- Cancellation terms
- What happens to report access after cancellation

Do not finalize copy on the `/intake` or pricing pages until this is decided.

---

### Refund Window & Delivery Window — Language Updates

#### Refund Window

Current language references a 72-hour refund window. This needs to be updated to **72 business hours** (i.e., excludes weekends and public holidays). A client who purchases on Friday afternoon should not lose their refund eligibility by Sunday night.

**Where to update:**
- Contract/terms copy
- Report delivery email
- Any pricing page or FAQ language that references the refund window

**Definition to use:** "72 business hours from the time your first report is delivered, excluding weekends and public holidays."

#### Report Delivery Window

Current language likely states a flat hour/day count for when the first report will be delivered after intake. Update this to **business days only** — no commitment to deliver over weekends.

**Suggested language:** "Your first report will be delivered within 2 business days of completing your intake form."

Adjust the specific number once the actual pipeline run time is confirmed at scale, but the business-days framing should be locked in now.

---

### Automated Refund Window Tracking

The system should log the refund eligibility window per report and automatically evaluate refund requests against it — rather than requiring manual date math each time.

**How it works:**

1. When a report is delivered (email sent), write a `refund_eligible_until` timestamp to the `reports` table
   - Formula: delivery timestamp + 72 business hours (skip Saturday/Sunday, skip public holidays)
   - Use a simple business-hours calculator function — no external library needed

2. When a refund request comes in via the support ticket form (`type = 'refund_request'`):
   - System checks `NOW()` against `refund_eligible_until` on the associated report
   - If within window: ticket is flagged **Eligible** in the admin support inbox
   - If outside window: ticket is flagged **Ineligible — window expired [date]** so Brendon can see at a glance without checking manually

3. **No automatic processing.** The system does not issue refunds automatically — Brendon still approves and processes via Stripe. The automation is in the eligibility check and flag, not the payment action.

**DB change:**
```sql
ALTER TABLE reports ADD COLUMN refund_eligible_until TIMESTAMPTZ;
```

**Business hours helper (Node.js, `lib/businessHours.js`):**
- Takes a start timestamp and an hour count
- Skips Saturday/Sunday
- Skips a hardcoded list of US federal holidays (update annually or load from a config)
- Returns the resulting deadline timestamp

**Edge cases:**
- If report delivery email failed (status `failed`), do not set `refund_eligible_until` — no delivery, no window started
- If client requests a refund before their first report runs, flag as manual review (no report row to check against)

---

### Data Confidence as a Client Engagement Signal

The data confidence score currently lives inside the report — it tells the client how reliable this run was. But the signal has additional value beyond the report itself: it can tell us what we're missing about the client, flag when a follow-up is worth having, and give us a principled reason to reach back out.

**Three uses to explore:**

#### 1. Intake Form Improvement

After enough runs, look at which confidence signals are consistently low across propositions of the same type. If origin_ops confidence is low on every domestic proposition (because origin country is null), that's a structural intake gap — add a question. If source coverage is low on every food/beverage run, that's a data tool gap — improve coverage before selling more of those.

Pattern: run `compute_data_confidence` data across completed reports, group by `proposition_type` and `industry_category`, surface which signals drag the score down most often. Those are your intake improvement targets.

#### 2. Client Follow-Up Emails (Re-engagement)

When a run comes back Low or Very Low confidence, and the primary cause is incomplete intake data (not a tool failure), that's a reason to reach back out. The client gave us thin input — we gave them a thin report — and they may not know why.

A targeted follow-up email: "Your [Month] report came back with a Moderate confidence rating. The main gap was [specific section]. If you can share [specific detail], we can re-run with stronger data at no charge." This turns a low-confidence run into a client touch point rather than a silent disappointment.

Do not send these automatically. For now, this is a flag in the admin panel: "Low confidence — follow-up candidate." Brendon decides whether to reach out.

#### 3. Intake Form Quality Score (Pre-Run)

Before a run starts, score the completeness of the intake answers. A proposition with `origin_country = null`, `primary_question = null`, and no `client_context` entries is going to produce a low-confidence run. Flag this to the admin before triggering.

Possible display: "Intake completeness: 60% — consider reaching out to the client before running." This catches thin submissions before spending $12 in API costs on a report that will disappoint.

**Implementation:** Defer until after V3. The patterns won't be visible until there are 10–20 completed runs across varied proposition types. Build the analysis then, not speculatively now.

---

### Visual Redesign — Claude Design

**What it is:** Use [Claude Design](https://claude.ai) (Anthropic Labs, launched April 2026) to generate a visual redesign of the public-facing website before launch. Claude Design reads a codebase and design files to apply the existing system, produces editable prototypes from plain-English prompts, and exports directly to HTML or Claude Code for integration.

**Why defer to pre-launch:** The core product (pipeline, intake, admin panel) needs to be stable and tested first. A redesign this close to launch risks rework if the page structure changes. Do it once the feature set is locked.

**How to run it:**
1. Open Claude Design at claude.ai (requires Pro/Max/Team/Enterprise)
2. Point it at the `mckeever-consulting-website/` codebase so it reads the existing design system
3. Prompt for the redesign with goals (e.g. "more premium consulting firm feel, cleaner landing page, stronger CTA hierarchy")
4. Export as HTML or Claude Code
5. Integrate the output into the Next.js codebase via Claude Code

**Sequencing:** Do this after V2 E2E test passes and billing support is in place — i.e., when the feature set is locked and the product is approaching a real public launch.

---

## Architectural principles that carry through all phases

1. **WAT stays intact.** Workflows → Agents → Tools. Adding a new industry or venture type means adding new workflow markdown files and optionally new tool scripts. The orchestrator (`run.js`) changes minimally.

2. **Venture intelligence scales.** The Perplexity venture intelligence brief already partially bridges the gap between phases. As new proposition types are added, the brief's framing improves the output even before dedicated workflow sets exist.

3. **Model tiers hold.** Haiku for research agents (fast, narrow), Sonnet for assembly and fact-checking (synthesis and verification). Escalation to Sonnet on research agent failure. This holds for all venture types.

4. **Fact-check is built in, not bolted on.** `runFactCheckAgent()` runs after quality gate, before the assembler, on every run. Proposition-agnostic — checks category-level data misrepresentation, unsupported statistics, regulatory claims, and named competitors. The assembler applies corrections before writing. This cannot be sold around.

5. **Delivery pipeline is unchanged.** PDF → Supabase Storage → Resend email. The report format may grow more sections, but the delivery mechanism stays the same.

6. **New propositions = new DB rows, not new code** (as much as possible). The goal in V2/V3 is that adding a new industry or venture type only requires new workflow markdown files and possibly one new tool script — not a rewrite of the orchestrator.

7. **Data retention is automated.** `agent_outputs` are purged after every run. A monthly cron runs `node tools/cleanup.js --prune --confirm` to enforce the 6-month report retention window (reports, sources, Storage files) and sweep expired `api_cache` entries (7-day TTL). Set this up once the V1 end-to-end test passes and real client data starts accumulating.

---

## Existing Business Analysis — Audit & Strategy Report (After V3)

**Prerequisite:** V3 complete. This product shares the same research pipeline — building it before V3 would mean re-doing intake and workflow work twice.

### What it is

A second product tier alongside the viability report: an **audit and strategy report for businesses that are already operating.** Same research pipeline (all 10 agents, same tools, same data sources), different assembler that reframes findings around what to do *now* rather than whether to start.

The client already has a business. They're not asking "will this work?" They're asking "how do I compete better, grow revenue, fix what's broken?" The research answers those questions — we just need an assembler that frames the output accordingly.

### Why the lift is small

The research pipeline is already industry-agnostic. The 10 agents don't know or care whether the client is pitching a new idea or running an existing shop — they produce the same competitive landscape, regulatory environment, market sizing, and financial benchmarks regardless. The only thing that changes is what the assembler *does* with that data.

- **Same 10 research agents** — unchanged
- **Same tools, same APIs** — unchanged
- **Same fact-check agent** — unchanged
- **Same PDF delivery pipeline** — unchanged
- **New: one assembler workflow** — `workflows/assemble_existing_business.md`
- **New: one DB field** — `business_stage` (`idea` | `existing`)

That's it. One new field routes to a different assembler. The rest runs as-is.

### New intake fields required

For existing businesses, the intake form needs three additional questions:

| Field | Question | Why it matters |
|---|---|---|
| `annual_revenue` | Approximate annual revenue (range OK) | Anchors financial benchmarking — agents compare to same-size peers |
| `years_operating` | How long have you been in business? | Distinguishes early-stage survival from growth-stage optimization |
| `primary_challenge` | What's the single biggest challenge you're trying to solve? | Lets the assembler lead with the section most relevant to the client |

### Report sections vs. viability report

| Viability report section | Existing business equivalent |
|---|---|
| Market Opportunity | Market Position — where you sit vs. the opportunity |
| Competitive Landscape | Competitive Position Score — ranked vs. named peers |
| Financial Projections | Revenue & Margin Optimization — benchmarks vs. your actuals |
| Regulatory Compliance | Compliance Gap Analysis — what you may be missing |
| Go-to-Market Strategy | Growth Channels — what's working in your category |
| Executive Summary / Verdict | Quick Wins (30/60/90 days) — prioritized action list |

The assembler instructions shift the framing from "here is what you'd need to do to start" to "here is what the data shows about where you are and what to do next." The research data is the same.

### Test Model — Brendon's Brother (Freelance Videographer, Minneapolis) ✅ CONFIRMED

**Profile:** Freelance videographer and video editor, Minneapolis, MN. 20+ years in the field. **Committed as the test proposition for existing business analysis E2E validation. Will also be a real paying client after test is complete.**

**Why this is a good test model:**
- Real business, real history, real local market — not a synthetic proposition
- Service business (no supply chain, no import path) — stress tests the non-physical pipeline
- 20 years of operation means there's actual competitive context, pricing history, and market positioning to surface
- Local geography (Minneapolis) tests the local/regional data layer that was added in Session 37
- High bar: he knows his own business intimately. If the report surprises him or shows him something genuinely useful (opportunities, competitive gaps, areas for growth he hadn't considered, market positioning shifts), the existing business analysis product works. If it just describes the Minneapolis videography market in generic terms, it fails.

**Goal for the intake form design:** Get enough specific detail from the intake form alone that the report can go beyond "here is the videography market in Minneapolis" and actually address his specific positioning, revenue model, client types, and competitive gaps — without needing a follow-up call or email to gather more data. The intake form for existing businesses needs to ask the right questions upfront. This test case will reveal which questions matter most and validate whether the industry-agnostic product can handle solo service freelancers (the hardest case for public data availability).

**Blockers before running the test:**
- The existing business analysis assembler workflow (`workflows/assemble_existing_business.md`) must be written
- The intake form must have the existing-business branch built out with the right questions
- At least one V3 venture type (`service_business`) must have a confirmed E2E test
- Data confidence tool must be reviewed and confirmed working (Step 0 in HANDOFF)

**Expected outcomes of this test:**
- Validation that the report can surface novel, actionable insights about an operating business
- Identification of which intake form questions produce high-confidence research output
- Proof that the system works for solo service freelancers (hardest case — least public data, most niche market)
- Real feedback from someone who knows the market deeply

---

### Identifying Additional Test Businesses

Once the brother's videography business test is complete and the existing business analysis product is ready for beta, identify 2-3 additional test businesses across different industry categories and revenue models.

**Target profile diversity:**
- At least one B2B service (accounting firm, consulting, legal, recruiting)
- At least one physical product or inventory-based business (retail, manufacturing, e-commerce)
- At least one knowledge/digital product (SaaS, course/content business, agency)

**Why varied profiles matter:**
- Solo freelancer (videographer) proves the system works with minimal public data
- Structured B2B (law firm) proves it works with regulatory depth and client-facing positioning
- Inventory/product business proves it works with supply chain, unit economics, and physical logistics
- Digital business proves non-physical, non-service ventures work (SaaS, products)

**Discovery approach:**
- Ask in community channels, networks, or past consulting relationships for businesses willing to participate
- Prioritize owners/founders who know their space deeply (like the videographer) — they'll give honest feedback on whether the report was surprising and valuable
- Document what each test revealed about the intake form, research depth, and industry-specific gaps

**Sequencing:** Begin identifying candidates during the brother's test run so they're warm by the time you're ready to expand. Do not wait until the first test is complete to start reaching out.

---

### Implementation plan (when ready)

1. Add `business_stage TEXT DEFAULT 'idea'` to propositions table — new migration
2. Add existing-business branch to intake form (website) — 3 extra questions shown when `business_stage = 'existing'`
3. Write `workflows/assemble_existing_business.md` — same structure as `assemble_report.md`, different section prompts and framing
4. Add `business_stage` branch in `run.js` assembler call — one conditional to select which workflow markdown to load
5. Test with a real existing business as the proposition (not synthetic data)

### Pricing position

Viability reports are for people with an idea. Existing business audits are for people with revenue — a meaningfully different buyer with more at stake and more ability to pay. Price accordingly: same or higher than viability reports, positioned as a "get an outside expert's read on your business" rather than "research before I launch."

### Decision log entry

| Decision | Outcome | Rationale |
|---|---|---|
| Sequence after V3 | After V3 complete | V3 adds SaaS/services venture types — existing businesses include those types. Build the general non-physical venture infrastructure first, then the existing-business assembler works for all venture types at once. |
| Same research pipeline | No new agents | Research output is the same regardless of business stage — the framing changes, not the data. Avoids maintaining two separate agent pipelines. |

---

## Future Discussion — Intake Enrichment Pipeline

**The problem:** Some propositions need more client data than the intake form captures to produce a high-quality report. Right now there's no mechanism to identify this before a run, ask for it, or receive it — we either run with thin data or don't run at all.

**What to discuss and design:**

### Option A — Intake Completeness Grader (Pre-Run)

A tool that scores a completed intake form before the run is triggered. Flags thin submissions and suggests what's missing.

- Could live as a step in the admin panel: "Intake score: 55% — suggested follow-up questions: [list]"
- Could also be surfaced to the client immediately after form submission: "Your form is complete. To improve your report quality, consider also telling us: [X, Y, Z]"
- Non-blocking — Brendon decides whether to follow up before running

### Option B — Automated Follow-Up Email Template

When intake completeness is below a threshold (e.g. < 70%), trigger an email to the client with specific questions based on what's missing. Uses Resend, links back to the client portal where they can update and resubmit.

- Questions should be targeted, not generic — "You didn't tell us your current annual revenue range, which affects our financial benchmarking. Can you add that?" rather than "Please fill out more of the form."
- Email goes out automatically, or on Brendon's approval from the admin panel

### Option C — Client Portal Follow-Up Questions

Within the client portal, surface a "your report quality could improve" section with specific questions, pre-populated based on what's missing. Client answers inline and resubmits — triggers a rerun.

### Option D — Post-Run Data Request (Low Confidence Trigger)

After a run comes back Low or Very Low confidence, automatically (or on admin approval) send the client an email explaining what was weak and asking for the specific additional data that would close the gap.

---

**What needs to be decided before building any of this:**
- Which option(s) make sense for the product model (self-service vs. high-touch)
- Whether the follow-up should be automatic or admin-approved
- How to score intake completeness — what counts as "complete" per proposition type
- Whether a rerun triggered by a client data update is free, discounted, or full price (linked to the rerun pricing decision)
- How this integrates with the client portal (already in the roadmap)

**Sequencing:** Do not build until after V3 and the existing business analysis are in place. By then, patterns from real runs will reveal which intake gaps matter most — building this speculatively before that data exists will produce the wrong questions.

---

## Decision log

| Decision | Outcome | Rationale |
|---|---|---|
| Website before V2 | ✅ Done | Intake form questions drive the DB schema — building the form first locked in the right data model before V2 migrations. |
| MCP | Ruled out (2026-04-13) | Declining adoption, more problems than it solves. Tool layer stays as Python subprocesses. |
| Run trigger | GitHub Actions workflow_dispatch | No new servers. Web app calls GitHub API → Actions fires run.js. Web app polls Supabase reports table for status. |
| V2 before V3 | Physical products first | Shared research spine (supply chain, regulatory, manufacturing) makes generalisation lower risk. |
| Venture intelligence as bridge | Relying on brief for V2 | Perplexity brief already makes agents adapt to industry — reduces workflow rewrite scope. Test before committing to per-industry workflow blocks. |
| Option A workflow generalisation | Start with brief-driven adaptation | Less work. Test first, move to per-industry substitution blocks (Option B) only if results are poor. |
| Industry category field | Migration 009 | Clean DB signal for gov tool routing — better than inferring from product description. |
| Gov tool scripts (ITC/EPA/BLS) | ✅ Built before E2E test (2026-04-15) | Free/no-key APIs. Built and tested before the furniture manufacturing test proposition to ensure routing works from day one. |
| Existing business test model | ✅ Brother's videography business (2026-04-24) | Solo freelancer is the hardest case (least public data). If it works for a 20-year solo service business, the product is robust across venture types. Also a real client post-test. Will identify additional test businesses across different profiles during this run. |
