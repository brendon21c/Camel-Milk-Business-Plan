-- Migration 006: Organizations table + multi-contact support
-- Run this in the Supabase SQL Editor.
--
-- Adds:
--   organizations              — companies/entities that own one or more client contacts
--   organization_admins        — who can administer each org (many-to-many, independent of clients)
--   clients.organization_id    — FK linking a contact to their organization
--   propositions.organization_id — FK linking a proposition to its owning org
--   proposition_recipients     — which contacts receive the report for each proposition
--
-- Seed data (run once):
--   - Creates McKeever Consulting org + seeds Brendon as its admin
--   - Creates B & I org (the camel milk client company)
--   - Links existing client Brendon McKeever to B & I, updates his company_name to match
--   - Inserts/updates Iman Warsame under B & I with matching company_name
--   - Seeds both Brendon and Iman as recipients for the camel milk report
--   - Updates the camel milk proposition budget from 50,000 → 100,000

-- ── 1. Create organizations table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Organization admins junction table ──────────────────────────────────
-- Admins are stored independently of the clients table.
-- Removing someone as a client never affects their admin status, and vice versa.

CREATE TABLE IF NOT EXISTS organization_admins (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (organization_id, email)
);

-- ── 3. Add columns to clients ──────────────────────────────────────────────
-- Drop redundant `company` column if it was added by a partial run, then add organization_id.

ALTER TABLE clients
  DROP COLUMN IF EXISTS company;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- ── 4. Seed orgs, admins, and contacts ────────────────────────────────────

DO $$
DECLARE
  mck_org_id UUID;
  bni_org_id UUID;
BEGIN
  -- Get or create McKeever Consulting org
  SELECT id INTO mck_org_id FROM organizations WHERE name = 'McKeever Consulting' LIMIT 1;
  IF mck_org_id IS NULL THEN
    INSERT INTO organizations (name) VALUES ('McKeever Consulting') RETURNING id INTO mck_org_id;
  END IF;

  -- Seed Brendon as admin of McKeever Consulting.
  -- ON CONFLICT DO NOTHING makes this safe to re-run.
  INSERT INTO organization_admins (organization_id, email, name)
  VALUES (mck_org_id, 'brennon.mckeever@gmail.com', 'Brendon McKeever')
  ON CONFLICT DO NOTHING;

  -- Get or create B & I org (the camel milk client company)
  SELECT id INTO bni_org_id FROM organizations WHERE name = 'B & I' LIMIT 1;
  IF bni_org_id IS NULL THEN
    INSERT INTO organizations (name) VALUES ('B & I') RETURNING id INTO bni_org_id;
  END IF;

  -- Link Brendon McKeever to B & I and align his company_name field
  UPDATE clients
  SET organization_id = bni_org_id,
      company_name    = 'B & I'
  WHERE id = 'ea134c2d-547e-4fcb-b475-65383680c8fb';

  -- Update Iman Warsame's record (she already exists from a partial run)
  UPDATE clients
  SET company_name    = 'B & I',
      organization_id = bni_org_id,
      phone           = '6124236820',
      status          = 'active'
  WHERE email = 'imanw22@gmail.com';

  -- If for any reason she doesn't exist yet, insert her
  IF NOT FOUND THEN
    INSERT INTO clients (name, email, phone, company_name, status, organization_id)
    VALUES ('Iman Warsame', 'imanw22@gmail.com', '6124236820', 'B & I', 'active', bni_org_id);
  END IF;
END $$;

-- ── 5. Add organization_id to propositions ────────────────────────────────
-- Propositions belong to an organization (the company commissioning the work).
-- client_id is kept as "primary contact" — the individual used for report content.

ALTER TABLE propositions
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- Populate organization_id for all existing propositions from their contact's org
UPDATE propositions p
SET organization_id = c.organization_id
FROM clients c
WHERE p.client_id = c.id
  AND c.organization_id IS NOT NULL;

-- ── 6. Proposition recipients junction table ───────────────────────────────
-- Tracks which contacts receive the report for a given proposition.
-- Allows per-proposition recipient lists — different propositions can notify
-- different subsets of an organization's contacts.

CREATE TABLE IF NOT EXISTS proposition_recipients (
  proposition_id UUID NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  client_id      UUID NOT NULL REFERENCES clients(id)      ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (proposition_id, client_id)
);

-- Seed: both Brendon and Iman receive the camel milk report
INSERT INTO proposition_recipients (proposition_id, client_id)
SELECT '54f51272-d819-4d82-825a-15603ed48654', c.id
FROM clients c
WHERE c.email IN ('brennon.mckeever@gmail.com', 'imanw22@gmail.com')
ON CONFLICT DO NOTHING;

-- ── 7. Update camel milk proposition budget ────────────────────────────────

UPDATE propositions
SET estimated_budget = 100000
WHERE id = '54f51272-d819-4d82-825a-15603ed48654';
