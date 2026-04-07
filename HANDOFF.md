# Project Handoff — Camel Milk Business Plan System
**Last updated:** 2026-04-07

---

## What This Project Is

An automated business viability intelligence system that answers:
> *Is exporting dehydrated camel milk powder from Somalia to the US health food market a real, viable business?*

The system will run research agents, assemble findings into a professional PDF report, and deliver it by email — on-demand or monthly. It follows the **WAT framework** (Workflows / Agents / Tools) defined in `CLAUDE.md`.

---

## What Has Been Built So Far

### Infrastructure — COMPLETE

| File | Purpose | Status |
|---|---|---|
| `supabaseClient.js` | Initialises a single Supabase client using the service key. Reads credentials from `.env`. Fails fast if keys are missing. | Done |
| `db.js` | Data access layer. All Supabase queries go through here. No other file should touch the client directly. | Done |
| `testDB.js` | Temporary smoke test — insert, read, delete a `clients` row. Confirmed working. Can be deleted. | Done (temp) |
| `.env` | All API keys stored here (gitignored). See keys below. | Done |
| `package.json` | Node dependencies: `@supabase/supabase-js`, `dotenv` | Done |

### Supabase Database — COMPLETE

The database is live at `https://vupnhlpowfqwmrysohhrq.supabase.co`.

**Tables created:**

| Table | Purpose |
|---|---|
| `clients` | Person or org commissioning the report (name, email, company_name, notes, is_active) |
| `propositions` | Research focus / hypothesis a report investigates |
| `reports` | Full lifecycle of a single research run (status: pending → running → complete → failed) |
| `agent_outputs` | Output from each research sub-agent keyed to a report |
| `api_cache` | Cached API responses to avoid redundant calls across runs |
| `report_sources` | Source citations used by agents (URLs, titles, retrieval timestamps) |

### db.js Functions Available

```
createClient(data)                          → insert into clients
createProposition(data)                     → insert into propositions
createReport(data)                          → insert into reports
updateReportStatus(reportId, status)        → update report.status
saveAgentOutput(data)                       → insert into agent_outputs
getAgentOutputsByReportId(reportId)         → fetch all outputs for a report
getCachedApiResponse(cacheKey)              → cache lookup (returns null on miss)
setCachedApiResponse(cacheKey, data)        → upsert cache entry
saveReportSource(data)                      → insert into report_sources
```

### API Keys Available in `.env`

| Key | Service |
|---|---|
| `ANTHROPIC_API_KEY` | Claude agents |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_KEY` | Supabase service key (used by db.js) |
| `BRAVE_SEARCH_KEY` | Web research via Brave Search API |
| `RESEND_API_KEY` | Email delivery (report send) |
| `OPEN_FDA_API_KEY` | FDA data queries |
| `YOUTUBE_API_KEY` | YouTube influencer research |
| `EXCHANGE_RATE_API_KEY` | Currency conversion |
| `CENSUS_API_KEY` | US Census demographic data |

Reddit API is disabled — use Brave Search with `site:reddit.com` queries instead.
Crunchbase is disabled — use Brave Search for competitive intelligence.

---

## What Has NOT Been Built Yet

Everything from the research and delivery layer is still to come:

- [ ] `workflows/` directory — no workflow `.md` files written yet
- [ ] `tools/` Python scripts — no research tools written yet
- [ ] Report generation (PDF)
- [ ] Email delivery (Resend or Gmail)
- [ ] Orchestrator agent / main runner
- [ ] Python virtual environment (`venv`, `requirements.txt`)

---

## Open Decisions (from PRE_BUILD.md — not yet resolved)

These questions were documented before build started. None have been formally answered yet. Check `PRE_BUILD.md` for full detail.

| # | Decision |
|---|---|
| 1 | Primary research method — Brave Search API (likely), web scraping, or Claude-native |
| 2 | Report section structure and depth |
| 3 | Delivery Gmail address + whether to store report history locally |
| 4 | Run trigger — manual command, script, or scheduled (Windows Task Scheduler) |
| 5 | Full monthly refresh vs. delta report vs. both |
| 6 | Confirm API list (Brave Search is available; others TBD) |
| 7 | Confirm workflow list (11 proposed in PRE_BUILD.md) |
| 8 | Single orchestrator vs. multi-agent parallel architecture |
| 9 | Python venv setup |

---

## Next Steps (Recommended Order)

1. Answer the open decisions above (or start with what's already clear and decide the rest as you go)
2. Set up Python venv + `requirements.txt`
3. Write the first workflow file (`workflows/research_market_overview.md`)
4. Write the first research tool (`tools/search_brave.py`)
5. Test the full loop: workflow → tool → db.js → Supabase
6. Expand to remaining research areas in parallel
7. Build report assembly and PDF generation
8. Wire up email delivery with Resend
9. Set up run trigger

---

## Project Architecture Reminder

```
WAT Framework:
  workflows/   ← plain-language SOPs (what to do and how)
  tools/       ← Python scripts that do the actual work
  db.js        ← all database access
  .env         ← all credentials
  .tmp/        ← disposable intermediates generated during runs
```

Agents (Claude) read workflows, call tools, and write results to Supabase via `db.js`.
