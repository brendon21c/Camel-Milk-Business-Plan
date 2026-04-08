-- Migration 004: Add intake fields to clients and propositions
-- Run this in the Supabase SQL Editor before using intake.js
--
-- Adds:
--   clients.phone      — prospect's contact number
--   propositions.plan_tier — which service plan the client selected

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE propositions
  ADD COLUMN IF NOT EXISTS plan_tier TEXT DEFAULT 'starter'
    CHECK (plan_tier IN ('starter', 'pro', 'retainer'));
