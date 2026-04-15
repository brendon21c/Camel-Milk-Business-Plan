# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-14 (Session 23 — Migration 010 run. clients.phone, propositions.sourcing_notes/additional_info added. proposition_context table created. moddatetime extension enabled.)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: Perplexity briefings → research agents → assembler → branded PDF → Resend email → client inbox.

**There are now two projects:**

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

## Current State (as of 2026-04-13)

### Backend — `Camel-Milk-Business-Plan` ✅ V1 complete

- V1 pipeline fully working and tested
- E2E test passed 2026-04-10. Report delivered to Iman Warsame and Brendon McKeever
- 9 migrations run (001–009)
- **`proposition_id` input:** Present in `reports.yml` — targeted run step + scheduled fallback both wired correctly
- **Migration 009:** Run ✅ — `industry_category` column live on `propositions`, camel milk proposition backfilled to `food_beverage`
- **Migration 010:** Run ✅ — `clients.phone`, `propositions.sourcing_notes`, `propositions.additional_info` added; `proposition_context` table created with RLS; `moddatetime` extension enabled
- **`intake.js`:** Updated to accept `--industry-category`, validates against allowed values, passes through to `createProposition`
- **Pending for V2:** Industry routing, consultant brief, prompt caching, new gov tool scripts, international research pipeline

**Note:** Proposition is currently set to `plan_tier = 'retainer'` in Supabase to allow the May 1 auto-run test. After May run confirms scheduling works, flip back to `starter`.

### Website — `mckeever-consulting-website` 🔄 In progress

- **Stack:** Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui
- **Deployment:** Vercel — landing page is live
- **Bootstrapped with:** v0.app (free plan now at limit — not a blocker, development continues directly in codebase)
- **CLAUDE.md:** Written and in place — contains full schema, pages, brand tokens, intake form question set, tech decisions
- **Supabase:** NOT yet connected — `.env.local` needs keys, `lib/supabase.ts` not created yet
- **What's built:** Landing page only
- **What's not built:** `/intake`, `/admin`, `/admin/propositions`, `/admin/reports`, `/admin/clients`

---

## What Is Next — Ordered Task List

Steps 1–2 are complete. Remaining work is in the website project (`mckeever-consulting-website`).

### ~~Step 1 — Backend: `reports.yml` proposition_id input~~ ✅ Already done
`proposition_id` input was already present and correctly wired — targeted run step + scheduled fallback both in place.

### ~~Step 2 — Backend: Migration 009 + `intake.js` update~~ ✅ Complete (2026-04-13)
- `migrations/009_add_industry_category.sql` created and run in Supabase
- `industry_category TEXT CHECK (...)` column live on `propositions`
- Camel milk proposition backfilled to `food_beverage`
- `tools/intake.js` updated: `--industry-category` flag, validation, passes through to `createProposition`

### Step 2.5 — Backend: Inject `proposition_context` into research agent prompts

The `proposition_context` table is live in Supabase and the admin panel's Context Panel is already writing to it. The backend does not yet read it.

**What needs to happen in `run.js` (or `db.js`):**
1. At the start of each report run, query `proposition_context` where `proposition_id` matches the current run's proposition
2. Group the returned rows by `category` (`sourcing`, `market`, `regulatory`, `financial`, `competitor`, `other`)
3. Inject the relevant notes as additional context into the appropriate research agent's prompt for that category — e.g. rows with `category = 'regulatory'` get appended to the `research_regulatory` agent's prompt, `category = 'market'` to `research_market_overview`, etc.

**Category → agent mapping (suggested):**
| Category | Agent(s) |
|---|---|
| `sourcing` | `research_production`, `research_origin_ops` |
| `market` | `research_market_overview`, `research_competitors` |
| `regulatory` | `research_regulatory`, `research_legal` |
| `financial` | `research_financials` |
| `competitor` | `research_competitors` |
| `other` | All agents (inject into each) |

No schema changes needed — table, RLS, and indexes are already in place. Use `SUPABASE_SERVICE_KEY` to query (RLS blocks anon key).

### Step 3 — Website: Connect Supabase
- `.env.local` ✅ already populated (all keys present including `GITHUB_TOKEN` and `GITHUB_REPO_OWNER`)
- Remaining: `pnpm add @supabase/supabase-js`, create `lib/supabase.ts` (browser, anon key) and `lib/supabase-server.ts` (server-side only, service key)

