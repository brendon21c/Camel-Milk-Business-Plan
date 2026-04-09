# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-09 (Session 11 — escalation + Perplexity briefings + V2 roadmap, ready for end-to-end test)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: Perplexity briefings → research agents → assembler → branded PDF → Resend email → client inbox.

---

## Seed IDs (use these for testing)

- **Client (Brendon McKeever):** `ea134c2d-547e-4fcb-b475-65383680c8fb`
- **Proposition (Camel Milk Export):** `54f51272-d819-4d82-825a-15603ed48654`
- **Supabase project:** `https://vupnhlpwfqwmrysohhrq.supabase.co`

---

## Build Status — ALL COMPLETE

| # | Item | Status |
|---|---|---|
| 1 | DB migrations (001–005) + Supabase Storage bucket | ✓ Done |
| 2 | Python venv + requirements.txt | ✓ Done |
| 3 | `supabaseClient.js` + `db.js` (all functions) | ✓ Done |
| 4 | All 11 workflows | ✓ Done |
| 5 | `tools/search_brave.py` | ✓ Done |
| 6 | `tools/generate_report_pdf.py` | ✓ Done |
| 7 | `tools/preview_brand.py` | ✓ Done |
| 8 | `tools/intake.js` + `generate_proposal_pdf.py` + `generate_proposal.js` + `activate.js` | ✓ Done |
| 9 | Government data tools (FDA, USDA, Census, USASpending, SEC EDGAR) | ✓ Done |
| 10 | `tools/search_perplexity.py` (fallback search) | ✓ Done |
| 11 | `tools/compute_data_confidence.py` | ✓ Done |
| 12 | `run.js` Part 1 — structure, scheduling, stubs | ✓ Done |
| 13 | `run.js` Part 2 — full agent orchestration | ✓ Done |
| 14 | Model escalation (Haiku → Sonnet on failure) | ✓ Done (Session 11) |
| 15 | Perplexity pre-run briefings (venture intelligence + landscape) | ✓ Done (Session 11) |
| 16 | `ROADMAP_V2.md` — V2/V3 product vision documented | ✓ Done (Session 11) |
| 17 | **End-to-end test run** | **← NEXT** |

---

## Next Up — End-to-End Test

```
node run.js --proposition-id 54f51272-d819-4d82-825a-15603ed48654 --force
```

**What to watch for in the logs:**
```
Venture intelligence brief: X chars, Y citations    ← Perplexity call 1
Landscape briefing: X chars, Y citations            ← Perplexity call 2
Running research agents (sequential)...
  → market_overview ... ✓
  ... (10 agents, any escalations logged with ↑)
✓ Quality gate passed (10/10 agents complete)
✓ Data confidence: XX/100
Calling Claude Sonnet for report synthesis...
✓ PDF generated  ✓ PDF uploaded to Storage  ✓ Report emailed
✓ Run complete
```

**Likely first-run issues:**
| Issue | Fix |
|---|---|
| `execPython` arg quoting fails on Windows | Check spaces in paths — `VENV_PYTHON` is already quoted |
| Assembler JSON parse fails | Add `console.log(rawContent.slice(0, 1000))` before `parseJSON()` in `runAssemblerAgent()` |
| Resend 403 error | Confirm `onboarding@resend.dev` is a verified sender in Resend dashboard |
| Storage upload fails | Confirm `reports` bucket exists and is private in Supabase dashboard |
| USDA NASS returns no data | Sometimes down — `executeTool` catches and returns `{ error: ... }`, agent handles gracefully |

---

## Architecture

```
run.js              ← orchestrator (Node.js)
  ↓ reads
workflows/          ← plain-language SOPs (11 files)
  ↓ tools called by
tools/              ← Python scripts (execution layer)
db.js               ← all Supabase queries
.env                ← all credentials
outputs/            ← generated PDFs
.tmp/               ← disposable intermediates (content JSON, auto-deleted)
assets/             ← fonts (auto-downloaded), brand assets
ROADMAP_V2.md       ← V2/V3 product vision and implementation plan
```

---

## run.js — How It Works

### Pre-run briefings (2 Perplexity calls, sequential, non-fatal)
Run before any research agents. Both outputs are injected into every agent's prompt.

