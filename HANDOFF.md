# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-24 (Session 37 — API registration complete; 4 new tool scripts; all 10 workflows upgraded; fact-check agent strengthened)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: Perplexity briefings → research agents → quality gate → **fact-check agent** → assembler → branded PDF → Resend email → client inbox.

**There are two projects:**

| Project | Location | Purpose |
|---|---|---|
| `Camel-Milk-Business-Plan` | This repo | Backend report engine — agents, tools, PDF generation, scheduling |
| `mckeever-consulting-website` | Sibling repo, also on Vercel | Client-facing website — landing page, intake form, admin panel |

They share the same Supabase project. The website writes intake data; the backend reads it and delivers reports. The admin panel triggers backend runs via GitHub Actions `workflow_dispatch`.

---

## Seed IDs

| Record | How to find |
|---|---|
| Organization (B & I) | query `organizations` by `name = 'B & I'` |
| Organization (McKeever Consulting) | query `organizations` by `name = 'McKeever Consulting'` |
| Client — Brendon McKeever | query `clients` by `name = 'Brendon McKeever'` |
| Client — Iman Warsame | query `clients` by `name = 'Iman Warsame'` |
| Proposition (Camel Milk Export) | query `propositions` by `title = 'B & I'` |
| Supabase project | see `.env` / Supabase dashboard |

---

## Current State (as of 2026-04-24)

### Backend — `Camel-Milk-Business-Plan` ✅ V2 complete + research layer expanded + fact-check upgraded

- V1 pipeline fully working and tested
- E2E test passed 2026-04-10. Report delivered to Iman Warsame and Brendon McKeever
- **13 migrations run (001–013)**
- **Northern Heritage Designs test run complete (2026-04-20):** First real non-food, non-import proposition. `pending_review` status, 80.5/100 confidence, 3.5/5.0 Moderate viability. Indian Arts and Crafts Act flagged as key legal risk. Origin country was null (domestic) — supply chain section was data-limited as a result.
- **Step 2.5 complete:** `getPropositionContext()` added to `db.js`. At run start, backend queries `proposition_context`, groups rows by category, and injects relevant notes into each research agent's prompt as a `## ADMIN CONTEXT NOTES` block. Category → agent mapping is in `run.js` (`CATEGORY_TO_AGENTS`).
- **Prompt caching live:** All 15+ assembler section calls pass the shared `researchContext` as a cached prefix. Saves ~$5/run (~40% cost reduction). Inter-section delay 17s (15 × 17 = 255s, safely under the 300s TTL).
- **Failed-run resume live:** `tryResumeFromContent()` runs before creating a new report record. Creates a fresh report record (new `created_at`) so the admin panel's polling detects it. Re-computes data confidence from the original failed run's `agent_outputs` (now preserved on failure). Patches the content JSON with the fresh score. Deletes the old content JSON from Storage after success so the next trigger runs fresh. Agent_outputs are cleaned up after the resume completes.
- **Sources extraction fixed:** Replaced LLM-based sources compilation (call 15/15) with deterministic JS that iterates `agentOutputs` directly. No API cost, no missed URLs, no hallucinated sources.
- **Census API key fallback:** `fetch_census_data.py` detects the "Invalid Key" HTML response (status 200) and retries without the key. Keyless access gives 500 req/day — enough for one report run.
- **Search quality tools live:** Exa AI (`search_exa.py`), Tavily (`search_tavily.py`), and Jina Reader (`fetch_jina_reader.py`) all active with keys in `.env`. All 10 research workflows updated with Step 1c multi-engine research layer: Perplexity 2 mandatory calls per agent (proactive synthesis, not fallback), Exa 2 calls per agent (6 depth modes — `instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning`, default `deep`; `similar` command for competitor/brand discovery; `category` filter exposed), Tavily `research` mode (full-text synthesis across sources), Jina 3-URL batch read (mandatory). `run.js` tool definitions corrected to expose all Exa depth modes, `category` parameter, and Perplexity proactive framing.
- **UN Comtrade live:** `tools/fetch_un_comtrade.py` built and registered. Two commands: `bilateral` and `top_partners`. HS code caveat baked in everywhere.
- **Fact-check agent live:** `runFactCheckAgent()` in `run.js`. Runs after quality gate + 2-min cooldown, before assembler. Uses Sonnet with `FACT_CHECK_TOOLS`. Non-fatal: failure yields a caution stub.
- **PDF title fixed:** Cover page now uses `client.company_name` instead of `proposition.title`. Intake actions updated so new submissions store just the company name as the proposition title.
- **V2 E2E test complete (2026-04-23):** Furniture manufacturing, Minnesota → US. Intake → contract → Stripe → Run Now → report all validated.

