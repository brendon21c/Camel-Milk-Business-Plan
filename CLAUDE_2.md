# Agent Instructions — McKeever Consulting Web

This is the CLAUDE.md for the **mckeever-consulting-web** project. Rename it to `CLAUDE.md` when setting up the new repo.

This project is the website and admin panel for McKeever Consulting. It is a **separate repo** from the backend report engine (`Camel-Milk-Business-Plan`), but the two are tightly connected via a shared Supabase project and a GitHub Actions trigger.

---

## The WAT Framework

You're working inside the **WAT framework** (Workflows, Agents, Tools). This architecture separates concerns so that probabilistic AI handles reasoning while deterministic code handles execution. That separation is what makes this system reliable.

**Layer 1: Workflows (The Instructions)**
- Markdown SOPs stored in `workflows/`
- Each workflow defines the objective, required inputs, which tools to use, expected outputs, and how to handle edge cases
- Written in plain language, the same way you'd brief someone on your team

**Layer 2: Agents (The Decision-Maker)**
- This is your role. You're responsible for intelligent coordination.
- Read the relevant workflow, run tools in the correct sequence, handle failures gracefully, and ask clarifying questions when needed
- You connect intent to execution without trying to do everything yourself

**Layer 3: Tools (The Execution)**
- Scripts and API calls that do the actual work
- Credentials and API keys are stored in `.env`
- These are consistent, testable, and fast

**Why this matters:** When AI tries to handle every step directly, accuracy drops fast. By offloading execution to deterministic code, you stay focused on orchestration and decision-making where you excel.

---

## How to Operate

**1. Look for existing tools first**
Before building anything new, check `tools/` based on what your workflow requires. Only create new scripts when nothing exists for that task.

**2. Learn and adapt when things fail**
When you hit an error:
- Read the full error message and trace
- Fix the issue and retest (if it uses paid API calls or credits, check with me before running again)
- Document what you learned in the workflow

**3. Keep workflows current**
Workflows should evolve as you learn. Don't create or overwrite workflows without asking unless explicitly told to.

---

## Model Selection

| Tier | When to use |
|---|---|
| **Fast (Haiku)** | Simple tasks — classification, formatting, short Q&A, data extraction |
| **Balanced (Sonnet)** | General work — writing, coding, summarization, most tool use |
| **Powerful (Opus)** | Complex reasoning — multi-step planning, architecture decisions, ambiguous problems |

**Rules:**
- Subagents doing narrow, well-defined work → Haiku
- Main orchestrating agent → Sonnet
- Only reach for Opus when the task genuinely requires deep reasoning
- Never default to Opus — cost compounds fast in multi-agent runs

---

## Agent Orchestration

Spawning agents has a cost — in tokens, latency, and complexity. Only do it when it's genuinely better than doing the work sequentially yourself.

**Spawn a subagent when:**
- A task can run in parallel with other work and speed matters
- A task is self-contained enough to brief in a single prompt

**Don't spawn a subagent when:**
- Sequential tool calls handle it fine
- The task requires ongoing context from the main conversation

**Default:** Prefer sequential execution unless parallelism has a clear benefit. When in doubt, ask before spawning.

---

## Project Decomposition

Before starting any project with more than 2-3 steps, stop and plan first.

1. Identify the final deliverable and work backwards
2. Map dependencies — what must be true before each step can start
3. Identify what can run in parallel vs. what must be sequential
4. Define a quality checkpoint at each major phase boundary
5. Present the plan before starting — don't execute speculatively on large projects

**Never start building before the plan is aligned.**

---

## File Structure

```
app/                # Next.js app router pages and layouts
components/         # Reusable UI components
lib/                # Supabase client, GitHub API client, utilities
workflows/          # Markdown SOPs
.env.local          # API keys and secrets (NEVER store secrets anywhere else)
```

---

## Code Style

**Always comment code, in any language.**
- Add a comment to every function/component/route explaining what it does and *why*
- Inline comments on any line that isn't immediately obvious
- Explain the *reason* behind a choice, not just what the code does
  - Good: `// optimistic update before server confirmation to avoid UI flicker`
  - Bad: `// update state`
- This applies to TypeScript, JSX, SQL, CSS, bash — everything

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) |
| Styling | Tailwind CSS |
| Components | shadcn/ui |
| Database / Auth / Storage | Supabase JS client |
| Email | (not needed — handled by backend engine via Resend) |
| Deployment | Vercel |

---

## Brand

| Token | Value |
|---|---|
| Primary (Navy) | `#1C3557` |
| Accent (Gold) | `#C8A94A` |
| Secondary (Silver) | `#8A9BB0` |
| Font | Montserrat (Google Fonts) |
| Brand name | McKeever Consulting |

Apply these consistently across all pages. The admin panel can be more utilitarian, but should still use the navy/gold palette.

---

## Connection to the Backend Engine

This website connects to the report engine (`Camel-Milk-Business-Plan` repo) in two ways:

### 1. Supabase — Shared Data Layer

Both projects use the **same Supabase project**. The website reads and writes directly to the same database — no API layer needed between them.

**Supabase project URL:** `https://vupnhlpwfqwmrysohhrq.supabase.co`

Add to `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://vupnhlpwfqwmrysohhrq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_KEY=<service key>   # admin panel only — never expose to browser
```

### 2. GitHub Actions — Run Trigger

The admin panel's **Run Now** button triggers report runs by calling the GitHub API to dispatch the `reports.yml` workflow in the backend repo.

