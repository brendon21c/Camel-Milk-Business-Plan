# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-07 (Session 3)

---

## What This Project Is

An automated business viability intelligence system that answers:
> *Is a given business idea viable — and how does that picture change over time?*

The system is **generic by design**. The first proposition being researched is:
> *Is exporting dehydrated camel milk powder from Somalia to the US health food market a real, viable business?*

Future propositions (different business ideas, different clients) are added as new rows in the `propositions` table. No new code is needed for each new idea.

The system runs research agents, assembles findings into a professional PDF report, and delivers it by email — on a client-defined schedule or on demand. It follows the **WAT framework** (Workflows / Agents / Tools) defined in `CLAUDE.md`.

---

## What Has Been Built

### Infrastructure — COMPLETE

| File | Purpose | Status |
|---|---|---|
| `supabaseClient.js` | Initialises Supabase client using service key. Reads from `.env`. Fails fast if keys missing. | Done |
| `db.js` | Data access layer. All Supabase queries go through here. Updated with scheduling functions. | Done |
| `.env` | All API keys stored here (gitignored). | Done |
| `package.json` | Node dependencies: `@supabase/supabase-js`, `dotenv` | Done |
| `assets/logo.png` | B & I logo — deep forest green + warm gold. Used for report branding. | Done |

### Supabase Database — COMPLETE (with pending migrations)

Live at `https://vupnhlpowfqwmrysohhrq.supabase.co`

| Table | Purpose |
|---|---|
| `clients` | Person or org commissioning the report |
| `propositions` | Research focus / hypothesis — includes scheduling fields |
| `reports` | Full lifecycle of a single research run |
| `agent_outputs` | Output from each research sub-agent keyed to a report |
| `api_cache` | Cached API responses to avoid redundant calls |
| `report_sources` | Source citations used by agents |

### Pending DB Migrations (run before building tools)

These schema changes were decided this session but not yet applied:

```sql
-- 1. Add status to clients table
ALTER TABLE clients ADD COLUMN status TEXT DEFAULT 'prospect';
-- Values: 'prospect' | 'active' | 'inactive'

-- 2. Add status to propositions table
ALTER TABLE propositions ADD COLUMN status TEXT DEFAULT 'prospect';
-- Values: 'prospect' | 'proposal_sent' | 'active' | 'paused' | 'inactive'

-- 3. Add factor_weights to propositions table
ALTER TABLE propositions ADD COLUMN factor_weights JSONB;
-- Default: {"market_demand":1.0,"regulatory_feasibility":1.0,"competitive_landscape":1.0,"financial_viability":1.0,"supply_chain_reliability":1.0,"risk_level":1.0}

-- 4. Add error_message to reports table
ALTER TABLE reports ADD COLUMN error_message TEXT;
```

### Propositions Table — Full Schema

```
id, client_id, title, description,
industry, product_type, origin_country, target_country,
target_demographic, estimated_budget, additional_context,
schedule_type ('monthly'|'weekly'|'quarterly'|'on_demand'),
schedule_day (1-28),
next_run_at (timestamptz),
last_run_at (timestamptz),
status ('prospect'|'proposal_sent'|'active'|'paused'|'inactive'),  ← PENDING MIGRATION
factor_weights (JSONB),                                              ← PENDING MIGRATION
created_at, updated_at
```

### db.js Functions Available

```
createClient(data)
createProposition(data)
updatePropositionSchedule(propositionId, schedule)
getDuePropositions()                          ← finds propositions where next_run_at <= now
advancePropositionSchedule(id, type, day)     ← advances next_run_at after a run completes
createReport(data)
updateReportStatus(reportId, status)
saveAgentOutput(data)
getAgentOutputsByReportId(reportId)
getCachedApiResponse(cacheKey)
setCachedApiResponse(cacheKey, data)
saveReportSource(data)
```

### API Keys in `.env`

