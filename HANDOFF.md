# Project Handoff — Business Viability Intelligence System
**Last updated:** 2026-04-07

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

### Supabase Database — COMPLETE

Live at `https://vupnhlpowfqwmrysohhrq.supabase.co`

| Table | Purpose |
|---|---|
| `clients` | Person or org commissioning the report |
| `propositions` | Research focus / hypothesis — includes scheduling fields |
| `reports` | Full lifecycle of a single research run |
| `agent_outputs` | Output from each research sub-agent keyed to a report |
| `api_cache` | Cached API responses to avoid redundant calls |
| `report_sources` | Source citations used by agents |

### Propositions Table — Full Schema

```
id, client_id, title, description,
industry, product_type, origin_country, target_country,
target_demographic, estimated_budget, additional_context,
schedule_type ('monthly'|'weekly'|'quarterly'|'on_demand'),
schedule_day (1-28),
next_run_at (timestamptz),
last_run_at (timestamptz),
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

Reddit API disabled — use Brave Search with `site:reddit.com` instead.
Crunchbase disabled — use Brave Search for competitive intelligence.

### Seed Data — COMPLETE

| Record | ID |
|---|---|
| Client: Brendon McKeever | `ea134c2d-547e-4fcb-b475-65383680c8fb` |
| Proposition: Camel Milk Export | `54f51272-d819-4d82-825a-15603ed48654` |

Brendon's proposition is set to monthly schedule, next run May 1 2026.

---

## All 9 Pre-Build Decisions — LOCKED

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

- [ ] Python `venv` + `requirements.txt`
- [ ] `workflows/` directory and all `.md` workflow files
- [ ] `tools/` Python scripts
- [ ] `outputs/` folder for storing PDFs
- [ ] `.tmp/` folder for intermediate files
- [ ] Report PDF generation
- [ ] Email delivery tool
- [ ] Orchestrator / main runner
- [ ] Supabase Storage bucket for PDF archiving
- [ ] `pdf_url` column added to `reports` table

---

## Pre-Foundation Gaps — TO RESOLVE NEXT SESSION

These were identified in the pre-build review. Resolve all of these before writing any workflows or tools.

| # | Gap | Action Needed |
|---|---|---|
| 1 | Camel milk proposition record has null fields | Fill in `industry`, `product_type`, `origin_country`, `target_country`, `target_demographic`, `estimated_budget`, `additional_context` via SQL update |
| 2 | No client/proposition intake process | Decide: CLI intake script or workflow? Defines how future clients and ideas enter the system |
| 3 | Viability score has no methodology | Define scoring rubric — which factors matter, what thresholds mean Strong / Moderate / Weak |
| 4 | No quality check before PDF assembly | Design a lightweight completeness check the orchestrator runs before handing off to assembly |
| 5 | No failure alerting | Add failure notification email (via Resend) sent to Brendon if a run errors out |
| 6 | `reports` table missing `pdf_url` column | Run SQL migration: `ALTER TABLE reports ADD COLUMN pdf_url TEXT;` |
| 7 | Supabase Storage bucket doesn't exist | Create bucket `reports` in Supabase dashboard for PDF archiving |
| 8 | Cache has no TTL strategy | Define TTL per data type (e.g. regulatory = 30 days, pricing = 7 days) |
| 9 | On-demand trigger undefined | Decide exactly how on-demand runs are kicked off (CLI command? script?) |
| 10 | Brave Search throttling strategy | Define query budget per section + delay between calls |

---

## Recommended Order When Resuming

1. Resolve the 10 pre-foundation gaps above
2. Set up Python `venv` + `requirements.txt`
3. Create `workflows/`, `tools/`, `outputs/`, `.tmp/` directories
4. Write `tools/search_brave.py` — first and most critical tool
5. Write `workflows/research_market_overview.md` — first workflow
6. Test the full loop: workflow → tool → db.js → Supabase
7. Expand to all remaining research workflows
8. Build report assembly and PDF generation
9. Wire up email delivery with Resend
10. Build orchestrator
11. Set up scheduled run trigger

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
Reports uploaded to Supabase Storage, URL saved to `reports.pdf_url`.
Orchestrator queries `getDuePropositions()` to find scheduled runs.
