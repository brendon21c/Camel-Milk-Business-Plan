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
