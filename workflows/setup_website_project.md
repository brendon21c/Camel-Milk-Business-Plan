# Workflow: Setup Website Project

## Objective
Create a separate project for the client-facing website, intake form, and admin console — connected to the same Supabase database used by this project.

## Status
**Not started.** This workflow is a reference for when we're ready to build.

---

## Overview

The website project is a separate codebase with its own runtime and deployment. It connects to the shared Supabase database to read/write data, while this project (Camel Milk Business Plan / WAT framework) handles backend analysis and writes results to the same database.

**Architecture:**
```
[This Project - WAT Framework]
        ↓ writes analysis results
   [Supabase DB] ←→ [Website Project]
                          ↓
                 - Client intake form
                 - Admin console
                 - Run Now button (trigger agents)
```

---

## Step 1: Decide the Tech Stack

Choose before starting. Recommended options:

| Option | Best for |
|---|---|
| **Next.js** (React + API routes) | Full-stack JS, easy Supabase integration, good admin UIs |
| **SvelteKit** | Lighter weight, fast, also has good Supabase support |
| **Flask/FastAPI + plain HTML** | If you want Python backend consistent with this project |

**Recommendation:** Next.js + Supabase JS client. It's the most common pairing and has the best docs/examples.

---

## Step 2: Create the New Project Folder

Create it as a sibling directory, not inside this project:

```
Claude Projects/
├── Camel-Milk-Business-Plan/   ← this project
└── camel-milk-website/         ← new project
```

Initialize it:
```bash
# For Next.js
cd "Claude Projects"
npx create-next-app@latest camel-milk-website
cd camel-milk-website
git init
```

---

## Step 3: Install Supabase Client

```bash
npm install @supabase/supabase-js
```

---

## Step 4: Set Up Shared Supabase Credentials

Get your credentials from the Supabase dashboard:
- Go to your project → Settings → API
- Copy: **Project URL** and **anon public key**

Create a `.env.local` file in the website project:
```
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key  # server-side only, keep secret
```

> The `anon` key is safe to use client-side. The `service_role` key bypasses row-level security — only use it server-side (API routes, server components).

---

## Step 5: Create a Supabase Client Utility

In the website project, create `lib/supabase.js`:
```js
import { createClient } from '@supabase/supabase-js'

// Client for browser/client-side use (uses anon key)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)
```

And a server-side client for API routes:
```js
// lib/supabase-server.js — never import this client-side
import { createClient } from '@supabase/supabase-js'

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
```

---

## Step 6: Connect This Project to Supabase (Python Side)

In this WAT project, ensure the `.env` has Supabase credentials:
```
SUPABASE_URL=your_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Install the Python client if not already installed:
```bash
pip install supabase
```

Create `tools/supabase_client.py` as the shared connection utility for all tools in this project.

---

## Step 7: Design the Shared Database Schema

Before building either project's UI, decide what tables the database needs. Suggested starting tables:

| Table | Purpose |
|---|---|
| `submissions` | Client intake form responses |
| `analyses` | Business analysis results from the WAT framework |
| `reports` | Generated PDF/document links and metadata |
| `users` | Admin users for the console |

Create these in the Supabase dashboard under Table Editor, or via SQL in the SQL Editor.

---

## Step 8: Connect the Projects

**From the website → read analysis results:**
```js
// Example: fetch analyses from Supabase in a Next.js page
const { data, error } = await supabase
  .from('analyses')
  .select('*')
  .order('created_at', { ascending: false })
```

**From the WAT project → write results:**
```python
# Example: save analysis result from a Python tool
from supabase import create_client
import os

client = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
client.table("analyses").insert({"business_name": "...", "result": "..."}).execute()
```

**Admin console "Run Now" button → trigger a WAT agent:**
Two options:
1. **Supabase Edge Function** — serverless function that runs a script when called
2. **Webhook endpoint** — the website calls a small API server running locally or hosted that triggers the Python agent

For now, option 2 (a simple FastAPI server wrapping the WAT tools) is the most straightforward path.

---

## Step 9: Set Up Row Level Security (RLS)

In Supabase, enable RLS on all tables so that:
- Public users can only insert (submit a form), not read other submissions
- Admin users (authenticated) can read everything
- The service role key (used by backend scripts) bypasses RLS entirely

Do this in Supabase dashboard → Table → RLS → Add Policy.

---

## Inputs Required Before Starting
- [ ] Confirmed tech stack choice (Next.js recommended)
- [ ] Supabase project URL and API keys (already in `.env`)
- [ ] Database schema agreed on (what tables, what fields)
- [ ] Decision on how admin "Run Now" triggers agents (Edge Function vs. local API server)

## Expected Output
- New `camel-milk-website/` project initialized and connected to Supabase
- Both projects reading/writing to the same database
- Admin console able to view submissions and trigger analyses
