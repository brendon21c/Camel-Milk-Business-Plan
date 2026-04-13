# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-13 (Session 20 — Sequencing revised: website before V2. MCP ruled out. Run trigger decided: GitHub Actions workflow_dispatch. Intake form must drive DB schema before V2 migrations are written.)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: Perplexity briefings → research agents → assembler → branded PDF → Resend email → client inbox.

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

## Status

**V1 is complete. V2 planning is underway.**

E2E test passed 2026-04-10. Report delivered to Iman Warsame and Brendon McKeever from `reports@mckeeverconsulting.org`. Proposition on `retainer` plan — will auto-run May 1 via GitHub Actions.

**Note:** Proposition is currently set to `plan_tier = 'retainer'` in Supabase to allow the May auto-run test. After the May run confirms scheduling works, flip back to `starter`.

### Session 19 — V2 planning (2026-04-11)
- **International & multilingual research pipeline** — full 7-step SOP added as `workflows/international_research.md`. Covers keyword translation, country-targeted source discovery, language detection, translation service routing (DeepL for European, Google for Arabic/CJK), data normalization, agent handoff with source provenance tags, and gap flagging in output.
- **Error handling strategy** — defined retry budgets, fallback chains, and failure-scoping rules for every step in the international pipeline. Key principle: fail at the source level, not the run level. Max 2 translation API calls per source document across all services. Translated content cached to `.tmp/` immediately so cost is never paid twice.
- **V2 roadmap section 8** — international research added to `ROADMAP_V2.md` with 6 new tools to build, full API stack with costs, and a concrete test proposition (camel milk → UAE in Arabic).
- **Market positioning discussion** — clarified that the tool is not the product; the consulting service built on top of it is. The consultant brief + meeting model is the primary differentiator. Not a saturated market if positioned as AI-powered consulting rather than AI business plan generation.

### Session 18 — V1 close (2026-04-10)
- **Census fix** — `fetch_census_data.py` retries on malformed JSON, always emits structured JSON to stdout on failure.
- **Quality review → repair loop** — Haiku flags errors, Sonnet re-assembles flagged sections, Haiku re-reviews. Capped at 2 cycles. Non-fatal.
- **Stronger proofread** — added CONTRADICTION, VAGUE FINANCIALS, and WEAK CONCLUSIONS checks.
- **`--hold` flag dropped** — pipeline auto-sends best version it can produce.

---

## End-to-End Test

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
`reports.yml` has a `--force` toggle for manual re-runs outside the normal schedule.

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
.github/workflows/  ← GitHub Actions (scheduling)
outputs/            ← generated PDFs (auto-deleted after upload + email)
.tmp/               ← disposable intermediates (auto-deleted after each step)
assets/             ← fonts (auto-downloaded), brand assets
ROADMAP_V2.md       ← V2/V3 product vision and implementation plan
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

**8 migrations run (001–008).**

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

**Organization status values:** `prospect | pending | active | cancelled | inactive`
- `getDuePropositions()` only returns propositions from `active` orgs
- Flip to `inactive` or `cancelled` to immediately stop a client's automated reports

**Plan tier values:** `starter | pro | retainer`
- Stored on both `organizations` (billing view) and `propositions` (run logic)
- Set together at activation via `tools/activate.js`

**proposition_type values:** `physical_import_export | physical_domestic | saas_software | service_business | digital_product`

Only `physical_import_export` and `physical_domestic` have workflows. V2 adds industry-aware routing. See ROADMAP_V2.md.

**Note:** Migration numbering — ROADMAP_V2.md references a migration 006 for `industry_category`. That number is now taken (organizations). The industry_category migration will be 009 when built.

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

---

## Locked Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Claude Haiku (tool-use loop) + Brave Search + gov APIs |
| 2 | Report structure | 14 sections + Sources + data confidence score |
| 3 | Delivery | Resend email, PDF attached. All proposition recipients + Brendon admin copy. |
| 4 | Run trigger | Scheduled (`next_run_at`) or `--force` |
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

---

## Roadmap

See `ROADMAP_V2.md` for full detail.

| Phase | Scope | Key work |
|---|---|---|
| V1 | Physical import/export | Complete and stable |
| Website | Main page, intake form, basic admin panel | **Next.** Separate project. Connects via Supabase + GitHub Actions workflow_dispatch. MCP ruled out. |
| V2 | Any physical product, any industry | Industry-aware gov data routing · migration 009 (`industry_category`) · new tool scripts (DOE, EPA, FDA device, ITC, translate, detect_language, normalize_international, GDELT, UN Comtrade, OpenCorporates) · workflow generalisation · consultant brief · prompt caching on assembler · international & multilingual research pipeline |
| V3 | SaaS, services, digital, franchise | New workflow sets per venture type · dynamic agent selection · new data sources (Crunchbase, G2, BLS) · social media research layer (YouTube, Reddit, Instagram, TikTok) |

**Sequencing rationale:** Website before V2 — intake form questions must drive the DB schema. Writing V2 migrations before the form exists causes rework.

**Before starting the website build (one change needed here):**
- Add a `proposition_id` input to `.github/workflows/reports.yml` — required for the admin panel's Run Now trigger

**V2 build order (after website is live):**
1. Migration 009 + industry routing (unblocks non-food propositions)
2. Consultant brief (high value, no new research infrastructure needed)
3. Prompt caching on assembler (cost reduction, straightforward)
4. New gov tool scripts as needed per test proposition
5. International research pipeline (translate + detect + normalize tools + new API keys)