| Key | Service |
|---|---|
| `ANTHROPIC_API_KEY` | Claude agents |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_KEY` | Supabase service key (used by db.js) |
| `BRAVE_SEARCH_KEY` | Web research via Brave Search API |
| `RESEND_API_KEY` | Email delivery |
| `OPEN_FDA_API_KEY` | FDA data queries |
| `YOUTUBE_API_KEY` | YouTube influencer research |
| `EXCHANGE_RATE_API_KEY` | Currency conversion |
| `CENSUS_API_KEY` | US Census demographic data |
| `TWILIO_ACCOUNT_SID` | SMS alerting |
| `TWILIO_AUTH_TOKEN` | SMS alerting |
| `TWILIO_FROM_NUMBER` | Twilio phone number (sends from) |
| `TWILIO_TO_NUMBER` | Brendon's personal cell (receives alerts) |

Reddit API disabled — use Brave Search with `site:reddit.com` instead.
Crunchbase disabled — use Brave Search for competitive intelligence.
**SerpAPI** identified as premium search upgrade for the future (~$200/month). Same swap pattern: add key to `.env`, write `tools/search_serp.py`, update workflows. No other changes needed.

### Seed Data — COMPLETE

| Record | ID |
|---|---|
| Client: Brendon McKeever | `ea134c2d-547e-4fcb-b475-65383680c8fb` |
| Proposition: Camel Milk Export | `54f51272-d819-4d82-825a-15603ed48654` |

Brendon's proposition is set to monthly schedule, next run May 1 2026.

**Camel milk proposition null fields filled (Session 3):**
- `industry`: Health Food & Functional Beverages
- `product_type`: Dehydrated Camel Milk Powder
- `origin_country`: Somalia
- `target_country`: United States
- `target_demographic`: Health-conscious adults 25–55; lactose-intolerant consumers; paleo/keto dieters; Muslim-American community
- `estimated_budget`: 50000
- `additional_context`: FDA registration pathway, halal certification as market signal, DTC + specialty retail channels

---

## All Pre-Build Decisions — LOCKED

| # | Decision | Outcome |
|---|---|---|
| 1 | Research method | **Hybrid** — Claude agents + Brave Search API |
| 2 | Report structure | 14 sections (see below). Logo colors. Clean business layout. Viability score. |
| 3 | Report delivery | Resend to `brennon.mckeever@gmail.com`. PDF attached. Short summary in body. Subject: `{Business Idea} — {Month Year}`. Reports saved to `outputs/` date-stamped. |
| 4 | Run trigger | Per-proposition schedule stored in DB. Default monthly. On-demand always available. |
| 5 | Baseline vs delta | Both — full fresh report every run + brief bullet-point "What Changed" section from run 2 onwards. 6 months of full report history stored and retrievable on demand. |
| 6 | APIs | All already in `.env`. No new signups needed. |
| 7 | Workflow list | 11 workflows confirmed (see below). `research_origin_ops.md` replaces `research_somalia_ops.md` for generics. |
| 8 | Agent architecture | Multi-agent parallel. 1 Sonnet orchestrator. ~5 Haiku research sub-agents. 1 Sonnet report assembler. |
| 9 | Python environment | `venv` + `requirements.txt`. Not set up yet — first task when resuming. |

---

## Pre-Foundation Gaps — STATUS

| # | Gap | Status |
|---|---|---|
| 1 | Camel milk proposition null fields | ✅ DONE — filled this session |
| 2 | Client/proposition intake process | ✅ LOCKED — see full intake flow below |
| 3 | Viability score methodology | ✅ LOCKED — see rubric below |
| 4 | Quality check before PDF assembly | ✅ LOCKED — see completeness check below |
| 5 | Failure alerting | ✅ LOCKED — Resend email + Twilio SMS to Brendon + DB error log |
| 6 | `pdf_url` column on reports table | ✅ DONE — column already existed, confirmed live |
| 7 | Supabase Storage bucket | ⏳ PENDING — Brendon must create manually (see below) |
| 8 | Cache TTL strategy | ⏳ NOT YET DISCUSSED |
| 9 | On-demand trigger | ⏳ NOT YET DISCUSSED |
| 10 | Brave Search throttling strategy | ⏳ NOT YET DISCUSSED |

---

## Gap 2 — Intake Flow (LOCKED)

**Full business process:**
1. Client reaches out (email, referral — outside the system)
2. Client fills out form on website → intake schema captured
3. Brendon gets notification email with formatted summary
4. Brendon reviews → system generates a **PDF proposal** (scope, cost, timeline) for Brendon to send
5. Client agrees and signs (DocuSign or similar — outside the system for now)
6. Brendon runs `node activate.js --proposition-id <id>` → proposition goes `active` → research begins

**Tools to build:**
- `tools/intake.js` — validates intake data, writes client + proposition to Supabase (status: `prospect`), emails Brendon summary
- `tools/generate_proposal.js` — generates PDF proposal for Brendon to send to client
- `tools/activate.js` — flips proposition status to `active`, sets `next_run_at`, kicks off first research run

**Intake schema** (these become the web form fields):
```
client_name, client_email, client_company (optional)
proposition_title, proposition_description
industry, product_type, origin_country, target_country
target_demographic, estimated_budget
additional_context
schedule_type, schedule_day
factor_weights (per viability rubric below)
```

**Status flow:**
- Clients: `prospect → active → inactive`
- Propositions: `prospect → proposal_sent → active → paused → inactive`
- Orchestrator only picks up `active` propositions

---

## Gap 3 — Viability Score Rubric (LOCKED)

**6 factors, each scored 1–5 by the assembly agent:**

| Factor | What it measures |
|---|---|
| Market Demand | Real, growing demand in the target market |
| Regulatory Feasibility | How clear and navigable the compliance path is |
| Competitive Landscape | Room to enter vs. how crowded the space is |
| Financial Viability | Unit economics at realistic volumes |
| Supply Chain Reliability | Consistent sourcing and delivery |
| Risk Level | Number and severity of serious risks (inverted — lower risk = higher score) |

**Client-defined weights** stored in `propositions.factor_weights` (JSONB):
```json
{
  "market_demand": 1.0,
  "regulatory_feasibility": 1.0,
  "competitive_landscape": 1.0,
  "financial_viability": 1.0,
  "supply_chain_reliability": 1.0,
  "risk_level": 1.0
}
```
Weight tiers: `1.0` (Normal) | `1.5` (Important) | `2.0` (Critical)

**Scoring:** Weighted average of all 6 factors.
- 4.0–5.0 → **Strong**
- 2.5–3.9 → **Moderate**
- 1.0–2.4 → **Weak**

---

## Gap 4 — Completeness Check (LOCKED)

Before handing off to PDF assembly, orchestrator verifies:

1. All 9 research agents have `status = 'complete'` in `agent_outputs`
2. No output field is null or empty string
3. All 6 viability score factors have a numeric value

**Hard fail only on technical errors** (agent crash, API timeout, DB write failure) — not on data sparsity. If data is thin, the agent notes it in its output and continues. Brave Search + Claude reasoning is sufficient to produce meaningful content for every section.

On failure: report marked `failed`, `error_message` written to DB, Brendon notified via Resend email + Twilio SMS.

---

## Gap 5 — Failure Alerting (LOCKED)

On any run failure:
- **Resend email** → `brennon.mckeever@gmail.com` with: proposition name, failed agent/step, error message, timestamp
- **Twilio SMS** → Brendon's cell with short summary (e.g. "Run failed: Camel Milk Export — supply chain agent error. Check email.")
- **DB log** → `reports.status = 'failed'`, `reports.error_message` = full error detail

Client is **not notified** — Brendon reaches out directly.

---

## Gap 7 — Supabase Storage Bucket (PENDING — MANUAL STEP)

**Action required before building PDF tools:**
1. Go to Supabase project → **Storage**
2. Create new bucket named `reports`
3. Set to **private**

Once created, PDF upload tool can reference it. Confirm done before building `tools/generate_report_pdf.py`.

---

## Report Structure (Locked)

1. Cover Page — proposition title, date, viability score (Strong / Moderate / Weak)
2. Table of Contents
3. Executive Summary — 1 page, bottom line up front
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
14. What Changed This Month *(bullet points only, skipped on first run)*
15. Sources

**Design:** Deep forest green (`#1E4D3B`) + warm gold (`#C9A84C`) + white. Clean sans-serif body, professional serif headings. Charts and graphs in brand colors. Logo on cover and every page header/footer.

