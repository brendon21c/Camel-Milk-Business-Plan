# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-16 (Session 27 — Prompt caching, failed-run resume, PDF fix, financials token fix, proposition auto-activate on sign, code review + bug fixes.)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: Perplexity briefings → research agents → assembler → branded PDF → Resend email → client inbox.

**There are two projects:**

| Project | Location | Purpose |
|---|---|---|
| `Camel-Milk-Business-Plan` | This repo | Backend report engine — agents, tools, PDF generation, scheduling |
| `mckeever-consulting-website` | Sibling repo, also on Vercel | Client-facing website — landing page, intake form, admin panel |

They share the same Supabase project. The website writes intake data; the backend reads it and delivers reports. The admin panel triggers backend runs via GitHub Actions `workflow_dispatch`.

---

## Seed IDs

| Record | ID |
|---|---|
| Organization (B & I) | query `organizations` by `name = 'B & I'` |
| Organization (McKeever Consulting) | query `organizations` by `name = 'McKeever Consulting'` |
| Client — Brendon McKeever | `ea134c2d-547e-4fcb-b475-65383680c8fb` |
| Client — Iman Warsame | query `clients` by `email = 'imanw22@gmail.com'` |
| Proposition (Camel Milk Export) | `54f51272-d819-4d82-825a-15603ed48654` |
| Supabase project | `https://vupnhlpwfqwmrysohhrq.supabase.co` |

---

## Current State (as of 2026-04-16)

### Backend — `Camel-Milk-Business-Plan` ✅ V1 + Step 2.5 + caching + resume complete

- V1 pipeline fully working and tested
- E2E test passed 2026-04-10. Report delivered to Iman Warsame and Brendon McKeever
- 12 migrations run (001–012)
- **Step 2.5 complete:** `getPropositionContext()` added to `db.js`. At run start, backend queries `proposition_context`, groups rows by category, and injects relevant notes into each research agent's prompt as a `## ADMIN CONTEXT NOTES` block. Category → agent mapping is in `run.js` (`CATEGORY_TO_AGENTS`).
- **`proposition_context` column:** the text content is stored in `content` (not `note`) — confirmed from website source
- **Prompt caching live:** `streamSonnetCall` and `callWithRepair` accept `useCache`/`cacheablePrefix` params. All 15+ assembler section calls pass the shared `researchContext` as the cached prefix. Saves ~$5/run (~40% cost reduction) via Anthropic's 5-minute ephemeral cache TTL. Inter-section delay is 17s (15 × 17 = 255s, safely under 300s TTL).
- **Failed-run resume live:** `tryResumeFromContent()` runs before creating a new report record. If a prior failed run has a content JSON in Supabase Storage, skips all research agents and jumps straight to PDF + email. Handles post-assembly failures (PDF crash, upload error, email failure) without re-spending ~$8 in API costs.
- **Financials token fix:** Sonnet escalation `maxTokens` raised from 16000 → 32000. Prevents JSON truncation on large financial outputs.
- **GitHub Actions Python fix:** `reports.yml` now includes `actions/setup-python@v5` and `pip install -r requirements.txt`. Fixes `ModuleNotFoundError` for `httpx`/`dotenv` that caused PDF generation failures.
- **Assembler instructions genericised:** Removed hardcoded "Somalia-specific" and "FDA guidelines" language from section templates. Now works correctly for any proposition type.
- **Pending for V2:** Industry routing, consultant brief, new gov tool scripts, international research pipeline

**Note:** Proposition is set to `plan_tier = 'retainer'` in Supabase to allow the May 1 auto-run test. After May run confirms scheduling works, flip back to `starter`.