### Step 4 — Website: Build `/intake`
Branching form. V2 physical proposition questions fully implemented. V3 types stubbed as "coming soon".

**Question set (physical branch):**
| Question | DB field |
|---|---|
| Client full name | `clients.name` |
| Client email | `clients.email` |
| Company name | `organizations.name` |
| Product description | `propositions.description` |
| Industry category | `propositions.industry_category` |
| Proposition type | `propositions.proposition_type` (import/export or domestic) |
| Origin country | `propositions.origin_country` (if import/export) |
| Target market | `propositions.target_country` |
| Phone number | `clients.phone` | Required |
| Sourcing notes | `propositions.sourcing_notes` | Optional — supplier/pricing info |
| Additional info | `propositions.additional_info` | Optional — free-text catch-all |
| Plan tier | `propositions.plan_tier` (starter $100 / pro $250 / retainer $150/mo) |

**On submit:** write to `clients`, `propositions`, `proposition_recipients` in Supabase. Send notification email to Brendon via the backend's Resend setup (or trigger from the backend — TBD).

### Step 5 — Website: Build `/admin` (auth + dashboard)
- Set up Supabase Auth — admin routes redirect to `/login` if unauthenticated
- `/admin` dashboard: active propositions count, recent runs, client count

### Step 6 — Website: Build `/admin/propositions`
- List all propositions with status
- **Run Now button** — calls GitHub Actions `workflow_dispatch` API:
  ```
  POST https://api.github.com/repos/{GITHUB_REPO_OWNER}/Camel-Milk-Business-Plan/actions/workflows/reports.yml/dispatches
  Authorization: Bearer {GITHUB_TOKEN}
  Body: { "ref": "main", "inputs": { "proposition_id": "<uuid>", "force": "true" } }
  ```
- **Live run status** — Supabase Realtime subscription on `reports` table, filters by `proposition_id`. Shows `running | complete | failed` in real time.

### Step 7 — Website: Build `/admin/reports` and `/admin/clients`
- `/admin/reports`: report history per proposition. View/download PDF via signed Supabase Storage URL (`reports` bucket, path `{proposition_id}/{reportId}.pdf`)
- `/admin/clients`: manage organizations and clients. Activate/deactivate. Edit plan tier.

### Step 8 — V2 End-to-End Test
1. Open website `/intake` as a "client"
2. Fill out form with a product idea (e.g. solar panels, China → US)
3. Check `/admin/propositions` — new submission appears
4. Hit **Run Now** → backend fires via GitHub Actions
5. Watch status update live via Supabase Realtime
6. Report generates, PDF delivered, view/download from `/admin/reports`

---

## V2 Backend Work (after website is live and tested)

These are the remaining backend tasks for full V2 capability. Do these after the website E2E test passes.

1. **Industry-aware gov data routing** — replace the flat `executeTool` switch with routing based on `industry_category`. Non-applicable tools return a structured "not applicable" so agents don't waste iterations.
2. **New gov tool scripts** (build as needed per test proposition):
   - `tools/fetch_doe_data.py` — DOE EIA + NREL (energy/solar)
   - `tools/fetch_epa_data.py` — EPA regulatory + enforcement (chemicals, manufacturing)
   - `tools/fetch_fda_device_data.py` — FDA 510(k) clearances + device recalls (medical)
   - `tools/fetch_itc_data.py` — ITC trade remedy cases (any import)
   - `tools/fetch_bls_data.py` — BLS employment + wage benchmarks
   - `tools/fetch_bis_data.py` — BIS export control classifications
3. **Workflow generalisation** — audit the 10 research workflows, remove food-specific hardcoding. Start with Option A (venture intelligence brief steers tool selection). Move to Option B (per-industry substitution blocks) only if results are poor.
4. **Consultant Intelligence Brief** — new `workflows/assemble_consultant_brief.md`, new `runConsultantBriefAgent()` in `run.js`, new `tools/generate_consultant_brief_pdf.py`. Uses same `agent_outputs` already in DB — no additional research API calls. Delivered as a single admin email with both PDFs (client report + consultant brief) attached.
5. **Prompt caching on the assembler** — add `cache_control: { type: "ephemeral" }` on the system prompt and research context blocks in the assembler's API calls. Saves ~$5/run (~40% total cost reduction).
6. **International research pipeline** — `tools/translate_text.py`, `tools/detect_language.py`, `tools/normalize_international_data.py`, `tools/fetch_gdelt_news.py`, `tools/fetch_opencorporates.py`, `tools/fetch_un_comtrade.py`. New API keys needed: DeepL, Google Cloud Translation, MyMemory, UN Comtrade, OpenCorporates.