- **4 new tool scripts built and registered (Session 37):** `search_news.py` (NewsAPI), `fetch_financial_data.py` (Alpha Vantage + Finnhub + Massive), `search_youtube.py` (YouTube Data API v3), `search_product_hunt.py` (Product Hunt GraphQL). Total registered tools: **62**.
- **All 10 research workflows upgraded (Session 37):** Every workflow now has Step 1d (platform & media intelligence), a 3rd Perplexity call focused on risk/failure patterns, and one local/regional Brave search. Addresses the NHD gap of "Minnesota rates estimated from national benchmarks."
- **Fact-check agent upgraded (Session 37):** Perplexity and NewsAPI added to `FACT_CHECK_TOOLS`. `maxIter` 30 → 50, `maxTokens` 8000 → 16000. System prompt now includes explicit independence notice (agent is told it has NOT seen the venture brief or admin context). New Section 5: cross-agent consistency check. New `cross_agent_inconsistency` issue type in output. Smoke tested: 5/5 planted errors caught including a fake competitor, a non-existent regulation (CARB Phase 3), a $114B vs $3.2B cross-agent TAM contradiction, and a category-level data misrepresentation.
- **API keys added:** `PRODUCT_HUNT_DEV_TOKEN`, `NEWS_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `MASSIVE_API_KEY` (formerly Polygon.io — same endpoint), `FINNHUB_API_KEY`. See `API_REGISTRATION_PLAN.md` for full status.
- **API registration findings:** G2 API restricted to vendors who list products on G2 — not usable for third-party research. TikTok Research API blocked for commercial use. OpenCorporates no longer free (£2,250/year minimum). All three moved to "blocked/deferred" in `API_REGISTRATION_PLAN.md`.

**Note:** Camel Milk proposition is set to `plan_tier = 'retainer'` in Supabase to allow the May 1 auto-run test. After May run confirms scheduling works, flip back to `starter`.

**Note:** `report_sources` DB table has 0 rows for the NHD run despite 129 sources in the content JSON. The deterministic JS extractor writes to `content.sources` for PDF use but does not write to the `report_sources` table. Minor bug — not blocking, but sources aren't queryable from the DB.

### Website — `mckeever-consulting-website` ✅ All pages built

- **Stack:** Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui
- **Deployment:** Vercel — live
- **Supabase:** Connected. `lib/supabase/client.ts` (browser, anon key) and `lib/supabase/server.ts` (server-side, cookie-based) both in place.
- **Auth:** Supabase Auth wired up. `app/admin/layout.tsx` redirects to `/login` if no session. Login page at `/login`.

| Page | Status | Notes |
|---|---|---|
| `/` | ✅ Live | Landing page |
| `/intake` | ✅ Built | Branching form — physical branch fully implemented, V3 types stubbed |
| `/login` | ✅ Built | Supabase `signInWithPassword`, redirects to `/admin` on success |
| `/admin` | ✅ Built | Dashboard — 4 stat cards (active propositions, runs this week, total clients, pending review) |
| `/admin/propositions` | ✅ Built | Lists all propositions with status badges |
| `/admin/propositions/[id]` | ✅ Built | Full detail — proposition params, client info, reports history, Run Now, Context Panel, PDF download |
| `/admin/reports` | ✅ Built | 100 most recent runs across all propositions, PDF download per row |
| `/admin/clients` | ✅ Built | Org list with status toggle, plan tier select, nested contacts |
| `/admin/clients/[id]` | ✅ Built | Org detail page |
| `/admin/settings` | ✅ Built | Settings page |

**Notable component details:**
- **RunPanel:** Two-step confirm guard on "Run Again" — first click turns amber ("Confirm run?"), second click fires. Auto-cancels after 4 seconds. All run buttons have `type="button"`.
- **ContextPanel:** Collapsible category guide (toggled via "Category guide" link in the header). Shows which agents each category routes to, what to use it for, and an example note.

---

## What Is Next

### Step 0 — Data Confidence Tool Review

**Priority: do this before any V3 work.** The data confidence score is displayed on the cover page of every report and referenced in the executive summary. It needs to be reliable.

**What to review:**

1. **Read `tools/compute_data_confidence.py` end to end.** Understand all four signals: field confidence ratings (45%), agent completion rate (25%), source citation coverage (20%), data gaps (10%). Verify the weighting math is correct and the score range is actually 0–100.

2. **Confirm it runs on every report.** Trace the call in `run.js` — it should fire after the quality gate, before the assembler, on every run including resumes. If there's any code path where it can be skipped silently, close it.

3. **Verify what "field confidence ratings" actually measures.** The 45% signal is the biggest weight. Confirm agents are actually emitting structured confidence fields in their JSON output, and that the tool is reading those fields correctly — not defaulting to a generic score when fields are missing.

4. **Test the Low / Very Low path.** Confirm that when confidence is Low or Very Low, the callout box actually appears in the Executive Summary in the generated PDF. This is a quality bar requirement but was never smoke tested separately from full runs.

5. **Improve if needed.** If the methodology has gaps (e.g. a hard-failed agent counts as "completed" for the completion signal, or the gap-count logic double-counts), fix them before V3. A flawed confidence score that says "High" on a weak run is worse than no confidence score.

6. **Document the final methodology** in `workflows/assemble_report.md` Section 14 spec — so future changes to the tool don't silently break the report language.

---

### Step 1 — Code Quality (4 audit items, still pending)

These are reliability fixes that should be done before V3 work starts. `parseJSON()` causes a visible non-fatal error on every single run today.

1. **Fix `parseJSON()` — add array fallback + better fence extraction** (`run.js` ~line 1429)
   - Root cause of the `Quality review failed` and `Proofread pass failed` non-fatal errors visible in every GitHub Actions log.
   - Fix: add `raw.match(/\[[\s\S]*\]/)` as a parallel fallback. Replace the two-regex fence strip with a single capture: `raw.match(/```(?:json)?\s*([\s\S]*?)```/s)`.

2. **Update GitHub Actions to Node 22** (`.github/workflows/reports.yml` line 56)
   - `node-version: '20'` — Node 20 deprecated June 2, 2026. Update to `'22'` (LTS, drop-in compatible).

3. **Per-agent resume on retry**
   - When a run fails mid-way, the next run re-runs all agents from scratch even though outputs are saved per-agent in Supabase.
   - Fix: at run start, check if `agent_outputs` already exist for the proposition's most recent pending/failed report. Skip agents that already have saved output.
   - Single biggest cost-reduction fix for retries — saves $3–6 per failed run.

4. **GDELT and USPTO — return error-flagged responses instead of empty results**
   - Fix: return `{ "_tool_error": true, "reason": "SSL timeout" }` so agents can flag "USPTO trademark check unavailable — verify manually" instead of silently skipping.

---

### Step 2 — GitHub Actions Secrets

New API keys in `.env` need to be added to GitHub repo secrets so scheduled runs can use them. Go to repo → Settings → Secrets and variables → Actions → add:
- `NEWS_API_KEY`
- `ALPHA_VANTAGE_API_KEY`
- `MASSIVE_API_KEY`
- `FINNHUB_API_KEY`
- `PRODUCT_HUNT_DEV_TOKEN`

---

### Step 3 — V3 Build Order

Don't start a new step until the previous one has an E2E-tested result.

**Architectural note:** AGENT_MANIFEST (dynamic agent selection per venture type) is superseded. All 10 research agents run for every proposition — they ask universal business questions that apply to every venture type. The vocabulary and tools adapt per proposition type; the agent set does not change. See ROADMAP_V2.md V3 section for full rationale.

1. **Build the `curiosity_agent`** — first V3 prerequisite and the highest-leverage addition to the pipeline. Runs after the two Perplexity pre-briefings, before the 10 research agents. Uses Opus (one bounded call + one Perplexity curiosity call). Produces a per-agent research agenda of non-obvious, proposition-specific questions that supplement standard research. Non-fatal — if it fails, research agents proceed on standard workflows only. Workflow file: `workflows/curiosity_agent.md` (written). Needs: registration in `run.js`, injection into research agent prompts, admin panel visibility (**admin panel review workflow design pending — see note below**).

2. **Make all 10 agents proposition-type aware** — update each research workflow to handle non-physical venture types. The venture intelligence brief already does this partially; the workflows need explicit guidance on how to reframe their 10 universal questions for services, SaaS, digital products, and content businesses. No new agents — vocabulary and tool selection adapts, agent set stays the same.

3. **Extend intake form for V3 types** — `/intake` already has V3 proposition types stubbed. Fill in branch-specific fields per venture type (SaaS needs target segment and pricing model — not origin country and product weight).

4. **Build one V3 venture type end-to-end** — start with `service_business` (simplest: no supply chain, no import path, most likely early client type). Run a full E2E test, validate the report quality across all 10 agents in the service context.

5. **Add V3 data sources as propositions need them** — Product Hunt and YouTube tool scripts already built. Crunchbase ($29/mo) and SimilarWeb ($125/mo) only when a real paying proposition justifies the cost.

6. **Social media layer** — YouTube tool script now built (`search_youtube.py`). Add Instagram, Pinterest as V3 marketing workflows need them. TikTok Research API blocked for commercial use — skip it.

7. **Billing support (website)** — independent work; can run in parallel with any step above. Becomes urgent before first real paying V3 clients accumulate.

8. **Existing Business Analysis** — after V3 is stable with at least 2 venture types working end-to-end. The 10 universal agents apply; assembler uses a different framing workflow. 2–4 additional research dimensions specific to operating businesses (strengths analysis, growth opportunity mapping, competitive gap analysis, benchmark underperformance) — likely 1–2 additional agents or assembler-level additions.

---

**Admin panel review of curiosity agenda — design pending**

The curiosity_agent saves its agenda to `agent_outputs` and it should be visible in the admin panel on the proposition detail page before a run fires. Brendon should be able to read the agenda and optionally edit specific questions before research starts — this is the human backstop for unusual or high-stakes propositions.

The workflow for how this integrates with run triggering needs to be designed before building:
- Does the curiosity agenda generate as a separate pre-step the admin triggers, with the full run triggered separately after review?
- Does the run pause after curiosity_agent and wait for admin approval before research agents fire?
- Or does the full run always complete, with the agenda shown for review before the *next* run?

Each option has different UX and pipeline implications. Needs a dedicated design decision before implementation.

---

### V2 E2E Test — Furniture Manufacturing ✅ Complete (2026-04-23)

Confirmed: intake → contract → Stripe payment screen → Run Now → report generation all validated. Industry routing (ITC/EPA/BLS called, FDA/USDA skipped), new intake fields in agent prompts, PDF title, Exa/Tavily mandatory calls, and fact-check agent all confirmed working.

---

## Website — Future Work

### Billing Support (next)

Clients need to request invoices, request refunds, and ask billing questions. Admins need a single inbox to see and respond.

**Client side:** Magic-link form at `/support/billing?token=<contract_token>` — uses the existing contract token for identity, no new auth needed. Token added as a "Billing help" link in the report delivery email and contract confirmation email. Three request types: invoice request, refund request, billing question.

**Admin side:** New `/admin/support` page — open ticket list, ticket detail with full client/org context, reply via Resend email, one-click invoice generation via Stripe API, resolve/close.

**DB:** Two new tables — `support_tickets` and `support_ticket_replies`. Full schema in ROADMAP_V2.md (Website Phase 2 section).

---

## V2 Backend Work (remaining)

1. **Local commercial rental rate searches** — NHD run flagged "Minnesota workshop rental rates estimated from national benchmarks rather than local data." No free API exists for commercial real estate rates (CoStar/REIS are enterprise-only). Fix: update `workflows/research_production.md` and `workflows/research_origin_ops.md` to explicitly instruct agents to search for actual local listings (LoopNet, Crexi, local CRE broker reports) in the proposition's city/state **before** falling back to national benchmarks. One-line prompt change per workflow — no new tool or script needed.
2. **Remaining gov tool scripts** — build when needed for the next test proposition:
   - `tools/fetch_doe_data.py` — DOE EIA + NREL (energy/solar)
   - `tools/fetch_fda_device_data.py` — FDA 510(k) clearances + device recalls (medical)
   - `tools/fetch_bis_data.py` — BIS export control classifications (electronics)

**V2 test propositions:**
| Proposition | Industry category | Key tools needed | Notes |
|---|---|---|---|
| Furniture manufacturing, Minnesota → US | general_manufacturing | ITC, EPA, BLS | **E2E test proposition** — US market only |
| Furniture manufacturing, Minnesota → US + Europe | general_manufacturing + international | ITC, EPA, BLS, UN Comtrade, GDELT | Europe version deferred until international pipeline built |
| Solar panels, China → US | energy | DOE EIA, EPA, ITC | — |
| Apparel / activewear, Bangladesh → US | apparel | CBP, FTC, CPSC | — |
| Medical diagnostic device, Germany → US | medical | FDA device, CMS | — |
| Consumer electronics, Taiwan → US | electronics | FCC, BIS, ITC | — |
| Camel milk powder, Somalia → UAE | food_beverage + Arabic | translate_text, detect_language, GDELT, UAE Ministry sources | — |

---

## Session Log

### Session 37 — API registration; tool expansion; workflow upgrades; fact-check strengthened (2026-04-24)

- **API registration complete** — Registered and tested: Product Hunt (dev token), NewsAPI, Alpha Vantage, Massive (Polygon.io rebranded), Finnhub. All keys in `.env`. Smoke tested 6/6 keys working.
- **API blockers discovered** — G2 restricted to vendors listing products on G2 (not usable for third-party research). TikTok Research API blocked for commercial use. OpenCorporates no longer free (£2,250/year minimum). All documented in `API_REGISTRATION_PLAN.md`.
- **4 new tool scripts built and registered:** `search_news.py`, `fetch_financial_data.py` (Alpha Vantage + Finnhub + Massive combined), `search_youtube.py`, `search_product_hunt.py`. Total tools: 62.
- **All 10 research workflows upgraded with Step 1d** — platform & media intelligence section added to every workflow. Competitors/marketing/financials/market_overview get YouTube, NewsAPI, financial data, and conditional Product Hunt. The 6 operational workflows (regulatory, production, packaging, distribution, origin_ops, legal) get NewsAPI targeted to their domain.
- **All 10 research workflows upgraded with risk Perplexity call** — 3rd mandatory Perplexity call per agent asking specifically about failure patterns, common mistakes, and cash traps. Addresses the gap where agents find what works but miss what goes wrong.
- **All 10 research workflows upgraded with local/regional Brave search** — 1 targeted query per agent using `[company_location]` to find local pricing, local competitors, local suppliers, state regulations. Directly addresses the NHD gap ("Minnesota rates estimated from national benchmarks").
- **Fact-check agent upgraded** — Perplexity + NewsAPI added to `FACT_CHECK_TOOLS`. `maxIter` 30 → 50. `maxTokens` 8000 → 16000. Explicit independence notice in system prompt. New Section 5: cross-agent consistency check. New `cross_agent_inconsistency` issue type. Smoke tested 5/5 planted errors caught (fake competitor, non-existent CARB Phase 3, $114B vs $3.2B TAM contradiction, category-level data misrepresentation, local/national conflation).
- **YouTube smoke tested** — `YOUTUBE_API_KEY` confirmed working. Found real camel milk channels (Camel Culture, Desert Farms) with subscriber counts and engagement rates in one call.

### Session 36 — V3 roadmap sequencing; API registration plan; Reddit blocked (2026-04-23)

- **V3 build order decided** — 8-step sequence documented in "What Is Next": clear audit items → AGENT_MANIFEST system → intake form extension for V3 types → first V3 venture type E2E (`service_business`) → V3 data sources → social media layer → billing support → existing business analysis. Sequenced by dependency, not by enthusiasm.
- **Register all APIs upfront** — new action item. Free APIs (G2, GitHub, Product Hunt, OpenCorporates, TikTok, Pinterest, NewsAPI) to be registered now to eliminate per-proposition friction. Paid APIs (Crunchbase, SimilarWeb, MediaStack, X) deferred until a real proposition justifies the cost.
- **Reddit API confirmed blocked** — registration was attempted and could not be completed. All Reddit entries in the API master list updated with blocked status. Social media build order updated (YouTube → Instagram → TikTok → Pinterest → X). Fallback: Perplexity + Brave for community sentiment research.

### Session 35 — Pre-V3 code audit; Perplexity caching + admin emails from DB (2026-04-23)

- **Full code audit completed** — reviewed run.js, db.js, all tools, CI workflow, and GitHub Actions log from the NHD furniture run. Findings categorized by severity. Four items completed this session; four deferred to next session (see "What Is Next" above).
- **Perplexity briefing caching live** — `runVentureIntelligence` and `runCurrentLandscapeBriefing` results now cached in the `api_cache` Supabase table with date-based keys (`perplexity:{type}:{proposition_id}:YYYY-MM-DD`). Same-day retries (including failed-run re-triggers on GitHub Actions) skip the Perplexity API entirely and load from cache. Cache expires naturally at midnight — next day always gets a fresh briefing. Saves ~$1-2 per same-day retry run.
- **Admin emails from DB** — removed hardcoded `const ADMIN_EMAIL = 'brennon.mckeever@gmail.com'` from `run.js`. All three admin email functions (`sendAdminReportCopy`, `sendFailureAlert`, `sendRegenCompleteNotification`) now receive `adminEmails[]` as a parameter. Loaded at run start from `organization_admins` table via new `getMcKeeverAdminEmails()` in `db.js`. Falls back to `process.env.ADMIN_EMAIL` if DB lookup fails or table is empty. `FROM_EMAIL` moved to `process.env.FROM_EMAIL` with fallback to the original value.
- **Audit false positive confirmed** — `runVentureIntelligence` and `runCurrentLandscapeBriefing` are synchronous (use `execPython`/`execSync`), not async. The "missing await" flag from the audit agent was incorrect.

### Session 34 — V2 E2E confirmed complete; consultant brief cancelled (2026-04-23)

- **V2 E2E test confirmed** — Furniture manufacturing, Minnesota → US. Full happy path validated: intake form, org activation, contract creation, Stripe payment screen, Run Now trigger, report generation and delivery. All verification criteria met: ITC/EPA/BLS called, FDA/USDA skipped, Exa/Tavily mandatory calls present in logs, fact-check agent fired, PDF cover showing company name only.
- **Consultant intelligence brief cancelled** — Not being built. Not a service we offer. Removed from HANDOFF, ROADMAP_V2, and all "What Is Next" sections.
- **V2 status: complete.** Next phase is V3 (SaaS, services, digital, franchise) or website billing support, whichever is prioritized.

### Session 33 — Workflow generalization complete, search quality layer overhauled (2026-04-21)

- **All 10 research workflows fully generalized** — last food-specific references removed. `assemble_report.md` line 190 updated (section 10 note: "health claims" → "regulatory claim analysis"). All 10 workflow files audited; no proposition-specific language remains.
- **Perplexity — proactive mandatory in all 10 workflows** — old Step 1c treated Perplexity as a fallback. Replaced with a full "Multi-Engine Research Layer" section (Step 1c) in every workflow. Each now requires 2 Perplexity calls using all intake variables in analyst-style questions. Perplexity returns synthesized answers with inline citations — not links to parse. Called proactively, not after Brave fails.
- **Exa — upgraded to 6 depth modes, 2 calls per workflow** — `tools/search_exa.py` completely rewritten. Added 5 new depth modes (`instant`, `fast`, `deep-lite`, `deep`, `deep-reasoning`) with per-mode timeouts (20s–120s). Default changed from `auto` to `deep`. `category` parameter added (6 valid values). `maxCharacters` raised from 3,000 to 10,000. All 10 workflows updated to require 2 Exa calls: one `--type deep` primary search, one `similar` command (or second `deep-lite` where `similar` isn't applicable). Special modes: `deep-reasoning` for country risk in `research_origin_ops.md`, `financial report` category in `research_financials.md`, `company` category in `research_competitors.md`.
- **Tavily — upgraded to `research` mode in all 10 workflows** — was using basic `search` subcommand. All workflows updated to use `research` subcommand (advanced depth + synthesized answer across sources).
- **Jina — mandatory 3-URL batch read in all 10 workflows** — was optional and single-URL. All workflows updated to require reading the 3 most data-rich URLs from any prior search. Priority guidance added (prefer supplier pages, regulatory docs, brand case studies, trade association guides).
- **`run.js` tool definitions corrected** — three critical gaps fixed: (1) `search_exa` type enum updated from `['neural', 'keyword', 'auto']` to all 6 depth modes — old enum caused schema validation failures silently, (2) `category` parameter added to `search_exa` execution code (was never passed to CLI despite being in the schema), (3) `search_perplexity` description rewritten from "Use ONLY when Brave returns fewer than 3 results" to proactive framing so agents call it eagerly.
- **Roadmap updated** — Regen PDF bugs removed from "What Is Next" (fixed Session 32). Industry routing + workflow generalisation removed from remaining V2 work (resolved via Option A — venture intel brief + generalized workflows). E2E furniture test is now the only remaining V2 milestone before consultant brief.

### Session 32 — NHD test run, pipeline bug fixes, intake form expanded, PDF title fixed (2026-04-20)

- **Northern Heritage Designs test run complete** — replaced Kitchen Tools / Mark Jones as the test client. NHD: Indigenous-inspired heirloom furniture, Minnesota, domestic physical, general manufacturing. Result: `pending_review`, 80.5/100 confidence, 3.5/5.0 Moderate viability. Indian Arts and Crafts Act flagged as primary legal risk. Origin country null (domestic) — supply chain section data-limited.
- **GitHub token added to backend `.env`** — `GITHUB_TOKEN` and `GITHUB_REPO_OWNER` were empty (zero-length). Found in website `.env.local`. Copied across. Was causing "Bad credentials" errors in GitHub Actions log fetch.
- **Four pipeline bugs fixed:**
  - **`SONNET` undefined** — `run.js` line 2473 referenced variable `SONNET` (never declared). Changed to literal `'claude-sonnet-4-6'`. Fact-check agent was crashing silently on every run.
  - **Exa/Tavily/Jina never called** — Step 1c in all 10 workflow files was conditional ("evaluate and decide"). Agents decided Brave was sufficient every time. Fixed by making Exa and Tavily calls **mandatory** on every run. Confirmed via GitHub Actions logs (zero calls in NHD run, now required).
  - **GDELT 429 causing 3 retries** — added 429 detection in `gdelt_get()`. Raises `RuntimeError` immediately on 429 — no retry. Saves 2 wasted iterations per GDELT hit.
  - **WTO HTS API returning 404** — USITC decommissioned `/reststop` entirely (tested 8+ endpoint variations). Replaced `cmd_hts()` with a structured fallback that directs agents to use web search. `cmd_imports` (Census) and `cmd_tariff` (FTA) still work.
- **Migration 013 run** — `ALTER TABLE reports ADD COLUMN IF NOT EXISTS formatting_notes TEXT;`
- **Intake form expanded** — 6 new fields added to `app/intake/page.tsx` and `app/intake/actions.ts`:
  - Step 0: `companyLocation` (where the company is based — state-level regulatory routing)
  - Step 1: `credentials` (certifications, licenses, cultural affiliations) + `existingResources` (equipment, inventory, workspace already owned)
  - Step 3: hybrid capital field (range dropdown + exact amount toggle), `primaryQuestion` (biggest question the client wants answered), `legalSensitivities` (known legal/regulatory/cultural issues)
  - Target market placeholder updated to show EU/country/state examples
  - All new fields stored in `client_context` JSONB — no schema migration needed
- **PDF cover title fixed** — was showing `proposition.title` (company name + full product description). Now uses `client.company_name` in `run.js` assembler. `actions.ts` updated so new submissions store just the company name as proposition title.
- **Existing business analysis product vision added to ROADMAP_V2** — full spec for "existing business audit" product tier. Same research pipeline, new assembler framing. Scheduled after V3 complete.

### Session 31 — Search quality tools live, UN Comtrade built, fact-check agent built (2026-04-18)

- **Exa AI key added** — `EXA_API_KEY` in `.env`. Variable name mismatch fixed on discovery (`EXA_AI_API_KEY` → `EXA_API_KEY`). Smoke tested and live.
- **Tavily key added** — `TAVILY_API_KEY` in `.env`. Smoke tested and live.
- **Jina key added** — `JINA_API_KEY` in `.env`. Smoke tested and live.
- **UN Comtrade key added** — `UN_COMTRADE_API_KEY` (primary key, Free APIs subscription). OpenCorporates skipped — $2,000/year. Brave `site:opencorporates.com` queries cover the same use case for free.
- **`tools/fetch_un_comtrade.py` built and registered** — `bilateral` and `top_partners` commands. ISO-3 input converted to M49 internally (50+ country table). Smoke tested with real 2023 data: US milk powder (HS 040210) imports — New Zealand #1 at $3.2M, no African suppliers in top 5. Key fix: `partnerCode: 0` does NOT mean "all partners" in Comtrade v1 — omit it to get per-partner breakdown. HS code caveat baked into tool docstring, RESEARCH_TOOLS description, and JSON output `data_warning` field — generic, not camel-milk specific.
- **All 10 research workflows updated — Step 1c added** — "Search Quality Escalation" section added to every research workflow before Step 2. Tells agents when and how to use Tavily (full article text), Exa (semantic/neural search), and Jina (read a specific URL). UN Comtrade added to `research_market_overview.md` and `research_origin_ops.md`. This was a critical gap — tools were registered but agents had no instruction to use them.
- **Fact-check agent built** — `runFactCheckAgent()` in `run.js`, pipeline position: after 2-min cooldown, before assembler. `FACT_CHECK_TOOLS` = filtered subset of RESEARCH_TOOLS (Brave, Tavily, Exa, Jina only — no data tools). Uses Sonnet. Extracts claim-dense fields from agent outputs (market sizes, regulatory claims, competitor names, financials, data sources) rather than truncating raw JSON — avoids false confidence from truncation. Falls back to 6,000 chars raw JSON if no claim-dense fields match. Checks: category-level data misrepresentation, unsupported statistics, regulatory claims, named competitors. Non-fatal — failure yields a caution stub to the assembler. Results injected into assembler system prompt (not the cached researchContext prefix — caching unaffected). `workflows/fact_check_research.md` written — proposition-agnostic, applies to any industry. Assembler uses corrections before writing each section; qualifies unverifiable claims.

### Session 30 — No-key API tools, search quality tools, translation decision (2026-04-17)

- **16 no-key API tools built and registered** — World Bank, IMF, OECD, Eurostat, FAO, WTO/HTS, GDELT, DOE/EIA, FDA Device, BIS, CBP, FTC, CPSC, SBA, USPTO Patents+Trademarks, EU RAPEX. All registered in `RESEARCH_TOOLS` (with "use when" language) and `executeTool`. All 10 research workflow `.md` files updated with explicit Step 1b tool-call sections.
- **Translation decision** — no external translation API. Agents (Claude) translate non-English sources inline using their own multilingual capabilities. Agents generate native-language Brave queries directly from `target_country` input. `international_research.md` rewritten to reflect this. `translate_text.py`, `detect_language.py`, `normalize_international_data.py` dropped from build plan.
- **Search quality tools built** — three tools that materially improve research depth:
  - `tools/search_tavily.py` — returns full article text (not snippets). Use after Brave when snippets are insufficient. `TAVILY_API_KEY` pending — sign up at tavily.com (1,000 free calls/month).
  - `tools/search_exa.py` — semantic/neural search. Finds relevant content keyword search misses. `similar` command finds competitors from one known URL. `EXA_API_KEY` pending — sign up at exa.ai (1,000 free/month).
  - `tools/fetch_jina_reader.py` — reads any URL and returns full clean markdown. Free, no key, already working. Optional `JINA_API_KEY` for higher rate limits.
- **HANDOFF pricing corrected** — DeepL free tier is 50k chars/month (not 500k as previously noted).

### Session 29 — International API planning, V2 end-game (2026-04-17)

- **Where we are in V2:** All core pipeline work is complete. Prompt caching live, failed-run resume live, admin review gate live, formatting notes panel built (migration 013 pending). Next up is the international research pipeline — identified as the last major V2 feature before final E2E test.
- **Caching verification pending:** The April 17 run used pre-caching code (committed after the run triggered). Next run will show `💾 Cache: write=X read=Y` lines in the assembler phase. Cache logging confirmed present in current `run.js` (lines ~1378–1387). If `read > 0` on sections 2–15, caching is working.
- **Migration 013 still pending:** Run `ALTER TABLE reports ADD COLUMN IF NOT EXISTS formatting_notes TEXT;` in Supabase before formatting notes UI will save correctly.
- **International pipeline decision:** Building translation layer + key international data tools now, before V2 E2E test. Starting with: DeepL, Google Cloud Translation, MyMemory (sign up), then building `translate_text.py`, `detect_language.py`, `fetch_un_comtrade.py`, `fetch_world_bank.py`, `fetch_gdelt_news.py`.
- **Comprehensive API master list added** to HANDOFF — covers translation, international trade/economic data, global news, US gov tools by industry status, non-physical product intelligence (V3: Crunchbase, SimilarWeb, G2, Reddit, etc.), social media platforms, and global IP/product data. All organized by V2 vs V3 and build-when-needed.
- **V2 end-game view:** After international pipeline tools are built, the remaining V2 items are: consultant brief, industry-aware gov tool routing, and the final furniture manufacturing E2E test. Then V2 is done.

### Session 28 — Resume path hardening, sources fix, Census fallback (2026-04-17)

- **Resume creates fresh report record** — `tryResumeFromContent()` now calls `createReportRecord()` instead of reusing the old `failedReport.id`. This gives the new run a fresh `created_at` so the admin panel's `RunPanel` polling (which filters by `createdAt >= triggeredAt`) correctly detects completion. The old failed record stays as a historical artifact.
- **Data confidence re-computation on resume** — root cause identified: the first test run had a bug in `compute_data_confidence.py` (selecting column `output` instead of `output_data`), resulting in null confidence baked into the saved content JSON. On resume, the null propagated. Fix: `tryResumeFromContent()` now calls `computeDataConfidence(failedReport.id)` to re-compute from the original run's `agent_outputs`, then patches the content JSON with the fresh score before PDF generation.
- **`agent_outputs` preserved on failure** — removed `deleteAgentOutputsByReportId()` from the failure handler. Agent_outputs are now kept until the resume runs and uses them for confidence re-computation. Cleanup happens in `tryResumeFromContent()` after the resume completes (both the new report's rows and the old failed report's rows). Pre-assembly failures (no content JSON) are cleaned up immediately when the resume check skips that failed report.
- **Old content JSON deleted after resume** — `tryResumeFromContent()` deletes the old failed report's content JSON from Storage after a successful resume. This breaks the stale-data cycle: the next trigger runs the full fresh pipeline instead of resuming from old content with null confidence.
- **Sources section fixed** — replaced LLM-based sources compilation (call 15/15 in assembler) with deterministic JS extraction. Iterates `agentOutputs` directly, deduplicates by URL, preserves `agent_name` and `retrieved_at`. No API cost, no missed URLs, no risk of hallucinated sources.
- **Census API key fallback** — `fetch_census_data.py` now detects the "Invalid Key" HTML response (Census returns status 200 with HTML when the key is wrong) and retries the request without a key. Keyless access provides 500 req/day — sufficient for one report run. Census key updated (`b15633b8...`) and activated.

### Session 27 — Prompt caching + failed-run resume + bug fixes (2026-04-16)
- **Proposition auto-activate on sign** — `submitSignatureAction` in `app/sign/[token]/actions.ts` now flips `propositions.status = 'active'` after contract is signed. Non-fatal (logs error but doesn't block signature). Fixes "Plate to Plate" staying as `prospect` after signing.
- **Python deps in GitHub Actions** — `reports.yml` now includes `actions/setup-python@v5` + `pip install -r requirements.txt`. Fixed `ModuleNotFoundError: No module named 'httpx'` / `dotenv` that killed PDF generation.
- **Financials token ceiling** — Sonnet escalation `maxTokens` raised from 16000 → 32000. Fixed JSON truncation in the financials agent when output was large.
- **Prompt caching** — `streamSonnetCall` accepts `useCache` param (wraps system prompt in `cache_control`). `callWithRepair` accepts `cacheablePrefix` param (splits first user message into cached prefix + task). All 15+ assembler section calls pass `researchContext` as the cached prefix. Expected savings ~$5/run (~40%). Inter-section delay 17s (15 × 17 = 255s, safely under 300s TTL).
- **Failed-run resume** — `tryResumeFromContent(proposition, context)` added. Called in `runProposition` before creating a new report record. Checks prior failed runs for content JSON in Storage. If found: marks report as running, writes tmp file, re-runs PDF + upload + email, marks complete, purges agent outputs. Returns `{ resumed: true, reportId }` so caller can advance schedule.
- **Code review fixes** (5 bugs caught before production):
  - `JSON.parse` in resume wrapped in try/catch with `continue` on malformed content
  - PDF/email delivery steps in resume wrapped in try/catch + finally for cleanup
  - `advancePropositionSchedule` added to resume success path in `runProposition`
  - Return value changed to `{ resumed: true, reportId }` (was `false`)
  - Inter-section delay 17s (was 20s — 15 × 20 = 300s = TTL with zero buffer)
- **Assembler instructions genericised** — removed hardcoded "Somalia-specific trade restrictions" from regulatory section and "FDA guidelines" from marketing section. Both now use proposition-type-agnostic language.
- **HANDOFF + ROADMAP_V2 updated** — scheduling table corrected (daily not monthly), troubleshooting updated, current state updated.

### Session 26 — Expanded intake form + client_context + test client mode (2026-04-16)
- **Migration 011** — `is_test BOOLEAN DEFAULT false` added to `organizations`, `clients`, `propositions`. Partial indexes on each. Purge support in cleanup.js.
- **Migration 012** — `client_context JSONB DEFAULT NULL` added to `propositions`. GIN index for fast queries. Stores: `product_scope`, `development_stage`, `price_point`, `revenue_model` (array), `customer_type`, `ideal_customer`, `sales_channel`, `comparable_brands`, `key_differentiator`.
- **Test client mode** — intake form at `/intake?test=true` shows amber TEST MODE banner. All created records tagged `is_test=true`. Plan tier forced to `retainer` so run limits never exhaust. `advancePropositionSchedule()` in `db.js` skips plan gating for `is_test=true` propositions.
- **`--purge-test`** — new command in `tools/cleanup.js`. Deletes all `is_test=true` records in FK-safe order (proposition_context → proposition_recipients → report_sources → agent_outputs → Storage → reports → propositions → clients → organizations). Dry-run by default; pass `--confirm` to apply.
- **5-step intake form** — new steps: "Your Product" (product scope, dev stage, price point, revenue model) and "Your Customer" (customer type, ideal customer, sales channel, comparable brands, key differentiator). Old Step 2 (Market) renamed "Operations". Step labels now: About You → Your Product → Your Customer → Operations → Your Plan.
- **`client_context` injection in `run.js`** — `propositionContext` now includes `client_context` when present. Injected as `## CLIENT CONTEXT` block in every agent's `userPrompt`, between the landscape briefing and admin context notes blocks.
- **Website CLAUDE.md** — intake form section fully rewritten to reflect 5-step structure and `client_context` schema. DB schema table updated.
- **Migrations to run:** 011 then 012 (in order) before deploying either project.

