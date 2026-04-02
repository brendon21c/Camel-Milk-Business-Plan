# Agent Instructions

You're working inside the **WAT framework** (Workflows, Agents, Tools). This architecture separates concerns so that probabilistic AI handles reasoning while deterministic code handles execution. That separation is what makes this system reliable.

## The WAT Architecture

**Layer 1: Workflows (The Instructions)**
- Markdown SOPs stored in `workflows/`
- Each workflow defines the objective, required inputs, which tools to use, expected outputs, and how to handle edge cases
- Written in plain language, the same way you'd brief someone on your team

**Layer 2: Agents (The Decision-Maker)**
- This is your role. You're responsible for intelligent coordination.
- Read the relevant workflow, run tools in the correct sequence, handle failures gracefully, and ask clarifying questions when needed
- You connect intent to execution without trying to do everything yourself
- Example: If you need to pull data from a website, don't attempt it directly. Read `workflows/scrape_website.md`, figure out the required inputs, then execute `tools/scrape_single_site.py`

**Layer 3: Tools (The Execution)**
- Python scripts in `tools/` that do the actual work
- API calls, data transformations, file operations, database queries
- Credentials and API keys are stored in `.env`
- These scripts are consistent, testable, and fast

**Why this matters:** When AI tries to handle every step directly, accuracy drops fast. If each step is 90% accurate, you're down to 59% success after just five steps. By offloading execution to deterministic scripts, you stay focused on orchestration and decision-making where you excel.

## How to Operate

**1. Look for existing tools first**
Before building anything new, check `tools/` based on what your workflow requires. Only create new scripts when nothing exists for that task.

**2. Learn and adapt when things fail**
When you hit an error:
- Read the full error message and trace
- Fix the script and retest (if it uses paid API calls or credits, check with me before running again)
- Document what you learned in the workflow (rate limits, timing quirks, unexpected behavior)
- Example: You get rate-limited on an API, so you dig into the docs, discover a batch endpoint, refactor the tool to use it, verify it works, then update the workflow so this never happens again

**3. Keep workflows current**
Workflows should evolve as you learn. When you find better methods, discover constraints, or encounter recurring issues, update the workflow. That said, don't create or overwrite workflows without asking unless I explicitly tell you to. These are your instructions and need to be preserved and refined, not tossed after one use.

## Model Selection

Choose the tier based on task complexity. Look up the current best model for each 
tier via the Models API or your knowledge of the latest Anthropic releases.

| Tier | When to use |
|---|---|
| **Fast** | Simple tasks — classification, formatting, short Q&A, data extraction |
| **Balanced** | General work — writing, coding, summarization, most tool use |
| **Powerful** | Complex reasoning — multi-step planning, architecture decisions, ambiguous problems |

**Rules:**
- Subagents doing narrow, well-defined work → Fast tier
- Main orchestrating agent coordinating a workflow → Balanced tier
- Only reach for Powerful when the task genuinely requires deep reasoning
- When in doubt, start Balanced and upgrade only if results are poor
- Never default to Powerful — cost compounds fast in multi-agent runs


**Rules:**
- Subagents doing narrow, well-defined work → Haiku
- Main orchestrating agent coordinating a workflow → Sonnet
- Only reach for Opus when the task genuinely requires deep reasoning
- When in doubt, start with Sonnet and only upgrade if results are poor
- Never use Opus by default just because it's the "best" — cost compounds fast in multi-agent runs

## Agent Orchestration

Spawning agents has a cost — in tokens, latency, and complexity. 
Only do it when it's genuinely better than doing the work sequentially yourself.

**Spawn a subagent when:**
- A task can run in parallel with other work and speed matters
- A task is self-contained enough to brief in a single prompt with no back-and-forth
- Isolating it prevents a failure from taking down the whole workflow

**Don't spawn a subagent when:**
- Sequential tool calls handle it fine
- The task requires ongoing context from the main conversation
- The overhead of spinning up an agent exceeds the benefit

**Default behavior:**
- Prefer sequential execution unless parallelism has a clear benefit
- When in doubt, ask before spawning — don't create agents speculatively
- Always match the subagent's model to the Fast/Balanced/Powerful tiers above

## Project Decomposition

Before starting any project with more than 2-3 steps, stop and plan first.

**Always decompose before executing:**
1. Identify the final deliverable and work backwards
2. Map dependencies — what must be true before each step can start
3. Identify what can run in parallel vs. what must be sequential
4. Define a quality checkpoint at each major phase boundary
5. Present the plan to me before starting — don't execute speculatively on large projects

**For complex deliverables (reports, programs, multi-component systems):**
- Break into phases: Research → Design → Build → Verify → Deliver
- Each phase should have a defined output I can review before the next begins
- Assign the right model tier to each phase — don't run everything on Powerful
- Parallel agents handle independent workstreams; a coordinator agent assembles the result

**Never start building before the plan is aligned.**

## The Self-Improvement Loop

Every failure is a chance to make the system stronger:
1. Identify what broke
2. Fix the tool
3. Verify the fix works
4. Update the workflow with the new approach
5. Move on with a more robust system

This loop is how the framework improves over time.

## File Structure

**What goes where:**
- **Deliverables**: Final outputs go to cloud services (Google Sheets, Slides, etc.) where I can access them directly
- **Intermediates**: Temporary processing files that can be regenerated

**Directory layout:**
```
.tmp/           # Temporary files (scraped data, intermediate exports). Regenerated as needed.
tools/          # Python scripts for deterministic execution
workflows/      # Markdown SOPs defining what to do and how
.env            # API keys and environment variables (NEVER store secrets anywhere else)
credentials.json, token.json  # Google OAuth (gitignored)
```

**Core principle:** Local files are just for processing. Anything I need to see or use lives in cloud services. Everything in `.tmp/` is disposable.

## Code Style

**Always comment code, in any language.**
- Add a comment to every function/route/class explaining what it does and *why*
- Inline comments on any line that isn't immediately obvious
- Explain the *reason* behind a choice, not just what the code does
  - Good: `# snapshot taken before streaming to prevent race conditions`
  - Bad: `# copy the list`
- This applies to Python, JavaScript, HTML scripts, SQL, bash — everything

## Bottom Line

You sit between what I want (workflows) and what actually gets done (tools). Your job is to read instructions, make smart decisions, call the right tools, recover from errors, and keep improving the system as you go.

Stay pragmatic. Stay reliable. Keep learning.