**V2 test propositions:**
| Proposition | Industry category | Key non-food tools needed |
|---|---|---|
| Solar panels, China → US | energy | DOE EIA, EPA, ITC |
| Apparel / activewear, Bangladesh → US | apparel | CBP, FTC, CPSC |
| Medical diagnostic device, Germany → US | medical | FDA device, CMS |
| Consumer electronics, Taiwan → US | electronics | FCC, BIS, ITC |
| Camel milk powder, Somalia → UAE | food_beverage + Arabic | translate_text, detect_language, GDELT, UAE Ministry sources |

---

## Session Log

### Session 23 — Migration 010 run (2026-04-14)
- **Migration 010** — run against shared Supabase project (`vupnhlpwfqwmrysohhrq`)
- **`moddatetime` extension** — had to be enabled explicitly via CLI before migration could run (trigger on `proposition_context.updated_at` depends on it)
- **New columns:** `clients.phone` (VARCHAR 50, NOT NULL default `''`), `propositions.sourcing_notes` (TEXT nullable), `propositions.additional_info` (TEXT nullable)
- **New table:** `proposition_context` — admin enrichment per proposition, RLS enabled (service key only), indexed on `proposition_id`, auto-updating `updated_at`
- **Migration tooling:** Used `npx supabase link` + `npx supabase db query --linked` — Supabase CLI access token stored as `SUPABASE_LOGIN_TOKEN` in `.env`
- **Next:** Continue Step 3 — connect Supabase to `mckeever-consulting-website` and build `/intake`

### Session 22 — Backend steps 1 & 2 complete (2026-04-13)
- **`reports.yml`** — confirmed `proposition_id` input already present and correctly wired (targeted run + scheduled fallback)
- **Migration 009** — `industry_category` column added to `propositions`, camel milk proposition backfilled to `food_beverage`, run in Supabase SQL Editor
- **`intake.js`** — `--industry-category` flag added: validation against CHECK constraint values, passed through to `createProposition`
- **Next:** Switch to `mckeever-consulting-website` — Step 3 (Connect Supabase)

### Session 21 — Two-project state + V2 sequencing (2026-04-13)
- **Website project created** — `mckeever-consulting-website` on Vercel, bootstrapped with v0.app
- **Landing page deployed and live**
- **CLAUDE.md written** for the website project — full schema, pages, brand tokens, intake form questions, tech decisions already documented there
- **v0.app free plan at limit** — not a blocker. Development continues directly in the codebase from this point
- **Full task order mapped** across both projects to reach V2 end-to-end test (see "What Is Next" above)
- **Confirmed:** Supabase not yet connected to website project. No `/intake` or admin pages built yet.

### Sessions 18–19 — V1 close + V2 planning (2026-04-10 to 2026-04-11)
- V1 finalised: Census JSON retry fix, quality review/repair loop (Haiku flags → Sonnet repairs, max 2 cycles), stronger proofread checks, `--hold` flag dropped
- International research pipeline SOP written (`workflows/international_research.md`) — see `ROADMAP_V2.md` for full detail
- Market positioning locked: the consulting service (consultant brief + meeting) is the product, not the report generator

---

## End-to-End Test (V1)

```
node run.js --proposition-id 54f51272-d819-4d82-825a-15603ed48654 --force
```