### Session 25 — Gov tool scripts + BLS v2 (2026-04-15)
- **`tools/fetch_bls_data.py`** — BLS Public Data API. Three commands: `wages` (manufacturing earnings benchmarks), `employment` (employment level trends by sector), `series` (arbitrary series IDs). Registered in `RESEARCH_TOOLS` and `executeTool`.
- **`tools/fetch_epa_data.py`** — EPA ECHO + TRI Envirofacts. Two commands: `facilities` (ECHO compliance search by NAICS/state), `tri` (Toxic Release Inventory by NAICS/state/chemical). Correct ECHO endpoint is `echo_rest_services.get_facility_info` (not `eco_search`).
- **`tools/fetch_itc_data.py`** — Federal Register + Census Trade. Two commands: `cases` (USITC/Commerce trade remedy notices), `imports` (Census `/intltrade/imports/naics` — aggregates 12 monthly snapshots into annual totals by country). Census trade API does NOT accept the standard `CENSUS_API_KEY` — pass no key or it returns "Invalid Key".
- **BLS v2 upgrade** — script detects `BLS_V2_API_Key` in `.env` and switches to the v2 endpoint (`registrationkey` in POST body). Falls back to v1 if key is absent.
- All three scripts smoke-tested against live APIs. All three pass valid JSON on error so `execPython` never crashes the run.