---

## Confirmed Workflow List

1. `research_market_overview.md`
2. `research_competitors.md`
3. `research_regulatory.md`
4. `research_production.md`
5. `research_packaging.md`
6. `research_distribution.md`
7. `research_marketing.md`
8. `research_financials.md`
9. `research_origin_ops.md` *(generic — covers any sourcing country)*
10. `research_legal.md`
11. `assemble_report.md`

---

## What Has NOT Been Built Yet

- [ ] DB migrations (status columns, factor_weights, error_message) — run SQL before building tools
- [ ] Supabase Storage bucket `reports` — create manually in dashboard
- [ ] Python `venv` + `requirements.txt`
- [ ] `workflows/` directory and all `.md` workflow files
- [ ] `tools/` Python scripts
- [ ] `outputs/` folder for storing PDFs
- [ ] `tools/intake.js` — client/proposition intake
- [ ] `tools/generate_proposal.js` — PDF proposal for client
- [ ] `tools/activate.js` — activates proposition and kicks off first run
- [ ] Report PDF generation
- [ ] Email delivery tool (Resend)
- [ ] SMS alert tool (Twilio)
- [ ] Orchestrator / main runner

---

## Recommended Order When Resuming

1. Finish remaining gap decisions: Gap 8 (cache TTL), Gap 9 (on-demand trigger), Gap 10 (Brave Search throttling)
2. Run the 4 pending DB migrations (status, factor_weights, error_message columns)
3. Create Supabase Storage bucket `reports` (manual — dashboard)
4. Set up Python `venv` + `requirements.txt`
5. Create `workflows/`, `tools/`, `outputs/`, `.tmp/` directories
6. Write `tools/search_brave.py` — first and most critical tool
7. Write `workflows/research_market_overview.md` — first workflow
8. Test the full loop: workflow → tool → db.js → Supabase
9. Build `tools/intake.js`, `tools/generate_proposal.js`, `tools/activate.js`
10. Expand to all remaining research workflows
11. Build report assembly and PDF generation
12. Wire up Resend email + Twilio SMS delivery
13. Build orchestrator
14. Set up scheduled run trigger

---

## Project Architecture Reminder

```
WAT Framework:
  workflows/   ← plain-language SOPs (what to do and how)
  tools/       ← Python scripts that do the actual work
  db.js        ← all database access (Node.js)
  .env         ← all credentials
  outputs/     ← date-stamped PDF reports (kept 6 months)
  .tmp/        ← disposable intermediates generated during runs
  assets/      ← logo and brand assets
```

Agents (Claude) read workflows, call tools, write results to Supabase via `db.js`.
Reports uploaded to Supabase Storage (`reports` bucket), URL saved to `reports.pdf_url`.
Orchestrator queries `getDuePropositions()` to find scheduled runs (active propositions only).
On failure: Resend email + Twilio SMS to Brendon, error logged to DB.