**What to watch for:**
```
Venture intelligence brief: X chars, Y citations    ← Perplexity call 1
Landscape briefing: X chars, Y citations            ← Perplexity call 2
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
  Running quality review (Haiku)...         ← if errors found, Sonnet repairs + re-reviews (max 2 cycles)
  Running proofread pass (Sonnet)...        ← checks repetition, contradictions, vague financials, weak conclusions
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
| Monthly Report Run | `reports.yml` | 1st of each month, 6 AM UTC | Runs all due propositions |
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
| `runVentureIntelligence()` | Analyses the proposition — venture type, critical success factors, key risks, relevant regulatory bodies. Makes agents skip irrelevant gov tools (e.g. FDA for a solar panel proposition). |
| `runCurrentLandscapeBriefing()` | Current-events snapshot — regulatory changes (last 12 months), market trends, new competitors, trade/political factors. Perplexity used here specifically for real-time web access. |

Both are non-fatal — if Perplexity fails, agents fall back to their generic workflow SOPs.

### Research agents (10 total, sequential)

Each agent: reads `workflows/research_<name>.md` → injects venture intelligence + landscape briefing → calls **Claude Haiku** in a tool-use loop (max 50 iterations) → JSON output saved to DB.

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
| `search_perplexity` | `search_perplexity.py` | Fallback when Brave is thin |

FDA/USDA are food-biased. For non-food propositions, the venture intelligence brief instructs agents to skip them. V2 adds structural industry routing (see ROADMAP_V2.md).

### Quality gate
- Hard fail: any critical agent null (`market_overview`, `regulatory`, `financials`, `origin_ops`)
- Hard fail: more than 1 agent failed total
- Soft fail: exactly 1 non-critical agent null — retries once, then continues with gap noted in report

### Assembler (section-by-section)
- **Claude Sonnet** (`claude-sonnet-4-6`), no tools
- 15 individual calls (~2–6k tokens each) instead of one giant call — eliminates JSON parse failures
- Each call has a 2-cycle repair loop via `callWithRepair()`
- 20s inter-section delay for TPM rate limit management
- **Haiku quality review** — compact structural audit (empty blocks, placeholders, missing viability data). Non-fatal.
- **Sonnet proofread pass** — text-only view of all prose sent to Sonnet; returns patches fixing cross-section repetition and clarity. Applied in-place before PDF build. Non-fatal.
- Content JSON uploaded to Storage **before** PDF build — enables `--regen-pdf` recovery if PDF fails

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

**10 migrations run (001–010).**

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
| `proposition_context` | Admin-added enrichment per proposition. Categories: `sourcing`, `market`, `regulatory`, `financial`, `competitor`, `other`. RLS enabled — service key only. **Backend does not yet read this table** — see pending task in "What Is Next". |

**New fields added in migration 010:**
- `clients.phone` — VARCHAR(50), NOT NULL default `''`. Required on intake form.
- `propositions.sourcing_notes` — TEXT, nullable. Supplier/pricing info from intake form.
- `propositions.additional_info` — TEXT, nullable. Free-text catch-all from intake form.

**Extensions enabled:** `moddatetime` — required for the `proposition_context.updated_at` trigger. Had to be activated explicitly despite being available in Supabase by default.

**Organization status values:** `prospect | pending | active | cancelled | inactive`
- `getDuePropositions()` only returns propositions from `active` orgs
- Flip to `inactive` or `cancelled` to immediately stop a client's automated reports

**Plan tier values:** `starter | pro | retainer`
- Stored on both `organizations` (billing view) and `propositions` (run logic)
- Set together at activation via `tools/activate.js`

**proposition_type values:** `physical_import_export | physical_domestic | saas_software | service_business | digital_product`

Only `physical_import_export` and `physical_domestic` have workflows. V2 adds industry-aware routing.

**industry_category values:** `food_beverage | energy_clean_tech | medical_devices | chemicals_materials | electronics | apparel_textiles | cosmetics | general_manufacturing`

**Data retention:** See `tools/cleanup.js`. Rules:
- Completed reports: 6-month window (always keeps most recent per proposition)
- Failed reports: 7-day TTL
- `agent_outputs`: deleted immediately on run completion or failure; cleanup sweeps any stragglers
- `api_cache`: 7-day TTL

---

## API Keys (.env)

**Currently active (V1):**

| Key | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| Brave Search | `BRAVE_SEARCH_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| openFDA | `OPEN_FDA_API_KEY` |
| USDA FDC | `USDA_FDC_API_KEY` |
| USDA NASS | `USDA_NASS_API_KEY` |
| Census | `CENSUS_API_KEY` |
| Exchange Rate | `EXCHANGE_RATE_API_KEY` |
| Resend | `RESEND_API_KEY` |
| YouTube | `YOUTUBE_API_KEY` |