### Session 24 — Step 2.5 + website audit (2026-04-15)
- **Step 2.5 complete** — `getPropositionContext(propositionId)` added to `db.js`, exported, imported in `run.js`
- **Context injection** — `CATEGORY_TO_AGENTS` mapping in `runResearchAgent()` routes notes to the correct agents. `## ADMIN CONTEXT NOTES` block appended to agent `userPrompt` when relevant notes exist. Non-fatal if query fails.
- **Column name fix** — initial implementation used `note`; actual column in `proposition_context` is `content`. Fixed in `db.js` after reading website source.
- **ContextPanel category guide** — collapsible section added to `context-panel.tsx`. Shows badge, agent routing, use-case description, and example note for all 6 categories.
- **RunPanel confirm guard** — "Run Again" now requires two clicks. First click: button turns amber, label changes to "Confirm run?", Cancel link appears. Second click fires. Auto-cancels after 4 seconds if ignored. Prevents accidental re-runs.
- **`type="button"` fixes** — applied to the guide toggle in ContextPanel and the run button in RunPanel.
- **Website audit** — confirmed Steps 3–7 are all complete (Supabase connected, auth live, all admin pages built). HANDOFF updated to reflect actual state.

### Session 23 — Migration 010 run (2026-04-14)
- **Migration 010** — run against shared Supabase project
- **`moddatetime` extension** — had to be enabled explicitly via CLI before migration could run
- **New columns:** `clients.phone`, `propositions.sourcing_notes`, `propositions.additional_info`
- **New table:** `proposition_context` — admin enrichment per proposition, RLS enabled (service key only), indexed on `proposition_id`, auto-updating `updated_at`
- **Migration tooling:** `npx supabase link` + `npx supabase db query --linked` — Supabase CLI access token stored as `SUPABASE_LOGIN_TOKEN` in `.env`

