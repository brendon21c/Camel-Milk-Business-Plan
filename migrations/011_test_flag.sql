-- Migration 011: Add is_test flag to organizations, clients, and propositions
--
-- Purpose: Allows Brendon to create test records freely during development
-- without polluting real client data. Test records are tagged at the row level
-- so they can be identified in the admin panel and wiped with --purge-test.
--
-- Usage:
--   npx supabase db query --linked < migrations/011_test_flag.sql

-- organizations — tag test orgs created via the intake form in test mode
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- clients — tag test contacts created alongside test orgs
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- propositions — tag test propositions so run logic can skip plan gating
ALTER TABLE propositions
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- Index on is_test for fast purge queries (full table scan otherwise)
CREATE INDEX IF NOT EXISTS idx_organizations_is_test ON organizations (is_test) WHERE is_test = true;
CREATE INDEX IF NOT EXISTS idx_clients_is_test       ON clients       (is_test) WHERE is_test = true;
CREATE INDEX IF NOT EXISTS idx_propositions_is_test  ON propositions  (is_test) WHERE is_test = true;
