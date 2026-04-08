# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-08 (Session 8)

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
| `assets/fonts/` (Montserrat 5 weights) | Done — downloaded on first preview run |
| Seed data (Brendon + camel milk proposition) | Done |
| `package.json` (supabase-js, dotenv) | Done |

**Supabase project:** `https://vupnhlpwfqwmrysohhrq.supabase.co`

**Seed IDs:**
- Client (Brendon McKeever): `ea134c2d-547e-4fcb-b475-65383680c8fb`
- Proposition (Camel Milk Export): `54f51272-d819-4d82-825a-15603ed48654`

---

## DB Migrations — ALL COMPLETE

All migrations have been run in the Supabase SQL Editor. Files in `migrations/` are kept as a record.

| Migration | What it added |
|---|---|
| 001 | `clients.status`, `propositions.status`, `propositions.factor_weights` |
| 002 | `reports.error_message` |
| 003 | `propositions.proposition_type` |
| 004 | `clients.phone`, `propositions.plan_tier` |

Status values — clients: `prospect | active | inactive`
Status values — propositions: `prospect | proposal_sent | active | paused | inactive`
proposition_type values: `physical_import_export | physical_domestic | saas_software | service_business | digital_product`

**Note:** Current workflow set fully supports `physical_import_export` and `physical_domestic`. Additional workflow sets required before onboarding `saas_software`, `service_business`, or `digital_product` propositions.

---

## All Decisions — LOCKED

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | Hybrid — Claude agents + Brave Search API |
| 2 | Report structure | 14 sections, brand colors, viability score |
| 3 | Report delivery | Resend email to `brennon.mckeever@gmail.com`. PDF attached. No SMS. |
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
| 15 | Brand / identity | McKeever Consulting. Navy `#1C3557` + Gold `#C8A94A` + Silver `#8A9BB0`. Montserrat font family. |
| 16 | Pricing tiers | Starter $100 (one-time report) / Pro $250 (report + 1 monthly refresh) / Retainer $150/month (ongoing monthly reports) |

---

## Brand Spec (locked in Session 6)

| Element | Value |
|---|---|
| Business name | McKeever Consulting |
| Primary colour | Deep Navy `#1C3557` |
| Accent colour | Warm Gold `#C8A94A` |
| Secondary colour | Slate Silver `#8A9BB0` |
| Body text | Near-Black `#1E1E2E` |
| Background | Off-White `#F7F8FA` |
| Font family | Montserrat (ExtraBold/Bold/SemiBold/Medium/Regular) |
| Logo style | Wordmark — "McKeever" ExtraBold + "C O N S U L T I N G" tracked Medium + gold rule |
| Cover page | Full navy bg, gold report label, white title, gold viability badge, wordmark at bottom |
| Interior header | 30pt navy bar — compact wordmark left, page number right |
| Footer | Silver rule + "Confidential — Prepared by McKeever Consulting" |
| Tables | Gold header row (navy text), alternating white/off-white rows, silver grid lines |
| Callout boxes | Light blue-grey bg `#EEF2F7`, 4pt navy left bar |
| Font files | `assets/fonts/Montserrat-{weight}.ttf` — auto-downloaded from GitHub on first run |

---

## Report Structure (14 sections)

1. Cover Page — title, date, viability score
2. Table of Contents
3. Executive Summary (includes score breakdown table)
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

---

## Workflow List (11 files) — ALL COMPLETE

`research_market_overview.md`, `research_competitors.md`, `research_regulatory.md`, `research_production.md`, `research_packaging.md`, `research_distribution.md`, `research_marketing.md`, `research_financials.md`, `research_origin_ops.md`, `research_legal.md`, `assemble_report.md`

**All 10 research workflows include:**
- 6 primary queries + 6 fallback pairs (triggered if primary returns < 3 useful results)
- Agent-generated queries instruction (up to 3 self-authored queries if coverage still thin)
- Domestic path in `research_origin_ops`, `research_regulatory`, `research_financials` (used when `origin_country == target_country`)

---

## db.js — ALL FUNCTIONS COMPLETE

| Function | Purpose |
|---|---|
| `createClient` | Insert new client |
| `getClientById` | Fetch client by ID (for email delivery) |
| `createProposition` | Insert new proposition |
| `getPropositionById` | Fetch proposition by ID (for --force runs) |
| `updatePropositionSchedule` | Update schedule settings |
| `getDuePropositions` | Fetch all propositions due to run |
| `advancePropositionSchedule` | Advance next_run_at after a run |
| `createReport` | Insert new report record |
| `getReportById` | Fetch report by ID |
| `getReportsByPropositionId` | Fetch all reports for a proposition (determines run_number + previous_report_id) |
| `updateReportStatus` | Set report status |
| `updateReportPdfUrl` | Save signed Storage URL after PDF upload |
| `updateReportError` | Set status=failed + write error_message in one call |
| `saveAgentOutput` | Save a research agent's JSON output |
| `getAgentOutputsByReportId` | Fetch all agent outputs for a report |
| `saveReportSource` | Save a source citation |
| `getCachedApiResponse` | Cache lookup by key |
| `setCachedApiResponse` | Cache upsert by key |
| `updateClientStatus` | Flip client status (prospect → active → inactive) |
| `activateProposition` | Flip proposition to active + set schedule fields |