### Session 22 — Backend steps 1 & 2 complete (2026-04-13)
- **`reports.yml`** — confirmed `proposition_id` input already present and correctly wired
- **Migration 009** — `industry_category` column added to `propositions`, camel milk proposition backfilled to `food_beverage`
- **`intake.js`** — `--industry-category` flag added: validation, passed through to `createProposition`

### Session 21 — Two-project state + V2 sequencing (2026-04-13)
- **Website project created** — `mckeever-consulting-website` on Vercel, bootstrapped with v0.app
- **Landing page deployed and live**
- **CLAUDE.md written** for the website project
- **v0.app free plan at limit** — not a blocker. Development continues directly in the codebase.
- **Full task order mapped** across both projects to reach V2 E2E test

### Sessions 18–19 — V1 close + V2 planning (2026-04-10 to 2026-04-11)
- V1 finalised: Census JSON retry fix, quality review/repair loop, stronger proofread checks, `--hold` flag dropped
- International research pipeline SOP written (`workflows/international_research.md`)
- Market positioning updated: the report is the product. No consulting call or follow-up meeting is included or implied.

---

## End-to-End Test (V1)

```
node run.js --proposition-id <camel-milk-proposition-id> --force
```

**What to watch for:**
```
✓ Admin context notes loaded: N note(s) [sourcing, regulatory, ...]  ← proposition_context rows
Venture intelligence brief: X chars, Y citations                     ← Perplexity call 1
Landscape briefing: X chars, Y citations                             ← Perplexity call 2
Running research agents (sequential)...
  → market_overview ... ✓
  → packaging ... ✓     ← runs Sonnet directly (sonnetOnly)
  → marketing ... ✓     ← runs Sonnet directly (sonnetOnly)
  → financials ... ✓    ← runs Sonnet directly (sonnetOnly)
  ... (remaining agents use Haiku; escalations logged with ↑)
✓ Quality gate passed (10/10 agents complete)
✓ Data confidence: XX/100  (target: 80+)
Calling Claude Sonnet for report synthesis...
  [section-by-section: 15 calls, ~20s delay between each]
  Running quality review (Haiku)...
  Running proofread pass (Sonnet)...
✓ PDF generated  ✓ PDF uploaded to Storage  ✓ Report emailed to 2 recipients
✓ Admin copy sent  ✓ Run complete
```

**If things break:**
| Issue | Fix |
|---|---|
| Assembler JSON parse fails | Add `console.log(rawContent.slice(0, 1000))` before `parseJSON()` in `callWithRepair()` |
| Resend 403 / domain not verified | Check Resend dashboard → Domains → `mckeeverconsulting.org`. All 3 TXT records (DKIM, SPF, DMARC) are in Namecheap DNS. |
| Storage upload fails | Confirm `reports` bucket exists and is private in Supabase dashboard |
| USDA NASS returns no data | Sometimes down — `executeTool` catches and returns `{ error: ... }`, agent handles gracefully |
| Census returns malformed JSON | Fixed — script retries up to 3 times then emits `{ error: "...", records: [] }`. Agent handles gracefully. |
| Context notes not injecting | Check `proposition_context` table — column is `content` (not `note`). Confirm rows exist with correct `proposition_id`. |
| PDF fails, re-run redoes all research | Fixed — `tryResumeFromContent()` finds a prior failed run's content JSON in Storage and jumps straight to PDF + email. Creates a fresh report record (not reusing the old one) so the admin panel's `createdAt`-based polling correctly detects completion. Old failed record stays as historical artifact. |
| Re-run finds no resumable content | Content JSON is only uploaded AFTER the assembler completes. If the run failed during research agents or the quality gate, there's nothing to resume — the full pipeline must re-run. |

