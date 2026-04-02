# Pre-Build Planning Document

Before writing a single line of code, the following decisions need to be made and questions answered. Nothing here is blocked — these are just the gaps between "we know what we want to build" and "we're ready to build it."

Work through each section in order. Decisions made here will directly determine which tools get written, which workflows get created, and how the agents are structured.

---

## 1. Data & Research Sources

**The most important decision in the entire project.** Everything else depends on how the research actually gets done.

**Open questions:**
- How should the system gather market data? Options:
  - **Web search API** (Tavily, SerpAPI, Perplexity API) — fast, structured, costs per query
  - **Web scraping** (Playwright, BeautifulSoup) — free but fragile, sites change
  - **Claude-driven deep research** — I conduct the research myself each run, no external APIs needed, highest quality but slowest
  - **Hybrid** — Claude researches using a search API as a tool
- Are there any specific data sources you want included? (e.g. IBISWorld, Statista, FDA website, specific competitor sites)
- Should competitor pricing be tracked over time (requires consistent sourcing)?
- Are you willing to pay for a search/research API, or do you want to keep this cost-free?

**Decision needed:** Primary research method and any must-have data sources.

---

## 2. Report Structure & Format

We know the output is a professional PDF. We need to define exactly what's in it before we can build the generation pipeline.

**Open questions:**
- What sections should the report contain, and in what order?
  - Suggested structure: Executive Summary → Market Overview → Competitor Analysis → Regulatory Landscape → Cost Analysis → Production & Equipment → Packaging → Distribution Strategy → Marketing & Influencers → Financial Projections → Risk Assessment → Recommendations
  - Is this the right order? Any sections to add, remove, or rename?
- How deep should each section go? (1-2 pages per section? More?)
- Should there be an **Executive Summary** at the top — a one-page "here's the bottom line" before the full detail?
- Do you want a **Viability Score or Rating** — a simple verdict like "Viability: Strong / Moderate / Weak" with a brief rationale?
- Should each monthly report include a **"What Changed This Month"** section comparing to the prior run?
- Logo placement, header/footer style, font preferences for the PDF?
- Do you want page numbers, a table of contents, date-stamped on the cover?

**Decision needed:** Confirmed section list, rough page target per section, and whether to include a viability rating and monthly delta summary.

---

## 3. Report Delivery

**Open questions:**
- Which Gmail address should the report be sent to?
- Should the email include a summary in the body, or just the PDF as an attachment?
- Should reports be stored locally (in `.tmp/` or an `outputs/` folder) after sending, so there's a history to compare against?
- If running monthly, should the filename include the date (e.g. `camel_milk_report_2026-04.pdf`)?

**Action required:** Provide Gmail address. You will also need to complete a one-time Google OAuth authorization step when we set up the Gmail tool — takes about 2 minutes.

---

## 4. Run Trigger

How do you actually start a report run?

**Options:**
- **Manual command** — you open Claude Code and type something like "run the business report"
- **Script you run yourself** — a `run.py` or `run.bat` file you double-click or run from terminal
- **Scheduled task** — runs automatically on the 1st of each month with no intervention needed (uses Windows Task Scheduler or a cron-style trigger)
- **Hybrid** — scheduled monthly, but you can also trigger on-demand anytime

**Decision needed:** Preferred trigger method. If you want fully automated scheduling, that adds some setup but it's doable.

---

## 5. Baseline vs. Delta Reporting

**Open questions:**
- First run will build the full picture from scratch — that's clear.
- For subsequent runs, do you want:
  - **Full fresh report** — complete re-research every time, standalone document each month
  - **Delta report** — highlights what changed vs. last month (new competitors, price shifts, regulatory updates, etc.) alongside the full report
  - **Both** — full report plus a "Changes Since Last Month" section
- Should the system store previous report data so it can make comparisons, or is each run fully independent?

**Decision needed:** Full refresh, delta, or both.

---

## 6. APIs & Credentials Needed

A list of everything that will need to go into `.env` before the system can run. Exact keys depend on decisions made above, but the likely set is:

| Service | Purpose | Required? |
|---|---|---|
| Search API (Tavily / SerpAPI / Perplexity) | Web research | Depends on Decision 1 |
| Anthropic API | Powering Claude agents | Yes |
| Gmail API (OAuth) | Sending the report | Yes |
| (Optional) Google Drive API | Storing reports in Drive | Optional |

**Action needed:** Once data source decision is made, sign up for any required APIs and have keys ready before build starts.

---

## 7. Workflow Design

Based on the research areas in the README, here's the likely breakdown into individual workflows. Each becomes a `.md` file in `workflows/`.

**Proposed workflows:**
1. `research_market_overview.md` — industry size, trends, growth
2. `research_competitors.md` — US camel milk competitors, pricing, market share
3. `research_regulatory.md` — FDA import rules, health claims, labeling
4. `research_production.md` — machinery, processing, equipment costs
5. `research_packaging.md` — packaging suppliers, MOQs, costs
6. `research_distribution.md` — online vs. retail, Amazon, Whole Foods path
7. `research_marketing.md` — influencers, certifications, health claims science
8. `research_financials.md` — cost model, pricing, margins, startup capital
9. `research_somalia_ops.md` — export permits, logistics, supply chain, risk
10. `research_legal.md` — business structure, insurance, IP
11. `assemble_report.md` — compile all research into PDF and email

**Open questions:**
- Does this breakdown look right, or should any of these be combined or split?
- Should all research workflows run in parallel (faster) or sequentially (simpler)?
- Should there be a "quality check" step before the PDF is assembled?

**Decision needed:** Confirm or adjust the workflow list.

---

## 8. Agent Architecture

**Open questions:**
- Should this be a **single orchestrating agent** that calls each research tool in sequence, or a **multi-agent system** where research areas run in parallel?
- Parallel is faster but more complex to build and debug. Sequential is simpler and cheaper per run. Which matters more right now?
- What model tier should each component use? (Per CLAUDE.md guidelines: Haiku for narrow tasks, Sonnet for orchestration, Opus only if quality is poor)

**Suggested architecture (to confirm):**
- 1 orchestrator agent (Sonnet) — reads the master workflow, spawns research agents, assembles results
- ~5 parallel research sub-agents (Haiku) — each handles 2 related research areas
- 1 report assembly agent (Sonnet) — formats and generates the PDF, sends email

**Decision needed:** Single agent vs. multi-agent, and sign-off on model tier assignments.

---

## 9. Python Environment

Small but needs to be sorted before the first tool is written.

**Open questions:**
- Should we use a virtual environment (`venv`) for this project to keep dependencies isolated?
- Python version: you're running 3.14 — any constraints?
- Should there be a `requirements.txt` so the project is reproducible?

**Recommendation:** Yes to all three — virtual environment, pin the Python version, and maintain a `requirements.txt`. Takes 5 minutes to set up and saves headaches later.

---

## Summary Checklist

| # | Decision | Status |
|---|---|---|
| 1 | Data & research source method | **Needs decision** |
| 2 | Report section structure & depth | **Needs decision** |
| 3 | Gmail address + report storage preference | **Needs decision** |
| 4 | Run trigger method | **Needs decision** |
| 5 | Full refresh vs. delta reporting | **Needs decision** |
| 6 | APIs to sign up for | Blocked by Decision 1 |
| 7 | Workflow list confirmed | **Needs decision** |
| 8 | Agent architecture | **Needs decision** |
| 9 | Python environment setup | **Needs decision** |

Once all 9 are resolved, we are ready to build.