**Plate to Plate proposition:** Contract was signed before auto-activate fix was deployed — flip `propositions.status = 'active'` manually in Supabase. Then trigger a run from the admin panel. The resume logic should detect saved content from the last failed run (run #8) and skip research agents.

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

### Immediate — Before next run

1. **Manually activate "Plate to Plate" proposition** — flip `propositions.status = 'active'` in Supabase (the auto-activate fix was deployed after the contract was already signed).
2. **Trigger a run** from the admin panel. Resume logic should detect the saved content JSON from run #8 and skip research agents, going straight to PDF. Verify the report is delivered.
3. **Verify prompt caching** — after the run, check the Anthropic usage dashboard for `cache_read_input_tokens`. Should see a large number of cached tokens across the 15 assembler calls.

### Step 8 — V2 End-to-End Test ← next milestone

This is the only thing left before the system is fully V2-ready. Run the complete flow:

**Test proposition:** Furniture manufacturing, Minnesota → US (domestic physical product). Scoped to US market only — Europe requires the international research pipeline which is not yet built.

**Gov tool scripts are built and tested** (Session 25):
- `tools/fetch_itc_data.py` ✅ — Federal Register trade remedy cases + Census annual import stats by NAICS
- `tools/fetch_epa_data.py` ✅ — EPA ECHO facility compliance search + Toxic Release Inventory
- `tools/fetch_bls_data.py` ✅ — BLS manufacturing wage benchmarks + employment trends (v2 API with key)

**Flow:**
1. Open `/intake` as a "client" — fill out for furniture manufacturing, Minnesota → US. Use a fresh client/org — this validates the intake form creates new DB records correctly, not just re-running an existing proposition
2. Check `/admin/propositions` — new submission appears
3. Navigate to the proposition detail page — add a context note for the run (e.g. a sourcing note about the wood supply chain)
4. Hit **Run Now** → backend fires via GitHub Actions
5. Watch status update live (polling every 5 seconds)
6. Report generates, PDF delivered, view/download from the reports table on the detail page or `/admin/reports`

If the intake form submission path hasn't been activated yet (org status still `prospect`), use `tools/activate.js` to flip it to `active` before hitting Run Now.

**Europe market version** of this proposition (Minnesota → US + Europe) is deferred until the international research pipeline is built (UN Comtrade, GDELT, translation tools).

---

## V2 Backend Work (after E2E test passes)

1. **Industry-aware gov data routing** — replace the flat `executeTool` switch with routing based on `industry_category`. Non-applicable tools return a structured "not applicable" so agents don't waste iterations.
2. **Remaining gov tool scripts** — ITC/EPA/BLS are done. Still to build when needed:
   - `tools/fetch_doe_data.py` — DOE EIA + NREL (energy/solar) ← build before solar test proposition
   - `tools/fetch_fda_device_data.py` — FDA 510(k) clearances + device recalls (medical) ← build before medical test proposition
   - `tools/fetch_bis_data.py` — BIS export control classifications ← build before electronics test proposition
3. **Workflow generalisation** — audit the 10 research workflows, remove food-specific hardcoding. Start with Option A (venture intelligence brief steers tool selection). Move to Option B (per-industry substitution blocks) only if results are poor.
4. **Consultant Intelligence Brief** — new `workflows/assemble_consultant_brief.md`, new `runConsultantBriefAgent()` in `run.js`, new `tools/generate_consultant_brief_pdf.py`. Uses same `agent_outputs` already in DB — no additional research API calls. Delivered as a single admin email with both PDFs (client report + consultant brief) attached.
5. **Prompt caching on the assembler** — add `cache_control: { type: "ephemeral" }` on the system prompt and research context blocks in the assembler's API calls. Saves ~$5/run (~40% total cost reduction).
6. **International research pipeline** — `tools/translate_text.py`, `tools/detect_language.py`, `tools/normalize_international_data.py`, `tools/fetch_gdelt_news.py`, `tools/fetch_opencorporates.py`, `tools/fetch_un_comtrade.py`. New API keys needed: DeepL, Google Cloud Translation, MyMemory, UN Comtrade, OpenCorporates.

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
- Market positioning locked: the consulting service (consultant brief + meeting) is the product, not the report generator

---

## End-to-End Test (V1)

```
node run.js --proposition-id 54f51272-d819-4d82-825a-15603ed48654 --force
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
| PDF fails, re-run redoes all research | Fixed — `tryResumeFromContent()` checks for a prior failed run's content JSON in Storage before creating a new report record. If found, skips all research agents and goes straight to PDF + email. |
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
| `web_search` | `search_brave.py` | All agents (primary source) |
| `fetch_fda_data` | `fetch_fda_data.py` | Food/drug propositions |
| `fetch_usda_data` | `fetch_usda_data.py` | Food/agriculture propositions |
| `fetch_census_data` | `fetch_census_data.py` | All — demographics + industry sizing |
| `fetch_usaspending_data` | `fetch_usaspending_data.py` | All — federal contracts/grants |
| `fetch_sec_edgar` | `fetch_sec_edgar.py` | All — public company filings |
| `fetch_bls_data` | `fetch_bls_data.py` | Manufacturing — wage benchmarks + employment trends (BLS v2) |
| `fetch_epa_data` | `fetch_epa_data.py` | Manufacturing/chemicals — ECHO compliance + TRI toxic releases |
| `fetch_itc_data` | `fetch_itc_data.py` | Import/export — trade remedy cases + Census annual import stats |
| `search_perplexity` | `search_perplexity.py` | Fallback when Brave is thin |

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
- Separate admin copy sent to `brennon.mckeever@gmail.com` listing all recipients

### Plan tier gating (post-run)
After each successful run, `advancePropositionSchedule()` checks plan tier + completed report count:

| Plan | Runs included | Behaviour after limit |
|---|---|---|
| Starter | 1 | Flips `schedule_type` to `on_demand` — stops auto-running |
| Pro | 2 | Flips `schedule_type` to `on_demand` — stops auto-running |
| Retainer | Unlimited | Always advances `next_run_at` by one month |

---

## DB Schema

**12 migrations run (001–012) — run 011 then 012 before deploying.**

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
| `api_cache` | Brave Search cache — 7-day TTL |
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
- `propositions.client_context` — JSONB DEFAULT NULL. Keys: `product_scope`, `development_stage`, `price_point`, `revenue_model` (array), `customer_type`, `ideal_customer`, `sales_channel`, `comparable_brands`, `key_differentiator`. Injected into all research agent prompts as `## CLIENT CONTEXT` block.

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
- `agent_outputs`: deleted immediately on run completion or failure
- `api_cache`: 7-day TTL

---

## API Keys (.env)

**Currently active (V1):**

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

**To add for V2 — international research pipeline:**

| Key | Variable | Notes |
|---|---|---|
| DeepL | `DEEPL_API_KEY` | 500k chars/month free |
| Google Cloud Translation | `GOOGLE_TRANSLATE_API_KEY` | 500k chars/month free. Best for Arabic, CJK |
| MyMemory | `MYMEMORY_API_KEY` | 10k chars/day free. Fallback |
| UN Comtrade | `UN_COMTRADE_API_KEY` | Free, 500 req/hour. Bilateral trade flows |
| OpenCorporates | `OPENCORPORATES_API_KEY` | Free, rate-limited. 160M+ company records |

GDELT, World Bank, IMF, and Eurostat require no key.

**Website project `.env.local` (separate file in `mckeever-consulting-website`):**

| Key | Variable | Notes |
|---|---|---|
| Supabase URL | `NEXT_PUBLIC_SUPABASE_URL` | Same project as backend |
| Supabase anon key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Safe to expose to browser |
| Supabase service key | `SUPABASE_SERVICE_KEY` | Server-side only |
| GitHub token | `GITHUB_TOKEN` | Fine-grained PAT — Actions read/write on `Camel-Milk-Business-Plan` repo |
| GitHub repo owner | `GITHUB_REPO_OWNER` | Your GitHub username |

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
| 11 | Failure alerting | Email to Brendon only. Client never notified. Error logged to DB. agent_outputs deleted immediately on failure. |
| 12 | Brand | McKeever Consulting. Navy `#1C3557` + Gold `#C8A94A` + Silver `#8A9BB0`. Montserrat. |
| 13 | Pricing | Starter $100 (1 run) / Pro $250 (2 runs) / Retainer $150/month (unlimited) |
| 14 | Model escalation | Haiku → Sonnet on iteration exhaustion or JSON parse failure. Ceiling = Sonnet. `financials`, `packaging`, `marketing` skip Haiku entirely (`sonnetOnly: true`). |
| 15 | Perplexity roles | (1) Fallback when Brave thin, (2) Venture intelligence brief, (3) Landscape briefing. |
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
| Website | ✅ Complete | All pages built and live. One E2E test remaining. |
| V2 | Planned | Industry-aware routing · new gov tool scripts · workflow generalisation · consultant brief · prompt caching · international research pipeline |
| V3 | Future | SaaS, services, digital, franchise — new workflow sets, dynamic agent selection, social media research layer |
