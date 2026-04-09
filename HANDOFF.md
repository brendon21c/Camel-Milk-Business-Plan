# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-09 (Session 10 — run.js fully complete, ready for end-to-end test)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: research agents → assembler → branded PDF → Resend email → client inbox.

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
| 9 | Government data tools (FDA, USDA, Census, USASpending, SEC EDGAR) | ✓ Done (Session 10) |
| 10 | `tools/search_perplexity.py` (fallback search) | ✓ Done (Session 10) |
| 11 | `tools/compute_data_confidence.py` | ✓ Done (Session 10) |
| 12 | `run.js` Part 1 — structure, scheduling, stubs | ✓ Done |
| 13 | `run.js` Part 2 — full agent orchestration | ✓ Done (Session 10) |
| 14 | **End-to-end test run** | **← NEXT** |

---

## Next Up — End-to-End Test

```
node run.js --proposition-id 54f51272-d819-4d82-825a-15603ed48654 --force
```

**What to watch for in the logs:**
- Each agent prints `→ tool: web_search(...)` as it makes tool calls
- Quality gate prints `✓ Quality gate passed (10/10 agents complete)`
- Assembler prints confidence score, then `Calling Claude Sonnet...`
- `✓ PDF generated`, `✓ PDF uploaded to Storage`, `✓ Report emailed`
- Final `✓ Run complete`

