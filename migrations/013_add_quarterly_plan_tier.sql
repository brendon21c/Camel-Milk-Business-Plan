-- Migration 013: Add 'quarterly' to plan_tier CHECK constraints
-- Run this in the Supabase SQL Editor before deploying the updated intake form.
--
-- The intake form added a Quarterly plan option ($400/quarter, 1-year commitment,
-- 4 runs per year). The DB CHECK constraints previously only allowed
-- starter | pro | retainer. This migration drops and recreates those constraints
-- to include 'quarterly'.
--
-- Run limit for quarterly: 4 runs (one per quarter for a year). Matches the
-- 1-year commitment framing on the intake form. advancePropositionSchedule in
-- db.js is updated in the same session to handle this tier.

-- ── 1. organizations.plan_tier ────────────────────────────────────────────────

-- Drop the old constraint (name may vary — use the Supabase-generated name)
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_plan_tier_check;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_tier_check
    CHECK (plan_tier IN ('starter', 'pro', 'quarterly', 'retainer'));

-- ── 2. propositions.plan_tier ─────────────────────────────────────────────────

ALTER TABLE propositions
  DROP CONSTRAINT IF EXISTS propositions_plan_tier_check;

ALTER TABLE propositions
  ADD CONSTRAINT propositions_plan_tier_check
    CHECK (plan_tier IN ('starter', 'pro', 'quarterly', 'retainer'));
