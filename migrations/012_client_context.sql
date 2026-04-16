-- Migration 012: Add client_context JSONB column to propositions
--
-- Purpose: Stores structured enrichment data collected from the expanded intake
-- form (Step 2 — Product detail, Step 3 — Market & Customer). Kept as a single
-- JSONB column so new intake fields can be added without further migrations.
--
-- Fields stored in client_context:
--   product_scope       — "single_product" | "product_line" | "modular_system"
--   development_stage   — "concept" | "prototype_in_progress" | "prototype_complete"
--                         | "in_production" | "currently_selling" | "scaling"
--   price_point         — "under_25" | "25_75" | "75_200" | "200_500" | "500_plus"
--   revenue_model       — array: ["one_time", "consumables", "subscription", "accessories"]
--   customer_type       — "b2c" | "b2b" | "both"
--   ideal_customer      — free text: psychographic description of the target buyer
--   sales_channel       — "dtc" | "marketplace" | "retail" | "wholesale" | "b2b_direct"
--   comparable_brands   — free text: who customers currently buy from (anchors competitive research)
--   key_differentiator  — free text: what makes this different from those brands
--
-- Backend reads this at run start and injects it into every agent's prompt as a
-- ## CLIENT CONTEXT block, alongside the venture intelligence and landscape briefings.
--
-- Usage:
--   npx supabase db query --linked < migrations/012_client_context.sql

ALTER TABLE propositions
  ADD COLUMN IF NOT EXISTS client_context JSONB DEFAULT NULL;

-- Index for admin queries that filter or inspect client_context
CREATE INDEX IF NOT EXISTS idx_propositions_client_context
  ON propositions USING gin (client_context)
  WHERE client_context IS NOT NULL;