---

## PDF Content JSON Schema

The assembler agent writes `.tmp/<report_id>_content.json` which `generate_report_pdf.py` reads.
Full schema is documented in the docstring at the top of `tools/generate_report_pdf.py`.

**Block types the assembler can use:**
- `paragraph` — body text string
- `bullets` — optional label + items list
- `table` — headers list + rows list of lists + optional col_widths
- `callout` — label + text (navy left bar box)
- `key_figures` — items list of {label, value} stat cards

---

## Tools — Status

| Tool | Status |
|---|---|
| `tools/search_brave.py` | Done |
| `tools/preview_brand.py` | Done — generates 2-page brand preview PDF |
| `tools/generate_report_pdf.py` | Done — full production PDF builder. Badge fix applied (Session 7): verdict/score split to two lines, badge widened 200→240pt |
| `tools/intake.js` | Done — writes prospect to clients + propositions, emails Brendon |
| `tools/generate_proposal_pdf.py` | Done — branded proposal PDF builder (ReportLab, same brand as report) |
| `tools/generate_proposal.js` | Done — fetches data, runs PDF builder, emails client + Brendon |
| `tools/activate.js` | Done — flips to active, sets schedule, triggers first run |
| `tools/prune_old_reports.js` | Not built (post-launch) |

---

## Build Order

1. ~~Run DB migrations (001–004)~~ ✓
2. ~~Create Supabase Storage bucket (manual)~~ ✓
3. ~~Python venv + requirements.txt~~ ✓
4. ~~Create directories~~ ✓
5. ~~`tools/search_brave.py`~~ ✓
6. ~~All 11 workflows~~ ✓
7. ~~`db.js` — all functions~~ ✓
8. ~~`tools/generate_report_pdf.py` — PDF builder~~ ✓
9. ~~`tools/intake.js`, `generate_proposal_pdf.py`, `generate_proposal.js`, `activate.js`~~ ✓
10. Orchestrator (`run.js`) + scheduled trigger ← **NEXT**
11. End-to-end test run

---

## Next Up — Step 10: Build Orchestrator (`run.js`)

Build `run.js` — the orchestrator that:
- Accepts `--proposition-id <id> --force` for on-demand runs
- Calls `getDuePropositions()` for scheduled runs
- Spawns research sub-agents per workflow
- Calls assembler agent → writes content JSON → calls `generate_report_pdf.py`
- Uploads PDF to Supabase Storage, saves URL, sends report email to client

## Intake Flow (complete — Step 9 done)

```
node tools/intake.js --name "..." --email "..." --phone "..." ...
  → writes to clients + propositions (status: prospect)
  → emails Brendon

node tools/generate_proposal.js --proposition-id <id>
  → generates branded proposal PDF
  → emails PDF to client + Brendon
  → flips proposition status → proposal_sent

node tools/activate.js --proposition-id <id>
  → flips client + proposition → active
  → sets schedule (monthly for retainer, on_demand for starter/pro)
  → triggers first run via run.js (when built)
```

## Pricing Tiers (locked Session 8)

| Plan | Price | What's Included |
|---|---|---|
| Starter | $100 | One-time report |
| Pro | $250 | One-time report + 1 monthly refresh |
| Retainer | $150/month | Ongoing monthly reports |

---

## Future: Website & Admin Panel

Client-facing site (intake form, about page) + admin panel (view clients/reports, "Run Now" button per proposition). Admin run button wraps the `--force` CLI logic. Build after core system is working.

---

## Architecture

```
workflows/   ← plain-language SOPs
tools/       ← Python + Node.js scripts (execution)
db.js        ← all Supabase queries (Node.js)
.env         ← all credentials
outputs/     ← date-stamped PDFs (6 months)
.tmp/        ← disposable intermediates
assets/      ← logo, brand assets, fonts/
```

Agents read workflows → call tools → write to Supabase via `db.js`.
PDFs uploaded to Supabase Storage `reports` bucket, URL saved to `reports.pdf_url`.
Orchestrator calls `getDuePropositions()` for scheduled runs (active propositions only).

---

## Key File Notes

- `tools/preview_brand.py` — standalone brand preview tool, not called by the orchestrator. Run manually to check visual changes: `python tools/preview_brand.py` → `outputs/mckeever_brand_preview.pdf`
- `assets/fonts/` — Montserrat TTF files. Auto-downloaded by `preview_brand.py` and `generate_report_pdf.py` on first run if missing.
- No logo image file — the McKeever wordmark is drawn in code by both PDF tools (canvas API). No external asset needed.
