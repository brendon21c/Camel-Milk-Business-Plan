# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-08 (Session 5)

---

## What This Project Is

An automated business viability intelligence system that answers:
> *Is a given business idea viable — and how does that picture change over time?*

Generic by design. First proposition: exporting dehydrated camel milk powder from Somalia to the US health food market. Future ideas are new rows in the `propositions` table — no new code needed.

System runs research agents → assembles PDF report → delivers by email on a client schedule or on demand.

---

## Infrastructure — COMPLETE

| Item | Status |
|---|---|
| Supabase DB (6 tables) | Done |
| `supabaseClient.js` + `db.js` | Done |
| `.env` with all API keys | Done |
| `assets/logo.png` | Done |
| Seed data (Brendon + camel milk proposition) | Done |
| `package.json` (supabase-js, dotenv) | Done |

**Supabase project:** `https://vupnhlpwfqwmrysohhrq.supabase.co`

**Seed IDs:**
- Client (Brendon McKeever): `ea134c2d-547e-4fcb-b475-65383680c8fb`
- Proposition (Camel Milk Export): `54f51272-d819-4d82-825a-15603ed48654`

---

## Pending DB Migrations (run before building tools)

```sql
ALTER TABLE clients ADD COLUMN status TEXT DEFAULT 'prospect';
ALTER TABLE propositions ADD COLUMN status TEXT DEFAULT 'prospect';
ALTER TABLE propositions ADD COLUMN factor_weights JSONB;
ALTER TABLE reports ADD COLUMN error_message TEXT;
```

Status values — clients: `prospect | active | inactive`
Status values — propositions: `prospect | proposal_sent | active | paused | inactive`

---

## All Decisions — LOCKED

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Hybrid — Claude agents + Brave Search API |
| 2 | Report structure | 14 sections, brand colors, viability score |
| 3 | Report delivery | Resend email to `brennon.mckeever@gmail.com`. PDF attached. No SMS (Twilio shelved — A2P registration required, no website yet). |
| 4 | Run trigger | Per-proposition schedule in DB. On-demand: `node run.js --proposition-id <id> --force` |
| 5 | Baseline vs delta | Full fresh report every run + "What Changed" bullets from run 2 onwards. 6 months history. |
| 6 | Agent architecture | 1 Sonnet orchestrator, ~5 Haiku research sub-agents, 1 Sonnet assembler |
| 7 | Viability score | 6 factors (Market Demand, Regulatory, Competitive, Financial, Supply Chain, Risk), each 1–5, client-defined weights. 4–5 Strong / 2.5–3.9 Moderate / 1–2.4 Weak |
| 8 | Cache TTL | Per-source: market/search 24h, competitive 72h, FDA/regulatory 14 days, exchange rates 24h, Census 30 days, YouTube 72h |
| 9 | On-demand trigger | `node run.js --proposition-id <id> --force` bypasses `next_run_at` |
| 10 | Brave throttling | 500ms fixed delay between calls + exponential backoff on 429s (max 3 retries) |
| 11 | Failure alerting | Resend email to Brendon only (client not notified). Error logged to `reports.error_message`. |
| 12 | Quality check | All 9 agents complete + no null outputs + all 6 score factors populated. Hard fail on technical errors only. |
| 13 | Intake flow | Web form → Supabase (prospect) → email to Brendon → proposal PDF → `node activate.js` flips to active |
| 14 | Python env | `venv` + `requirements.txt` |

---

## Report Structure (14 sections)

1. Cover Page — title, date, viability score
2. Table of Contents
3. Executive Summary
4. Market Overview
5. Competitor Analysis
6. Regulatory Landscape
7. Production & Equipment
8. Packaging
9. Distribution Strategy
10. Marketing & Influencers
11. Financial Projections
12. Risk Assessment
13. Recommendations
14. What Changed This Month *(skipped on first run)*
15. Sources

**Brand:** Deep forest green `#1E4D3B` + warm gold `#C9A84C` + white. Logo on cover and every header/footer.

---

## Workflow List (11 files)

`research_market_overview.md`, `research_competitors.md`, `research_regulatory.md`, `research_production.md`, `research_packaging.md`, `research_distribution.md`, `research_marketing.md`, `research_financials.md`, `research_origin_ops.md`, `research_legal.md`, `assemble_report.md`

---

## What Has NOT Been Built Yet

- [x] Run 4 pending DB migrations
- [x] Create Supabase Storage bucket `reports` (private)
- [x] Python `venv` + `requirements.txt`
- [x] Directories: `workflows/`, `tools/`, `outputs/`, `.tmp/`
- [x] `tools/search_brave.py` — core search tool with throttling
- [x] All 11 workflow `.md` files (see Workflow List below)
- [ ] `db.js` additions — `updateReportPdfUrl()` + any other missing assembler functions
- [ ] All research + assembly Python tools
- [ ] `tools/generate_report_pdf.py` — PDF builder (ReportLab, brand colours, logo)
- [ ] `tools/intake.js`, `tools/generate_proposal.js`, `tools/activate.js`
- [ ] Resend email delivery
- [ ] Orchestrator (`run.js`)
- [ ] `tools/prune_old_reports.js` — deletes reports, agent_outputs, report_sources, and Storage PDFs older than 6 months. Run monthly (post-launch) to prevent DB bloat.

---

## Build Order

1. ~~Run 4 DB migrations~~ ✓
2. ~~Create Supabase Storage bucket (manual)~~ ✓
3. ~~Python venv + requirements.txt~~ ✓
4. ~~Create directories~~ ✓
5. ~~`tools/search_brave.py`~~ ✓
6. ~~All 11 workflows~~ ✓
7. `db.js` additions — `updateReportPdfUrl()` + missing assembler functions
8. `tools/generate_report_pdf.py` — PDF builder
9. `tools/intake.js`, `generate_proposal.js`, `activate.js`
10. Resend email delivery
11. Orchestrator (`run.js`) + scheduled trigger
12. End-to-end test run

---

## Future: Website & Admin Panel

Client-facing site (intake form, about page) + admin panel (view clients/reports, "Run Now" button per proposition). Admin run button wraps the `--force` CLI logic. Build after core system is working. Keep business logic modular so a web layer can sit on top without rework.

---

## Architecture

```
workflows/   ← plain-language SOPs
tools/       ← Python scripts (execution)
db.js        ← all Supabase queries (Node.js)
.env         ← all credentials
outputs/     ← date-stamped PDFs (6 months)
.tmp/        ← disposable intermediates
assets/      ← logo + brand assets
```

Agents read workflows → call tools → write to Supabase via `db.js`.
PDFs uploaded to Supabase Storage `reports` bucket, URL saved to `reports.pdf_url`.
Orchestrator calls `getDuePropositions()` for scheduled runs (active propositions only).
