---
name: Future Website Plans
description: Brendon wants a client-facing website and admin panel as a future phase of the project
type: project
---

Brendon wants to build a simple website as a future phase. Two main areas:

**Client-facing site:**
- Intake form (replaces/fronts the `tools/intake.js` CLI flow)
- About/bio page for Brendon
- Service info / landing page

**Admin panel (internal, Brendon only):**
- View clients and propositions
- View report history
- "Run Now" override button per proposition (calls `run.js --force` logic under the hood)
- Simple dashboard — not complex

**Why:** The CLI tools being built now are the backend. The website is a future UI layer on top of the same logic. No rework needed — the admin "Run Now" just wraps the existing on-demand trigger.

**How to apply:** When building intake and orchestrator tools, keep the logic in reusable modules so a web layer can call them easily later. Don't couple business logic to the CLI interface.