---

## Commands

```bash
# Full pipeline runs
node run.js                                        # scheduled mode — picks up all due propositions
node run.js --proposition-id <id> --force          # on-demand, bypasses schedule guard

# PDF only (no agents, no email) — requires a completed run with stored content JSON
node run.js --regen-pdf --report-id <id>           # rebuilds PDF → saves to outputs/ for review

# Intake flow (in order)
node tools/intake.js --name "..." --email "..." ...         # creates prospect client + proposition
node tools/generate_proposal.js --proposition-id <id>       # generates + emails proposal PDF
node tools/activate.js --proposition-id <id>                # activates client, sets schedule

# Maintenance
node tools/cleanup.js --prune                      # dry-run: shows what would be deleted
node tools/cleanup.js --prune --confirm            # actually delete (runs automatically via GitHub Actions)
```

---

## Scheduling (GitHub Actions)

Two workflows in `.github/workflows/`:

| Workflow | File | Schedule | What it does |
|---|---|---|---|
| Report Run | `reports.yml` | Daily 13:00 UTC (07:00 CST) — `getDuePropositions()` decides what actually runs | Runs all propositions whose `next_run_at` is due |
| Weekly Cleanup | `cleanup.yml` | Every Sunday, 2 AM UTC | Prunes old reports, failed reports, expired cache |

Both have a manual "Run workflow" button in the GitHub Actions UI.
`reports.yml` has a `--force` toggle and a `proposition_id` input for targeted runs from the admin panel.

All secrets are stored in GitHub repo → Settings → Secrets and variables → Actions.

---

## Architecture

```
run.js              ← orchestrator (Node.js)
  ↓ reads
workflows/          ← plain-language SOPs (13 files)
  ↓ tools called by
tools/              ← Python scripts (execution layer)
db.js               ← all Supabase queries
.env                ← all credentials
.github/workflows/  ← GitHub Actions (scheduling + on-demand trigger)
outputs/            ← generated PDFs (auto-deleted after upload + email)
.tmp/               ← disposable intermediates (auto-deleted after each step)
assets/             ← fonts (auto-downloaded), brand assets
ROADMAP_V2.md       ← V2/V3 product vision and implementation plan
HANDOFF.md          ← this file
```

**Workflows (13 total):**
10 research agents (`research_market_overview`, `research_competitors`, `research_regulatory`, `research_production`, `research_packaging`, `research_distribution`, `research_marketing`, `research_financials`, `research_origin_ops`, `research_legal`) + `assemble_report` + `setup_website_project` + `international_research`

**Registered tools: 62** (58 original + 4 added Session 37: `search_news`, `fetch_financial_data`, `search_youtube`, `search_product_hunt`)

---

## run.js — How It Works

### Pre-run briefings (2 Perplexity calls, sequential, non-fatal)

| Call | Purpose |
|---|---|
| `runVentureIntelligence()` | Analyses the proposition — venture type, critical success factors, key risks, relevant regulatory bodies. Makes agents skip irrelevant gov tools. |
| `runCurrentLandscapeBriefing()` | Current-events snapshot — regulatory changes (last 12 months), market trends, new competitors, trade/political factors. |

Both are non-fatal — if Perplexity fails, agents fall back to their generic workflow SOPs.

### Admin context notes injection

After briefings, `getPropositionContext(proposition.id)` queries `proposition_context` and groups rows by `category` into `adminContextNotes`. This is attached to the shared `context` object and passed to every research agent.

Inside `runResearchAgent()`, `CATEGORY_TO_AGENTS` maps each category to the agents that should receive it:

| Category | Injected into |
|---|---|
| `sourcing` | `production`, `origin_ops` |
| `market` | `market_overview`, `competitors` |
| `regulatory` | `regulatory`, `legal` |
| `financial` | `financials` |
| `competitor` | `competitors` |
| `other` | All 10 agents |

Relevant notes appear in the agent's prompt as a `## ADMIN CONTEXT NOTES` block after the venture/landscape briefings, instructing the agent to treat them as authoritative scope adjustments. Non-fatal — no notes = block is simply omitted.

### Research agents (10 total, sequential)

Each agent: reads `workflows/research_<name>.md` → injects venture intelligence + landscape briefing + admin context notes → calls **Claude Haiku** in a tool-use loop (max 50 iterations) → JSON output saved to DB.

### Model escalation (Haiku → Sonnet)

Two triggers:
1. **Iteration exhaustion** — Haiku hits maxIter=50 without converging
2. **JSON parse failure** — output can't be parsed

Sonnet retry uses maxIter=20. If Sonnet also fails, agent is marked `failed`. Escalated runs log: `↑ market_overview completed via Sonnet escalation`

### Tools available to research agents

| Tool | Script | When used |
|---|---|---|
| `web_search` | `search_brave.py` | All agents — primary keyword search |
| `search_perplexity` | `search_perplexity.py` | All agents — 2 mandatory proactive synthesis calls per workflow. Returns AI-synthesized answers with citations. Called before Brave fails, not as a fallback. |
| `search_exa` | `search_exa.py` | All agents — 2 mandatory semantic/neural search calls per workflow. 6 depth modes (`instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning`), default `deep`. `similar` command for competitor/brand discovery. `category` filter available. |
| `search_tavily` | `search_tavily.py` | All agents — 1 mandatory `research` mode call per workflow. Full article text + synthesized answer across sources. |
| `fetch_jina_reader` | `fetch_jina_reader.py` | All agents — mandatory 3-URL batch read per workflow. Fetches full page content from the most data-rich URLs found in any prior search. |
| `fetch_fda_data` | `fetch_fda_data.py` | Food/drug propositions |
| `fetch_usda_data` | `fetch_usda_data.py` | Food/agriculture propositions |
| `fetch_census_data` | `fetch_census_data.py` | All — demographics + industry sizing |
| `fetch_usaspending_data` | `fetch_usaspending_data.py` | All — federal contracts/grants |
| `fetch_sec_edgar` | `fetch_sec_edgar.py` | All — public company filings |
| `fetch_bls_data` | `fetch_bls_data.py` | Manufacturing — wage benchmarks + employment trends (BLS v2) |
| `fetch_epa_data` | `fetch_epa_data.py` | Manufacturing/chemicals — ECHO compliance + TRI toxic releases |
| `fetch_itc_data` | `fetch_itc_data.py` | Import/export — trade remedy cases + Census annual import stats |

### Quality gate
- Hard fail: any critical agent null (`market_overview`, `regulatory`, `financials`, `origin_ops`)
- Hard fail: more than 1 agent failed total
- Soft fail: exactly 1 non-critical agent null — retries once, then continues with gap noted in report

### Assembler (section-by-section)
- **Claude Sonnet** (`claude-sonnet-4-6`), no tools
- 15 individual calls (~2–6k tokens each) instead of one giant call — eliminates JSON parse failures
- Each call has a 2-cycle repair loop via `callWithRepair()`
- **Prompt caching** — shared `researchContext` (~150k tokens) is passed as a cacheable prefix on all 15 calls. Saves ~$5/run via Anthropic's 5-min ephemeral TTL.
- 17s inter-section delay — balances TPM rate limit + cache TTL (15 × 17 = 255s < 300s TTL)
- **Haiku quality review** — compact structural audit. Non-fatal.
- **Sonnet proofread pass** — fixes cross-section repetition and clarity. Applied in-place before PDF build. Non-fatal.
- Content JSON uploaded to Storage **before** PDF build — enables `--regen-pdf` recovery if PDF fails
- **Failed-run resume** — if prior failed run has content JSON in Storage, `tryResumeFromContent()` skips all research agents and goes straight to PDF + email

### PDF output (`tools/generate_report_pdf.py`)
- ReportLab Platypus — block-based layout
- Block types: `paragraph`, `bullets`, `table`, `callout`, `key_figures`
- Table column widths are content-aware (proportional to max content length per column)
- Brand: Navy `#1C3557` + Gold `#C8A94A` + Silver `#8A9BB0`, Montserrat font

### Multi-recipient delivery
- `proposition_recipients` table controls who gets the report per proposition
- Falls back to `proposition.client_id` if no recipients are seeded
- Separate admin copy sent to `ADMIN_EMAIL` (env var) listing all recipients

### Plan tier gating (post-run)
After each successful run, `advancePropositionSchedule()` checks plan tier + completed report count:

| Plan | Runs included | Behaviour after limit |
|---|---|---|
| Starter | 1 | Flips `schedule_type` to `on_demand` — stops auto-running |
| Pro | 2 | Flips `schedule_type` to `on_demand` — stops auto-running |
| Retainer | Unlimited | Always advances `next_run_at` by one month |

---

## DB Schema

**13 migrations run (001–013).**

| Table | Purpose |
|---|---|
| `organizations` | Companies/entities — has `status` and `plan_tier` |
| `organization_admins` | Who administers each org (email-based, independent of clients) |
| `clients` | Individual contacts — linked to an org via `organization_id` |
| `propositions` | Business propositions — has schedule fields, `plan_tier`, `organization_id` |
| `proposition_recipients` | Which contacts receive the report for each proposition |
| `reports` | One row per run — `status`, `run_number`, `previous_report_id` |
| `agent_outputs` | Temporary research data — deleted post-run (or at failure) |
| `report_sources` | Source URLs cited in reports |
| `api_cache` | ⚠️ **Unused scaffolding — review and repurpose.** `getCachedApiResponse` / `setCachedApiResponse` are defined and exported in `db.js` but never called. Brave Search uses a separate `search_cache` table. Anthropic prompt caching is handled server-side by Anthropic (no DB needed). Potential use: cache Perplexity briefings between runs on the same proposition so repeated runs don't re-spend those credits. |
| `proposition_context` | Admin-added enrichment per proposition. Column: `content` (TEXT). Categories: `sourcing`, `market`, `regulatory`, `financial`, `competitor`, `other`. RLS enabled — service key only. Backend reads this at run start and injects into agent prompts. |

