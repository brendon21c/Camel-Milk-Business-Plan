# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-10 (Session 12 — PDF formatting fixes + PDF regen feature)

---

## What This Project Is

An automated business viability intelligence system. Generic by design — first proposition is camel milk powder export from Somalia to the US. Future propositions are new DB rows, no new code needed.

Pipeline: Perplexity briefings → research agents → assembler → branded PDF → Resend email → client inbox.

---

## Seed IDs

- **Client (Brendon McKeever):** `ea134c2d-547e-4fcb-b475-65383680c8fb`
- **Proposition (Camel Milk Export):** `54f51272-d819-4d82-825a-15603ed48654`
- **Supabase project:** `https://vupnhlpwfqwmrysohhrq.supabase.co`

---

## Status

Everything is built. Remaining before V1 launch:

| # | Item | Priority |
|---|---|---|
| 1 | End-to-end test (command below) | **← Do this first** |
| 2 | Add `'packaging'` to `sonnetOnly` list in `runResearchAgents()` — Haiku hits `max_tokens` on that agent | High |
| 3 | Fix signed URL expiry — Supabase 7-day signed URLs stored in DB go dead; clients get a 403 after a week | High |
| 4 | Fix Census CBP `JSONDecodeError` — malformed JSON occasionally returned; add response validation before `json.loads()` | Low |
| 5 | Add `--hold` flag — stops after PDF generation, saves to `outputs/`, prompts for confirmation before emailing client | Low |

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
  ... (10 agents, any escalations logged with ↑)
✓ Quality gate passed (10/10 agents complete)
✓ Data confidence: XX/100
Calling Claude Sonnet for report synthesis...
✓ PDF generated  ✓ PDF uploaded to Storage  ✓ Report emailed
✓ Run complete
```

**If things break:**
| Issue | Fix |
|---|---|
| Assembler JSON parse fails | Add `console.log(rawContent.slice(0, 1000))` before `parseJSON()` in `runAssemblerAgent()` |
| Resend 403 error | Confirm `onboarding@resend.dev` is a verified sender in Resend dashboard |
| Storage upload fails | Confirm `reports` bucket exists and is private in Supabase dashboard |
| USDA NASS returns no data | Sometimes down — `executeTool` catches and returns `{ error: ... }`, agent handles gracefully |

---

## Commands

```bash
# Full pipeline runs
node run.js                                        # scheduled (cron)
node run.js --proposition-id <id> --force          # on-demand, bypasses schedule

# PDF only (no agents, no email) — requires a completed run with stored content JSON
node run.js --regen-pdf --report-id <id>           # rebuilds PDF → saves to outputs/ for review

# Intake flow (in order)
node tools/intake.js --name "..." --email "..." ...         # creates prospect client + proposition
node tools/generate_proposal.js --proposition-id <id>       # generates + emails proposal PDF
node tools/activate.js --proposition-id <id>                # activates client, sets schedule
```

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
outputs/            ← generated PDFs (auto-deleted after upload + email)
.tmp/               ← disposable intermediates (auto-deleted after each step)
assets/             ← fonts (auto-downloaded), brand assets
ROADMAP_V2.md       ← V2/V3 product vision and implementation plan
```

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
- Soft fail: exactly 1 non-critical agent null — continues, gap noted in report

### Assembler
- **Claude Sonnet** (`claude-sonnet-4-6`), no tools, max 32k tokens
- Input: assemble_report.md + all 10 research outputs + confidence score + previous outputs (run 2+)
- Output: content JSON → PDF → Supabase Storage (PDF + content JSON) → Resend email → `status = complete`

---

## DB Schema

**5 migrations run (001–005).** Tables: `clients`, `propositions`, `reports`, `agent_outputs`, `report_sources`, `api_cache`

**proposition_type values:** `physical_import_export | physical_domestic | saas_software | service_business | digital_product`

Only `physical_import_export` and `physical_domestic` have workflows. V2 adds `industry_category` field (migration 006). See ROADMAP_V2.md.

**Data retention:** See `tools/cleanup.js` for pruning rules (agent_outputs, old reports, Storage files, api_cache).

---

## API Keys (.env)

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

USASpending.gov and SEC EDGAR require no key. Twilio is wired but SMS is disabled.

---

## Locked Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Claude Haiku (tool-use loop) + Brave Search + gov APIs |
| 2 | Report structure | 14 sections + Sources + data confidence score |
| 3 | Delivery | Resend email, PDF attached. Client + Brendon admin copy. |
| 4 | Run trigger | Scheduled (next_run_at) or `--force` |
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
| 15 | Perplexity roles | (1) Fallback when Brave thin, (2) Venture intelligence brief, (3) Landscape briefing. Real-time web access is the reason Perplexity fills these roles, not Claude. |
| 16 | Industry adaptability | Venture intelligence brief steers agents away from irrelevant gov tools. Structural routing deferred to V2. |

---

## Roadmap

See `ROADMAP_V2.md` for full detail.

| Phase | Scope | Key work |
|---|---|---|
| V1 | Physical import/export (current) | End-to-end test → launch |
| V2 | Any physical product, any industry | Industry-aware gov data routing, migration 006 (`industry_category`), new tool scripts (DOE, EPA, FDA device, ITC), workflow generalisation |
| V3 | SaaS, services, digital, franchise | New workflow sets per venture type, dynamic agent selection, new data sources |
