-- Migration 007: Organization status + activate camel milk proposition
-- Run this in the Supabase SQL Editor.
--
-- Adds:
--   organizations.status  — lifecycle state of the client relationship
--     prospect  : in discovery, no contract
--     pending   : proposal sent, awaiting signature
--     active    : signed and paying — reports run automatically
--     cancelled : churned (non-payment or ended relationship)
--     inactive  : paused — still a client but reports suspended
--
-- Also activates the B & I camel milk proposition:
--   - Sets schedule_type = 'monthly', schedule_day = 1
--   - Sets next_run_at = May 1 2026 (first automated run)
--   - Sets status = 'active'

-- ── 1. Add status column to organizations ─────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status TEXT
    NOT NULL DEFAULT 'prospect'
    CHECK (status IN ('prospect', 'pending', 'active', 'cancelled', 'inactive'));

-- ── 2. Seed B & I as active ───────────────────────────────────────────────

UPDATE organizations
SET status = 'active'
WHERE name = 'B & I';

-- ── 3. Activate the camel milk proposition ────────────────────────────────
-- Flips status to 'active', sets monthly schedule on the 1st,
-- and sets next_run_at so getDuePropositions() picks it up on May 1.

UPDATE propositions
SET
  status        = 'active',
  schedule_type = 'monthly',
  schedule_day  = 1,
  next_run_at   = '2026-05-01T06:00:00Z',
  last_run_at   = NOW()   -- marks today as the baseline so run_number increments correctly
WHERE id = '54f51272-d819-4d82-825a-15603ed48654';