**New fields added in migration 010:**
- `clients.phone` — VARCHAR(50), NOT NULL default `''`
- `propositions.sourcing_notes` — TEXT, nullable
- `propositions.additional_info` — TEXT, nullable

**New fields added in migration 011:**
- `organizations.is_test` — BOOLEAN NOT NULL DEFAULT false
- `clients.is_test` — BOOLEAN NOT NULL DEFAULT false
- `propositions.is_test` — BOOLEAN NOT NULL DEFAULT false

**New fields added in migration 012:**
- `propositions.client_context` — JSONB DEFAULT NULL. Keys: `product_scope`, `development_stage`, `price_point`, `revenue_model` (array), `customer_type`, `ideal_customer`, `sales_channel`, `comparable_brands`, `key_differentiator`, `starting_capital`, `company_location`, `credentials`, `existing_resources`, `capital_secured_exact`, `primary_question`, `legal_sensitivities`. Injected into all research agent prompts as `## CLIENT CONTEXT` block.

**New fields added in migration 013:**
- `reports.formatting_notes` — TEXT, nullable. Used by the admin formatting panel to store per-report presentation notes.

**Extensions enabled:** `moddatetime` — required for the `proposition_context.updated_at` trigger.

**Organization status values:** `prospect | pending | active | cancelled | inactive`
- `getDuePropositions()` only returns propositions from `active` orgs

**Plan tier values:** `starter | pro | retainer`

**proposition_type values:** `physical_import_export | physical_domestic | saas_software | service_business | digital_product`

Only `physical_import_export` and `physical_domestic` have workflows. V2 adds industry-aware routing.

**industry_category values:** `food_beverage | energy_clean_tech | medical_devices | chemicals_materials | electronics | apparel_textiles | cosmetics | general_manufacturing`

**Data retention:** See `tools/cleanup.js`.
- Completed reports: 6-month window (always keeps most recent per proposition)
- Failed reports: 7-day TTL
- `agent_outputs`: deleted immediately on successful run completion. On failure, **preserved** so the resume path can re-compute the data confidence score. Cleaned up by `tryResumeFromContent()` after a successful resume, or when the next run finds a failed report with no content JSON.
- `api_cache`: 7-day TTL

---

## API Keys (.env)

**Search quality tools (V2 — new):**

| Key | Variable | Notes |
|---|---|---|
| Tavily | `TAVILY_API_KEY` | ✅ Active — 1,000 free calls/month. Returns full article text, not snippets. |
| Exa AI | `EXA_API_KEY` | ✅ Active — 1,000 free searches/month. Semantic/neural search. |
| Jina Reader | `JINA_API_KEY` | ✅ Active — higher rate limits with key. Free without key too. |
| UN Comtrade | `UN_COMTRADE_API_KEY` | ✅ Active — Free APIs tier (comtrade-v1). 500 req/hr. `tools/fetch_un_comtrade.py` built. |

**Currently active (Session 37 additions):**

| Key | Variable | Notes |
|---|---|---|
| NewsAPI | `NEWS_API_KEY` | ✅ Active — 100 req/day free dev tier. `tools/search_news.py` built. |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | ✅ Active — free tier (5 req/min). Part of `tools/fetch_financial_data.py`. |
| Massive (Polygon) | `MASSIVE_API_KEY` | ✅ Active — formerly Polygon.io, same endpoint. Part of `tools/fetch_financial_data.py`. |
| Finnhub | `FINNHUB_API_KEY` | ✅ Active — free tier (60 req/min). Part of `tools/fetch_financial_data.py`. |
| Product Hunt | `PRODUCT_HUNT_API_KEY`, `PRODUCT_HUNT_API_SECRET`, `PRODUCT_HUNT_DEV_TOKEN` | ✅ Active — dev token never expires. `tools/search_product_hunt.py` built. |

**Currently active (V1/V2):**

