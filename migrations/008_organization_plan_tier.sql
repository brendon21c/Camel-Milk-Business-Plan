-- Migration 008: Add plan_tier to organizations
-- Run this in the Supabase SQL Editor.
--
-- Adds:
--   organizations.plan_tier — billing view of what plan the org is on
--     starter  : one-time report, runs once then stops
--     pro      : one report + one monthly refresh (two runs total), then stops
--     retainer : ongoing monthly reports, runs indefinitely
--
-- The proposition's plan_tier stays as the operational source of truth for
-- run logic. organizations.plan_tier is the billing/admin view — they are
-- set together at activation and should always match.
--
-- Seed:
--   - Sets B & I to 'starter' (test client, don't waste API credits)
--   - Updates the camel milk proposition plan_tier to match

-- ── 1. Add plan_tier to organizations ─────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_tier TEXT
    CHECK (plan_tier IN ('starter', 'pro', 'retainer'));

-- ── 2. Seed B & I as starter ──────────────────────────────────────────────

UPDATE organizations
SET plan_tier = 'starter'
WHERE name = 'B & I';

-- ── 3. Align the camel milk proposition to starter ────────────────────────
-- Keeps organizations.plan_tier and propositions.plan_tier in sync.

UPDATE propositions
SET plan_tier = 'starter'
WHERE id = '54f51272-d819-4d82-825a-15603ed48654';
