-- Migration 010 — Intake form new fields + proposition context table
-- Run against: shared Supabase project (vupnhlpwfqwmrysohhrq)
-- Depends on: 009_industry_category (propositions.industry_category must already exist)
--
-- Adds:
--   clients.phone                  — required on intake form, stored per client
--   propositions.sourcing_notes    — optional supplier/pricing info from intake form
--   propositions.additional_info   — optional free-text "anything else" from intake form
--   proposition_context            — admin-only enrichment table; read by backend research engine


-- ─── 1. clients.phone ──────────────────────────────────────────────────────────
-- Stores the client's phone number as collected on the intake form.
-- VARCHAR(50) covers all international formats including country codes and extensions.
-- NOT NULL with default '' so existing rows don't break — backfill manually if needed.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NOT NULL DEFAULT '';


-- ─── 2. propositions.sourcing_notes ────────────────────────────────────────────
-- Free-text sourcing information provided by the client at intake time.
-- Examples: supplier name, country of origin, price per unit, lead time, MOQ.
-- Nullable — this field is optional on the intake form.
ALTER TABLE propositions
  ADD COLUMN IF NOT EXISTS sourcing_notes TEXT;


-- ─── 3. propositions.additional_info ───────────────────────────────────────────
-- Free-text catch-all field for anything the client wants us to know
-- that doesn't fit the structured fields. Nullable — optional on intake form.
ALTER TABLE propositions
  ADD COLUMN IF NOT EXISTS additional_info TEXT;


-- ─── 4. proposition_context ────────────────────────────────────────────────────
-- Admin-added enrichment data per proposition. Written by Brendon in the admin panel.
-- The backend research engine queries this table by proposition_id when building
-- research prompts, so any context added here automatically informs the next report run.
--
-- category values (enforced by CHECK constraint):
--   sourcing     — supplier details, pricing, lead times, MOQ
--   market       — market size, trends, customer segments, distribution channels
--   regulatory   — import rules, certifications, labeling, compliance notes
--   financial    — target margins, cost structure, funding, runway
--   competitor   — known competitors, positioning, pricing landscape
--   other        — anything that doesn't fit the above categories
CREATE TABLE IF NOT EXISTS proposition_context (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  proposition_id  UUID        NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  category        TEXT        NOT NULL CHECK (category IN (
                                'sourcing',
                                'market',
                                'regulatory',
                                'financial',
                                'competitor',
                                'other'
                              )),
  content         TEXT        NOT NULL,
  -- Track who added the context (Supabase auth user).
  -- Nullable in case rows are inserted programmatically without an auth session.
  added_by        UUID        REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the most common query pattern: fetch all context for a given proposition
CREATE INDEX IF NOT EXISTS idx_proposition_context_proposition_id
  ON proposition_context (proposition_id);

-- Auto-update updated_at on row edits (requires the moddatetime extension,
-- which is available in Supabase by default)
CREATE OR REPLACE TRIGGER proposition_context_updated_at
  BEFORE UPDATE ON proposition_context
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);


-- ─── RLS policies ──────────────────────────────────────────────────────────────
-- proposition_context is admin-only. Only service-role reads/writes from the
-- backend engine and the admin panel. Public anon key gets no access.

ALTER TABLE proposition_context ENABLE ROW LEVEL SECURITY;

-- Deny all access to the anon and authenticated roles by default.
-- The backend engine and admin panel use the service key, which bypasses RLS entirely.
-- If you later want authenticated admin users to read/write via the anon key,
-- add explicit policies here.
CREATE POLICY "No public access to proposition_context"
  ON proposition_context
  FOR ALL
  TO anon, authenticated
  USING (false);