**Likely first-run issues:**
| Issue | Fix |
|---|---|
| `execPython` arg quoting fails on Windows | Check spaces in paths — `VENV_PYTHON` is already quoted in the cmd string |
| Assembler JSON parse fails | Add `console.log(rawContent.slice(0, 1000))` before `parseJSON()` in `runAssemblerAgent()` to see what Claude produced |
| Resend 403 error | Confirm `onboarding@resend.dev` is a verified sender in Resend dashboard |
| Storage upload fails | Confirm `reports` bucket exists and is private in Supabase dashboard |
| USDA NASS returns no data | NASS QuickStats is sometimes down — `executeTool` catches and returns `{ error: ... }`, agent handles gracefully |

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
```

---

## run.js — How It Works (Part 2 complete)

### Research agents (10 total, sequential)
All 10 delegate to `runResearchAgent(agentName, context)`:
1. Reads `workflows/research_<name>.md`
2. Calls **Claude Haiku** (`claude-haiku-4-5-20251001`) in a tool-use loop (max 50 iterations)
3. Claude calls Python tools as needed, loop feeds results back
4. Final response is parsed as JSON → saved via `saveAgentOutput()` → sources via `saveReportSource()`

### 7 tools available to research agents
| Tool | Python script | When used |
|---|---|---|
| `web_search` | `search_brave.py` | All agents (primary source) |
| `fetch_fda_data` | `fetch_fda_data.py` | regulatory, production |
| `fetch_usda_data` | `fetch_usda_data.py` | regulatory, market_overview, financials |
| `fetch_census_data` | `fetch_census_data.py` | market_overview, financials |
| `fetch_usaspending_data` | `fetch_usaspending_data.py` | market_overview, financials |
| `fetch_sec_edgar` | `fetch_sec_edgar.py` | competitors, financials |
| `search_perplexity` | `search_perplexity.py` | Any (fallback when Brave thin) |

### Quality gate
- Hard fail: any critical agent null (`market_overview`, `regulatory`, `financials`, `origin_ops`)
- Hard fail: more than 1 agent failed total
- Soft fail: exactly 1 non-critical agent null — continues, gap noted in report

### Data confidence score
Computed via `compute_data_confidence.py --report-id <id>` before the assembler call.
Aggregates per-field `high/medium/low` confidence ratings across all 10 agent outputs.
Score 0–100: 85+ = High, 65–84 = Moderate, 40–64 = Low, <40 = Very Low.
Non-fatal — if the tool fails, score is set to null and report continues.

### Assembler
- Calls **Claude Sonnet** (`claude-sonnet-4-6`), no tools, max 32k tokens
- Input: assemble_report.md workflow + all 10 research outputs + confidence score + previous outputs (run 2+)
- Output: complete content JSON → written to `.tmp/<reportId>_content.json`
- Runs `generate_report_pdf.py` → PDF in `outputs/`
- Uploads PDF to Supabase Storage `reports` bucket → saves signed URL (7 days)
- Emails PDF (base64 attachment) to client + admin copy to Brendon
- Calls `updateReportStatus('complete')` — assembler owns this transition

---

## Workflows — ALL COMPLETE

| File | Section | Notes |
|---|---|---|
| `research_market_overview.md` | 4 | Updated Session 10: Step 1b adds Census, USASpending, SEC EDGAR, Perplexity |
| `research_competitors.md` | 5 | — |
| `research_regulatory.md` | 6 | Updated Session 10: Step 1b adds FDA, USDA FDC, Perplexity |
| `research_production.md` | 7 | — |
| `research_packaging.md` | 8 | — |
| `research_distribution.md` | 9 | — |
| `research_marketing.md` | 10 | — |
| `research_financials.md` | 11 | Updated Session 10: Step 1b adds SEC EDGAR, USASpending, Census, Perplexity |
| `research_origin_ops.md` | supply chain | — |
| `research_legal.md` | risk | — |
| `assemble_report.md` | assembler | Updated Session 10: Step 3b adds data confidence score computation |

All 10 research workflows include: 6 primary queries, 6 fallback pairs, agent-generated query instruction, domestic path (when origin == target country).

---

## Tools — ALL COMPLETE

| Tool | Purpose |
|---|---|
| `tools/search_brave.py` | Brave Search API — 500ms delay, exponential backoff, Supabase cache |
| `tools/search_perplexity.py` | Perplexity Sonar — fallback synthesized search with citations |
| `tools/fetch_fda_data.py` | openFDA food enforcement + adverse events |
| `tools/fetch_usda_data.py` | USDA FoodData Central (nutrition) + NASS QuickStats (ag production) |
| `tools/fetch_census_data.py` | Census ACS5 (demographics) + CBP (industry establishment counts) |
| `tools/fetch_usaspending_data.py` | USASpending.gov contracts + grants (no key required) |
| `tools/fetch_sec_edgar.py` | SEC EDGAR filing search + company facts (no key required) |
| `tools/compute_data_confidence.py` | Aggregates per-field confidence ratings → 0-100 score |
| `tools/generate_report_pdf.py` | ReportLab PDF builder — reads content JSON, produces branded PDF |
| `tools/preview_brand.py` | Standalone brand preview — run manually, not by orchestrator |
| `tools/intake.js` | CLI: creates prospect client + proposition, emails Brendon |
| `tools/generate_proposal_pdf.py` | ReportLab proposal PDF builder |
| `tools/generate_proposal.js` | Generates + emails proposal PDF, flips status → proposal_sent |
| `tools/activate.js` | Flips client + proposition → active, sets schedule |
| `tools/prune_old_reports.js` | Not built — post-launch |

---

## API Keys (.env) — ALL SET

| Key | Variable | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Claude Haiku + Sonnet |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` | — |
| Brave Search | `BRAVE_SEARCH_KEY` | Primary web search |
| Perplexity | `PERPLEXITY_API_KEY` | Sonar tier (fallback search) |
| openFDA | `OPEN_FDA_API_KEY` | Food enforcement + events |
| USDA FDC | `USDA_FDC_API_KEY` | FoodData Central |
| USDA NASS | `USDA_NASS_API_KEY` | QuickStats agricultural data |
| Census | `CENSUS_API_KEY` | ACS5 + CBP |
| Exchange Rate | `EXCHANGE_RATE_API_KEY` | Currency conversion |
| Resend | `RESEND_API_KEY` | Email delivery |
| YouTube | `YOUTUBE_API_KEY` | Marketing research |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, numbers | Available but unused (SMS disabled) |

USASpending.gov and SEC EDGAR require no key.

---

## DB Schema Summary

**5 migrations run (001–005).** All applied in Supabase SQL Editor.

**Tables:** `clients`, `propositions`, `reports`, `agent_outputs`, `report_sources`, `search_cache`

Key fields added across migrations:
- `clients`: `status` (prospect/active/inactive), `phone`
- `propositions`: `status`, `factor_weights`, `proposition_type`, `plan_tier`, `run_number`
- `reports`: `error_message`, `run_number`, `previous_report_id`

**proposition_type values:** `physical_import_export | physical_domestic | saas_software | service_business | digital_product`
Only `physical_import_export` and `physical_domestic` have workflows. Others need new workflow sets before use.

---

## Locked Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Claude Haiku (tool-use loop) + Brave Search + gov APIs |
| 2 | Report structure | 14 sections + Sources. Data confidence score added Session 10. |
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
  → first report run triggered

node run.js --proposition-id <id> --force   ← on-demand
node run.js                                  ← scheduled (cron)
```

---

## Future (post-launch)

- `tools/prune_old_reports.js` — delete reports older than 6 months from Storage
- Website + admin panel — intake form, report viewer, "Run Now" button per proposition
- Additional workflow sets for `saas_software`, `service_business`, `digital_product`
