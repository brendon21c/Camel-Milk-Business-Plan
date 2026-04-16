-- Migration 014: Change clients.email unique constraint to (email, organization_id)
-- Run this in the Supabase SQL Editor.
--
-- Previously, email was globally unique across all clients. This prevented the
-- same person from being a contact at multiple organizations — which breaks the
-- intake form when a known email submits a new proposition under a new company.
--
-- The fix: drop the single-column unique index and replace it with a composite
-- unique constraint on (email, organization_id). The same person can now be a
-- contact at multiple orgs without conflict.
--
-- The intake form's "find or create" logic is also removed in actions.ts — intake
-- always creates a new org, so it should always create a fresh contact for that org.

-- Drop the old single-column unique constraint.
-- Supabase typically names this "clients_email_key" from a UNIQUE column definition.
ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_email_key;

-- Add composite unique: same email can appear once per org, but not twice in the same org.
ALTER TABLE clients
  ADD CONSTRAINT clients_email_org_unique UNIQUE (email, organization_id);