**Endpoint:**
```
POST https://api.github.com/repos/{owner}/Camel-Milk-Business-Plan/actions/workflows/reports.yml/dispatches
Authorization: Bearer {GITHUB_TOKEN}

{
  "ref": "main",
  "inputs": {
    "proposition_id": "<uuid>",
    "force": "true"
  }
}
```

Add to `.env.local`:
```
GITHUB_TOKEN=<fine-grained personal access token — Actions: read/write scope on the backend repo>
GITHUB_REPO_OWNER=<your GitHub username>
```

**Run status:** After triggering, poll the `reports` table in Supabase for status updates. The backend engine writes `status = 'running' | 'complete' | 'failed'` to that table in real time. Use Supabase Realtime subscriptions for live UI updates.

---

## Database Schema

All tables live in the shared Supabase project. The website reads and writes these directly.

| Table | Purpose | Website access |
|---|---|---|
| `organizations` | Companies — has `status` and `plan_tier` | Read/write (admin panel) |
| `organization_admins` | Who administers each org | Read (admin panel) |
| `clients` | Individual contacts linked to an org | Read/write (admin panel + intake form) |
| `propositions` | Business propositions — schedule, plan tier, type | Read/write (admin panel + intake form) |
| `proposition_recipients` | Who receives the report per proposition | Read/write (admin panel) |
| `reports` | One row per run — status, run_number, PDF storage path | Read (admin panel — view + run status) |
| `agent_outputs` | Temporary research data — deleted post-run | No access needed |
| `report_sources` | Source URLs cited in reports | Read (admin panel — report detail view) |
| `api_cache` | Brave Search cache | No access needed |

**Key field values to know:**

`organization.status`: `prospect | pending | active | cancelled | inactive`
- Only `active` orgs run reports. Flip to `inactive` to pause without deleting data.

`proposition.plan_tier`: `starter | pro | retainer`
- Starter: 1 run. Pro: 2 runs. Retainer: unlimited monthly.

`proposition.proposition_type`: `physical_import_export | physical_domestic | saas_software | service_business | digital_product`
- Only `physical_import_export` and `physical_domestic` have full research workflows currently.

`report.status`: `running | complete | failed`

**PDF retrieval:** PDFs are stored in Supabase Storage, bucket `reports`, path `{proposition_id}/{reportId}.pdf`. Request a signed URL via the Supabase client to render or download in-browser.

---

## Key Seed IDs

| Record | ID / lookup |
|---|---|
| Organization — B & I | query `organizations` where `name = 'B & I'` |
| Organization — McKeever Consulting | query `organizations` where `name = 'McKeever Consulting'` |
| Client — Brendon McKeever | `ea134c2d-547e-4fcb-b475-65383680c8fb` |
| Client — Iman Warsame | query `clients` where `email = 'imanw22@gmail.com'` |
| Proposition — Camel Milk Export | `54f51272-d819-4d82-825a-15603ed48654` |

---

## Pages & Features to Build

| Page / Feature | Notes |
|---|---|
| `/` — Landing page | McKeever Consulting brand, service overview, CTA to intake form |
| `/intake` — Intake form | Branching form. V2: physical proposition questions. V3 types stubbed as "coming soon". Writes to `clients`, `propositions`, `proposition_recipients`. |
| `/admin` — Dashboard | Requires auth (Supabase Auth). Overview: active propositions, recent runs, client count. |
| `/admin/propositions` | List all propositions. Run Now button (GitHub Actions dispatch). Live run status via Supabase Realtime. |
| `/admin/reports` | Report history per proposition. View/download PDF from Supabase Storage. |
| `/admin/clients` | Manage organizations and clients. Activate/deactivate. Edit plan tier. |

**Auth:** Supabase Auth. Admin panel routes are protected — unauthenticated users redirect to `/login`. The intake form is public.

---

## Intake Form — V2 Question Set (Physical Propositions)

The form must be **branching** — questions change based on proposition type. For the initial build, fully implement V2 physical propositions. Stub V3 types as "coming soon" so the component is branching-aware from day one.

**Branch: Physical product (import/export or domestic)**

| Question | DB field | Notes |
|---|---|---|
| Client full name | `clients.name` | |
| Client email | `clients.email` | |
| Company name | `organizations.name` | |
| Product name / description | `propositions.product_description` | Free text |
| Industry category | `propositions.industry_category` | Dropdown: food/beverage, energy/clean tech, medical devices, chemicals/materials, electronics, apparel/textiles, cosmetics, general manufacturing |
| Proposition type | `propositions.proposition_type` | Import/export or domestic |
| Origin country | `propositions.origin_country` | If import/export |
| Target market | `propositions.target_country` | |
| Plan tier | `propositions.plan_tier` | Dropdown: starter ($100), pro ($250), retainer ($150/mo) |

**Note:** `industry_category` and any other new fields require migration 009 before the form can write them. Coordinate with the backend project before deploying the form.

---

## Decisions Already Made

| Decision | Outcome |
|---|---|
| MCP | Ruled out. Tool layer stays as Python subprocesses in the backend engine. |
| Run trigger | GitHub Actions `workflow_dispatch` API. No new servers needed. |
| Shared data layer | Supabase — same project as the backend engine. |
| Auth | Supabase Auth for admin panel. Intake form is public. |
| Web app structure | Separate repo. Connects via Supabase + GitHub Actions. Not embedded in the backend engine repo. |
| Deployment | Vercel. |

---

## Bottom Line

You sit between what Brendon wants (workflows) and what actually gets done (code). Your job is to read instructions, make smart decisions, write clean code, recover from errors, and keep improving the system as you go.

Stay pragmatic. Stay reliable. Keep learning.