| Key | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| Supabase CLI | `SUPABASE_LOGIN_TOKEN` |
| Brave Search | `BRAVE_SEARCH_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| openFDA | `OPEN_FDA_API_KEY` |
| USDA FDC | `USDA_FDC_API_KEY` |
| USDA NASS | `USDA_NASS_API_KEY` |
| Census | `CENSUS_API_KEY` |
| Exchange Rate | `EXCHANGE_RATE_API_KEY` |
| Resend | `RESEND_API_KEY` |
| YouTube | `YOUTUBE_API_KEY` |
| BLS (v2) | `BLS_V2_API_Key` |

USASpending.gov, SEC EDGAR, EPA ECHO, Federal Register, and the Census international trade API require no key.

**Website project `.env.local` (separate file in `mckeever-consulting-website`):**

| Key | Variable | Notes |
|---|---|---|
| Supabase URL | `NEXT_PUBLIC_SUPABASE_URL` | Same project as backend |
| Supabase anon key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Safe to expose to browser |
| Supabase service key | `SUPABASE_SERVICE_KEY` | Server-side only |
| GitHub token | `GITHUB_TOKEN` | Fine-grained PAT — Actions read/write on `Camel-Milk-Business-Plan` repo |
| GitHub repo owner | `GITHUB_REPO_OWNER` | Your GitHub username |

---

## Comprehensive API Master List

Everything we plan to integrate across V2 and V3, organized by category. Includes signup actions where registration is needed.

---

### Translation & Language

**Decision (Session 30):** No external translation API. Agents (Claude) translate non-English sources inline during the tool-use loop. Claude handles all languages natively — quality is better than any translation API and no additional cost/key/signup is needed. `international_research.md` updated to reflect this. `translate_text.py`, `detect_language.py`, and `normalize_international_data.py` are dropped from the build plan.

---

### International Trade & Economic Data (V2 — free, no cost)

These all require no payment. Register where noted.

| API | Variable | Notes | Action |
|---|---|---|---|
| **UN Comtrade** | `UN_COMTRADE_API_KEY` | Bilateral trade flows, all countries, HS code level. 500 req/hour free. Essential for any import/export proposition targeting a non-US market. | Register at comtradeplus.un.org |
| **World Bank Open Data** | *(no key)* | GDP, income, population, inflation, ease-of-doing-business, all countries. Fully open. | No action needed |
| **IMF Data API** | *(no key)* | Macroeconomic + financial indicators, all countries. Fully open. | No action needed |
| **OECD API** | *(no key)* | OECD member country stats — labour, trade, taxes, business. Often available in French/German. | No action needed |
| **Eurostat API** | *(no key)* | EU statistical data — industry production, import/export, population, in all EU languages. | No action needed |
| **FAO STAT API** | *(no key)* | Global food and agriculture data. Critical for food/beverage propositions in non-US markets. | No action needed |
| **WTO Tariff API** | *(no key)* | Bound and applied tariff rates, all WTO member countries. Useful for import/export cost modeling. | No action needed — docs at wto.org/english/res_e/statis_e |
| **OpenCorporates API** | `OPENCORPORATES_API_KEY` | 160M+ company records, 140+ jurisdictions, local-language. Best for competitor research in non-English markets. Free rate-limited tier. | Register at opencorporates.com/api_accounts |

---

### Global News & Media Intelligence (V2)

| API | Variable | Free Tier | Notes | Action |
|---|---|---|---|---|
| **GDELT Project** | *(no key)* | Fully free | Global news events, 170 countries, 65 languages, updated every 15 min. No key, no rate limit. Best free international news source. | No action needed — base URL: `api.gdeltproject.org` |
| **MediaStack** | `MEDIASTACK_API_KEY` | 500 req/month | 7,500+ sources, 50+ countries, multilingual. Paid tier from $9.99/month. | Register at mediastack.com |
| **NewsAPI** | `NEWS_API_KEY` | 100 req/day (dev) | ~80,000 sources, international. Dev plan sufficient for testing. Paid from $449/month for production. | Register at newsapi.org |

GDELT covers most international news needs for free. Add MediaStack only if GDELT event data proves insufficient for a specific market.

---

### US Government Data (V2 — already built or planned by industry)

| Tool | Variable | Status | Industry |
|---|---|---|---|
| FDA openFDA | `OPEN_FDA_API_KEY` | ✅ Built | Food/drug |
| USDA FoodData Central + NASS | `USDA_FDC_API_KEY`, `USDA_NASS_API_KEY` | ✅ Built | Food/agriculture |
| Census ACS + CBP | `CENSUS_API_KEY` | ✅ Built | All industries |
| BLS wages + employment | `BLS_V2_API_Key` | ✅ Built | Manufacturing |
| EPA ECHO + TRI | *(no key)* | ✅ Built | Manufacturing/chemicals |
| ITC trade remedy + Census trade | *(no key)* | ✅ Built | Import/export |
| SEC EDGAR | *(no key)* | ✅ Built | All — public company research |
| USASpending.gov | *(no key)* | ✅ Built | All — federal contracts/grants |
| DOE EIA + NREL | *(no key)* | Build before solar proposition | Energy/clean tech |
| FDA device 510(k) | *(no key)* | Build before medical proposition | Medical devices |
| BIS export controls (ECCN) | *(no key)* | Build before electronics proposition | Electronics |
| CBP import rules | *(no key)* | Build before apparel proposition | Apparel/textiles |
| FTC labelling rules | *(no key)* | Build before apparel proposition | Apparel/textiles |
| CPSC product safety | *(no key)* | Build before apparel/consumer proposition | Apparel/consumer products |

---

### Non-Physical Product Intelligence (V3 — SaaS / Digital / Services)

These are needed when proposition type is `saas_software`, `digital_product`, or `service_business`.

| API | Variable | Free Tier | Notes | Action |
|---|---|---|---|---|
| **Crunchbase API** | `CRUNCHBASE_API_KEY` | None — $29/month minimum | Startup funding, valuations, investor data, competitive landscape. Best source for venture-stage competitive research. | Sign up at data.crunchbase.com/docs |
| **SimilarWeb API** | `SIMILARWEB_API_KEY` | Limited free | Website traffic, engagement, digital market share. Essential for digital product competitive analysis. Paid tiers start ~$125/month. | Register at similarweb.com/corp/developer |
| **G2 API** | `G2_API_KEY` | ⛔ Restricted to G2 vendors | API access restricted to companies that list their own products on G2. Cannot be used for third-party competitive research. Use Brave `site:g2.com` queries instead. | N/A — blocked |
| **App Store Connect** | *(OAuth per client)* | Free for owned accounts | Client's own iOS app metrics — downloads, ratings, revenue. No third-party competitor data available via API. | Apple developer account required |
| **Google Play Developer API** | *(OAuth per client)* | Free for owned accounts | Client's own Android app stats. | Google Play developer account required |
| **SBA Small Business Data** | *(no key)* | Fully free | Small business benchmarks, loan data, industry failure rates. Useful for services propositions. | No action needed — api.sba.gov |
| **GitHub API** | `GITHUB_API_TOKEN` | 5k req/hour free | Repository activity, developer adoption, open-source ecosystem mapping. Useful for developer-tool SaaS. | github.com/settings/tokens |
| **Reddit API (PRAW)** | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Free, 60 req/min | Community sentiment, micro-influencer discovery, niche trend signals. Health/food niches are highly active. | ⛔ Blocked — registration process tried and failed. Use Perplexity + Brave for community sentiment instead. |
| **Product Hunt API** | `PRODUCT_HUNT_DEV_TOKEN` | ✅ Active — Free | Launch tracking, upvote velocity, product discovery trends. `tools/search_product_hunt.py` built. Use dev token (never expires), not OAuth. | Done |

---

### Social Media Intelligence (V3 — Marketing Agent)

Already documented in ROADMAP_V2.md. Build order: YouTube → Instagram → TikTok → Pinterest → X. (Reddit blocked — registration failed; use Perplexity + Brave for community sentiment instead.)

| Platform | Variable | Status |
|---|---|---|
| YouTube Data API v3 | `YOUTUBE_API_KEY` | ✅ Active — `tools/search_youtube.py` built. search_channels, channel_stats, search_videos, channel_videos commands. |
| Reddit (PRAW) | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | ⛔ Blocked — registration failed. Use Perplexity + Brave instead. |
| Instagram (Meta Graph) | *(OAuth per client)* | Build with V3 |
| TikTok Research API | `TIKTOK_API_KEY` | ⛔ Blocked — restricted to academic/non-profit only. Commercial use = permanent revocation. Use Perplexity + Brave for TikTok trend research. |
| Pinterest API v5 | `PINTEREST_API_KEY` | Build with V3 |
| X (Twitter) API v2 | `X_API_KEY` | Low priority — $100/month basic tier |

---

### Global Product & IP Data (V2/V3 — build when needed)

| API | Variable | Notes | Action |
|---|---|---|---|
| **WIPO PATENTSCOPE** | *(no key)* | Global patent search, all countries. Useful for medical device and electronics propositions. | No action needed — patentscope.wipo.int/search/en/search.jsf |
| **WIPO Global Brand Database** | *(no key)* | International trademark search. Useful for any proposition with brand/naming risks in international markets. | No action needed |
| **EU RAPEX API** | *(no key)* | EU product safety alerts and recalls. Useful for consumer goods propositions targeting EU market. | No action needed — ec.europa.eu/consumers/consumers_safety/safety_products/rapex |
| **GS1 Registry** | *(no key)* | Global product identification (barcodes, GTINs). Useful for physical goods entering retail channels. | No action needed — gs1.org/services/verified-by-gs1 |

---

### Exchange Rate & Currency (Already Active)

| API | Variable | Notes |
|---|---|---|
| Exchange Rate API | `EXCHANGE_RATE_API_KEY` | Active. Used by `normalize_international_data.py` for local currency → USD conversion. |

---

## Locked Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Claude Haiku (tool-use loop) + Brave Search + gov APIs |
| 2 | Report structure | 14 sections + Sources + data confidence score |
| 3 | Delivery | Resend email, PDF attached. All proposition recipients + Brendon admin copy. |
| 4 | Run trigger | Scheduled (`next_run_at`) or `--force`. Website uses GitHub Actions `workflow_dispatch`. |
| 5 | Delta tracking | Full fresh report every run + "What Changed" section from run 2+ |
| 6 | Agent architecture | Haiku (research, tool-use) → Sonnet (assembly, synthesis) |
| 7 | Viability score | 6 factors × weights, each 1–5. 4–5=Strong / 2.5–3.9=Moderate / 1–2.4=Weak |
| 8 | Data confidence | 0–100 score (field confidence 45%, completion 25%, sources 20%, gaps 10%) |
| 9 | Quality gate | Hard fail: critical agent null or >1 agent failed. Soft fail: 1 non-critical null (retries once). |
| 10 | Brave throttling | 500ms delay + exponential backoff, max 3 retries |
| 11 | Failure alerting | Email to Brendon only. Client never notified. Error logged to DB. `agent_outputs` preserved on failure (needed by resume for confidence re-computation); deleted after resume completes. |
| 12 | Brand | McKeever Consulting. Navy `#1C3557` + Gold `#C8A94A` + Silver `#8A9BB0`. Montserrat. |
| 13 | Pricing | Starter $150 (1 run) / Retainer $150/month (1 run/month included). Additional runs above the monthly inclusion are $150 each. **TODO: update website copy and intake language to reflect this — the retainer is not "unlimited".** |
| 14 | Model escalation | Haiku → Sonnet on iteration exhaustion or JSON parse failure. Ceiling = Sonnet. `financials`, `packaging`, `marketing` skip Haiku entirely (`sonnetOnly: true`). |
| 15 | Perplexity roles | (1) Proactive mandatory synthesis — 2 calls per research agent workflow (not a fallback), (2) Venture intelligence brief (pre-run), (3) Landscape briefing (pre-run). Proactive design confirmed Session 33: Perplexity returns synthesized answers with citations, not links to parse. Called alongside Brave, not after it fails. |
| 16 | Industry adaptability | Venture intelligence brief steers agents away from irrelevant gov tools. Structural routing deferred to V2. |
| 17 | Client model | Organizations own propositions. Contacts (clients) belong to orgs. Per-proposition recipient lists via `proposition_recipients`. |
| 18 | Org status gating | Only `active` orgs run reports. Flip to `inactive`/`cancelled` to pause without deleting data. |
| 19 | Plan tier gating | Starter/Pro retire to `on_demand` after their run limit. Retainer advances indefinitely. |
| 20 | Scheduling | GitHub Actions — cleanup weekly (Sunday 2 AM UTC), reports daily (13:00 UTC) with `getDuePropositions()` gating actual runs. |
| 21 | Admin independence | Brendon is admin of McKeever Consulting via `organization_admins` table — independent of his client record. |
| 22 | Assembler architecture | Section-by-section (15 Sonnet calls, 2-cycle repair each) + Haiku structural review + Sonnet proofread pass. Content JSON uploaded before PDF build. |
| 23 | MCP | Ruled out (2026-04-13). Declining adoption, more problems than it solves. Tool layer stays as Python subprocesses. |
| 24 | Website run trigger | GitHub Actions `workflow_dispatch` — no new servers needed. Admin panel calls GitHub API with `proposition_id` input. |
| 25 | Website tech stack | Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui + Supabase JS client. Deployed on Vercel. |
| 26 | Website auth | Supabase Auth for admin panel. Intake form is public. |
| 27 | Website/backend separation | Separate repos. Shared Supabase project. No API layer between them — website reads/writes DB directly. |
| 28 | Admin context notes | `proposition_context` table. Column: `content`. Injected into agent prompts by category at run start. Non-fatal if empty. |
| 29 | Run Again guard | Two-step confirm on "Run Again" button (4s timeout, amber state). Prevents accidental re-runs. |

---

## Roadmap Summary

See `ROADMAP_V2.md` for full detail.

| Phase | Status | Key work |
|---|---|---|
| V1 | ✅ Complete | Physical import/export pipeline. E2E tested. |
| Website | ✅ Complete | All pages built and live. Intake form expanded with 6 new fields. |
| V2 | ✅ Complete | E2E furniture test confirmed 2026-04-23. Consultant brief cancelled. |
| V3 | Future | SaaS, services, digital, franchise — new workflow sets, dynamic agent selection, social media research layer |
| Existing Business Analysis | Future (after V3) | Same pipeline, new assembler framing. Audit + strategy report for operating businesses. |