USASpending.gov and SEC EDGAR require no key. All keys are also stored as GitHub repo secrets for GitHub Actions.

**To add for V2 — international research pipeline:**

| Key | Variable | Notes |
|---|---|---|
| DeepL | `DEEPL_API_KEY` | 500k chars/month free. Best for European languages. Sign up: deepl.com/pro-api |
| Google Cloud Translation | `GOOGLE_TRANSLATE_API_KEY` | 500k chars/month free. Best for Arabic, CJK, broad coverage. Enable in Google Cloud Console. |
| MyMemory | `MYMEMORY_API_KEY` | 10k chars/day free. Fallback if both primaries are exhausted. Register: mymemory.translated.net |
| UN Comtrade | `UN_COMTRADE_API_KEY` | Free, 500 req/hour. Bilateral trade flows between any two countries. Register: comtradeplus.un.org |
| OpenCorporates | `OPENCORPORATES_API_KEY` | Free, rate-limited. 160M+ company records, 140+ jurisdictions. Register: opencorporates.com/api_accounts |

GDELT, World Bank, IMF, and Eurostat require no key — fully open APIs.

**Website project `.env.local` (separate file in `mckeever-consulting-website`):**

| Key | Variable | Notes |
|---|---|---|
| Supabase URL | `NEXT_PUBLIC_SUPABASE_URL` | Same project as backend |
| Supabase anon key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Safe to expose to browser |
| Supabase service key | `SUPABASE_SERVICE_KEY` | Server-side only — never expose to browser |
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
| 14 | Model escalation | Haiku → Sonnet on iteration exhaustion or JSON parse failure. Ceiling = Sonnet (not Opus). `financials`, `packaging`, `marketing` skip Haiku entirely (`sonnetOnly: true`) — they reliably exceed Haiku's 200k token limit. |
| 15 | Perplexity roles | (1) Fallback when Brave thin, (2) Venture intelligence brief, (3) Landscape briefing. Real-time web access is the reason. |
| 16 | Industry adaptability | Venture intelligence brief steers agents away from irrelevant gov tools. Structural routing deferred to V2. |
| 17 | Client model | Organizations own propositions. Contacts (clients) belong to orgs. Per-proposition recipient lists via `proposition_recipients`. |
| 18 | Org status gating | Only `active` orgs run reports. Flip to `inactive`/`cancelled` to pause without deleting data. |
| 19 | Plan tier gating | Starter/Pro retire to `on_demand` after their run limit. Retainer advances indefinitely. |
| 20 | Scheduling | GitHub Actions — cleanup weekly (Sunday 2 AM UTC), reports monthly (1st, 6 AM UTC). |
| 21 | Admin independence | Brendon is admin of McKeever Consulting via `organization_admins` table — independent of his client record. Multiple admins supported. |
| 22 | Assembler architecture | Section-by-section (15 Sonnet calls, 2-cycle repair each) + Haiku structural review + Sonnet proofread pass. Eliminates JSON parse failures. Content JSON uploaded before PDF build. |
| 23 | MCP | Ruled out (2026-04-13). Declining adoption, more problems than it solves. Tool layer stays as Python subprocesses. |
| 24 | Website run trigger | GitHub Actions `workflow_dispatch` — no new servers needed. Admin panel calls GitHub API with `proposition_id` input. Website polls `reports` table via Supabase Realtime for live status. |
| 25 | Website tech stack | Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui + Supabase JS client. Deployed on Vercel. |
| 26 | Website auth | Supabase Auth for admin panel. Intake form is public. |
| 27 | Website/backend separation | Separate repos. Shared Supabase project. No API layer between them — website reads/writes DB directly. |

---

## Roadmap Summary

See `ROADMAP_V2.md` for full detail.

| Phase | Status | Key work |
|---|---|---|
| V1 | ✅ Complete | Physical import/export pipeline. E2E tested. |
| Website | 🔄 In progress | Landing page live. Intake form + admin panel not yet built. See task list above. |
| V2 | Planned | Industry-aware routing · new gov tool scripts · workflow generalisation · consultant brief · prompt caching · international research pipeline |
| V3 | Future | SaaS, services, digital, franchise — new workflow sets, dynamic agent selection, social media research layer |