| Call | Purpose |
|---|---|
| `runVentureIntelligence()` | Analyses the proposition — venture type, critical success factors, key risks, relevant regulatory bodies (DOE/EPA for solar, FDA for food), research priorities. Makes agents skip irrelevant gov tools. |
| `runCurrentLandscapeBriefing()` | Current-events snapshot — regulatory changes (last 12 months), market trends, new competitors, trade/political factors. Requires real-time web access; reason Perplexity (not Claude) is used here. |

Both are non-fatal. If Perplexity fails, agents proceed with their generic workflow SOPs.

### Research agents (10 total, sequential)
All 10 delegate to `runResearchAgent(agentName, context)`:
1. Reads `workflows/research_<name>.md`
2. Injects venture intelligence + landscape briefing blocks into the prompt
3. Calls **Claude Haiku** in a tool-use loop (max 50 iterations)
4. Final response is parsed as JSON → saved via `saveAgentOutput()` → sources via `saveReportSource()`

### Model escalation (Haiku → Sonnet)
Per CLAUDE.md: start Fast, escalate to Balanced only if results are poor. Ceiling is Sonnet.

Two triggers that escalate a research agent from Haiku to Sonnet:
1. **Iteration exhaustion** — Haiku hits maxIter=50 without converging (gets stuck in tool loop)
2. **JSON parse failure** — Haiku's output can't be parsed (didn't follow output format)

Sonnet retry uses maxIter=20 (converges faster). If Sonnet also fails, agent is marked `failed`.
Escalated runs log: `↑ market_overview completed via Sonnet escalation`

### 7 tools available to research agents
| Tool | Python script | When used |
|---|---|---|
| `web_search` | `search_brave.py` | All agents (primary source) |
| `fetch_fda_data` | `fetch_fda_data.py` | Food/drug propositions — regulatory, production |
| `fetch_usda_data` | `fetch_usda_data.py` | Food/agriculture — regulatory, market_overview, financials |
| `fetch_census_data` | `fetch_census_data.py` | All — market_overview, financials (demographics + industry sizing) |
| `fetch_usaspending_data` | `fetch_usaspending_data.py` | All — market_overview, financials (federal contracts/grants) |
| `fetch_sec_edgar` | `fetch_sec_edgar.py` | All — competitors, financials (public company filings) |
| `search_perplexity` | `search_perplexity.py` | Any (fallback when Brave thin; also used in pre-run briefings) |

**Note on industry bias:** FDA and USDA tools are food/agriculture specific. For non-food propositions, the venture intelligence brief tells agents these don't apply — agents skip them naturally. V2 adds structural industry routing (see ROADMAP_V2.md).

### Quality gate
- Hard fail: any critical agent null (`market_overview`, `regulatory`, `financials`, `origin_ops`)
- Hard fail: more than 1 agent failed total
- Soft fail: exactly 1 non-critical agent null — continues, gap noted in report

### Data confidence score
Computed via `compute_data_confidence.py --report-id <id>` before assembler.
Score 0–100: 85+ = High, 65–84 = Moderate, 40–64 = Low, <40 = Very Low. Non-fatal.

### Assembler
- Calls **Claude Sonnet** (`claude-sonnet-4-6`), no tools, max 32k tokens
- Input: assemble_report.md + all 10 research outputs + confidence score + previous outputs (run 2+)
- Output: complete content JSON → PDF → Supabase Storage → Resend email → `updateReportStatus('complete')`

---

## Workflows — ALL COMPLETE

| File | Notes |
|---|---|
| `research_market_overview.md` | Step 1b: Census, USASpending, SEC EDGAR, Perplexity |
| `research_competitors.md` | — |
| `research_regulatory.md` | Step 1b: FDA, USDA FDC, Perplexity |
| `research_production.md` | — |
| `research_packaging.md` | — |
| `research_distribution.md` | — |
| `research_marketing.md` | — |
| `research_financials.md` | Step 1b: SEC EDGAR, USASpending, Census, Perplexity |
| `research_origin_ops.md` | — |
| `research_legal.md` | — |
| `assemble_report.md` | Step 3b: data confidence score computation |

---

## Tools — ALL COMPLETE

| Tool | Purpose |
|---|---|
| `tools/search_brave.py` | Brave Search API — 500ms delay, exponential backoff, Supabase cache |
| `tools/search_perplexity.py` | Perplexity Sonar — fallback search + pre-run briefings |
| `tools/fetch_fda_data.py` | openFDA food enforcement + adverse events |
| `tools/fetch_usda_data.py` | USDA FoodData Central (nutrition) + NASS QuickStats (ag production) |
| `tools/fetch_census_data.py` | Census ACS5 (demographics) + CBP (industry establishment counts) |
| `tools/fetch_usaspending_data.py` | USASpending.gov contracts + grants |
| `tools/fetch_sec_edgar.py` | SEC EDGAR filing search + company facts |
| `tools/compute_data_confidence.py` | Aggregates per-field confidence ratings → 0-100 score |
| `tools/generate_report_pdf.py` | ReportLab PDF builder |
| `tools/preview_brand.py` | Standalone brand preview (manual, not called by orchestrator) |
| `tools/intake.js` | CLI: creates prospect client + proposition, emails Brendon |
| `tools/generate_proposal_pdf.py` | ReportLab proposal PDF builder |
| `tools/generate_proposal.js` | Generates + emails proposal PDF, flips status → proposal_sent |
| `tools/activate.js` | Flips client + proposition → active, sets schedule |

---

## API Keys (.env) — ALL SET

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
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, numbers (unused — SMS disabled) |

USASpending.gov and SEC EDGAR require no key.

---

## DB Schema Summary

**5 migrations run (001–005).** Tables: `clients`, `propositions`, `reports`, `agent_outputs`, `report_sources`, `search_cache`

**proposition_type values:** `physical_import_export | physical_domestic | saas_software | service_business | digital_product`

Only `physical_import_export` and `physical_domestic` have workflows. V2 adds `industry_category` field (migration 006) for gov tool routing. See ROADMAP_V2.md.

---

## Locked Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Claude Haiku (tool-use loop) + Brave Search + gov APIs |
| 2 | Report structure | 14 sections + Sources + data confidence score |
| 3 | Delivery | Resend email, PDF attached. Client + Brendon admin copy. |
| 4 | Run trigger | Scheduled (next_run_at) or `node run.js --proposition-id <id> --force` |
| 5 | Delta tracking | Full fresh report every run + "What Changed" section from run 2+ |
| 6 | Agent architecture | Haiku (research, tool-use) → Sonnet (assembly, synthesis) |
| 7 | Viability score | 6 factors × weights, each 1–5. 4–5=Strong / 2.5–3.9=Moderate / 1–2.4=Weak |
| 8 | Data confidence | 0–100 score (field confidence 45%, completion 25%, sources 20%, gaps 10%) |
| 9 | Quality gate | Hard fail: critical agent null or >1 agent failed. Soft fail: 1 non-critical null. |
| 10 | Brave throttling | 500ms delay + exponential backoff, max 3 retries |
| 11 | Failure alerting | Email to Brendon only. Client never notified. Error logged to DB. |
| 12 | Brand | McKeever Consulting. Navy `#1C3557` + Gold `#C8A94A` + Silver `#8A9BB0`. Montserrat. |
| 13 | Pricing | Starter $100 / Pro $250 / Retainer $150/month |
| 14 | Model escalation | Haiku → Sonnet on iteration exhaustion or JSON parse failure. Ceiling = Sonnet (not Opus). |
| 15 | Perplexity roles | (1) Fallback when Brave thin, (2) Pre-run venture intelligence brief, (3) Pre-run landscape briefing. Real-time web access is why Perplexity, not Claude, fills these roles. |
| 16 | Industry adaptability | Venture intelligence brief makes agents skip irrelevant gov tools (e.g. FDA for solar panels). Structural industry routing deferred to V2. |

---

## Intake Flow

```
node tools/intake.js --name "..." --email "..." ...
  → client + proposition created (status: prospect), Brendon emailed

node tools/generate_proposal.js --proposition-id <id>
  → proposal PDF generated + emailed to client + Brendon
  → proposition status → proposal_sent

node tools/activate.js --proposition-id <id>
  → client + proposition → active, schedule set

node run.js --proposition-id <id> --force   ← on-demand
node run.js                                  ← scheduled (cron)
```

---

## Roadmap

See `ROADMAP_V2.md` for full detail.

| Phase | Scope | Key work |
|---|---|---|
| V1 | Physical import/export (current) | End-to-end test → launch |
| V2 | Any physical product, any industry | Industry-aware gov data routing, migration 006 (`industry_category`), new tool scripts (DOE, EPA, FDA device, ITC), workflow generalisation |
| V3 | SaaS, services, digital, franchise | New workflow sets per venture type, dynamic agent selection, new data sources |
