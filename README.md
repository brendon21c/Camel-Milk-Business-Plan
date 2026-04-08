# McKeever Consulting — Business Viability Intelligence System

## What This Is

An automated business intelligence platform that researches any business idea and delivers a comprehensive viability report as a branded PDF — on demand or on a monthly schedule.

Built for McKeever Consulting to serve clients who want a serious, data-driven answer to the question:

> *Is this business idea viable — and how does that picture change over time?*

---

## How It Works

```
Client submits intake form
        ↓
Proposal PDF generated + emailed to client and Brendon
        ↓
Client signs and pays
        ↓
activate.js flips proposition to active
        ↓
Research agents run (Brave Search + Claude)
        ↓
Assembler produces branded PDF report
        ↓
Report emailed to client
```

---

## Service Tiers

| Plan | Price | What's Included |
|---|---|---|
| Starter | $100 | One-time viability report |
| Pro | $250 | One-time report + 1 monthly refresh |
| Retainer | $150/month | Ongoing monthly reports |

---

## Project Structure

```
tools/          ← Python + Node.js scripts (execution)
workflows/      ← Plain-language SOPs for each research area
migrations/     ← Supabase SQL migrations (run in order)
assets/fonts/   ← Montserrat TTFs (auto-downloaded on first run)
outputs/        ← Generated PDFs (6-month history)
.tmp/           ← Disposable intermediates (cleared between runs)
db.js           ← All Supabase queries
supabaseClient.js ← Supabase client initialisation
.env            ← API keys and credentials (never committed)
HANDOFF.md      ← Full project state, decisions, and build progress
```

---

## Key Commands

```bash
# Register a new prospect
node tools/intake.js --name "Jane Smith" --email "jane@example.com" --phone "+1 555 123 4567" \
  --description "..." --type "physical_import_export" --origin "Kenya" --market "United States" \
  --plan "starter"

# Generate and send the proposal PDF
node tools/generate_proposal.js --proposition-id <uuid>

# Activate a proposition after client signs and pays
node tools/activate.js --proposition-id <uuid>

# Run a report on demand (once run.js is built)
node run.js --proposition-id <uuid> --force

# Preview brand styles
python tools/preview_brand.py
```

---

## Brand

**McKeever Consulting** — Navy `#1C3557` · Gold `#C8A94A` · Silver `#8A9BB0` · Montserrat

---

## Full Documentation

See `HANDOFF.md` for the complete project state, all locked decisions, DB schema, and build progress.
