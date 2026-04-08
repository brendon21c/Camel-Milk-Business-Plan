-- Migration 005: Add run tracking columns to reports
-- Run this in the Supabase SQL Editor before using run.js
--
-- Adds:
--   reports.run_number         — 1-indexed count of runs for this proposition (1 = first)
--   reports.previous_report_id — FK to the most recent completed report before this one
--                                Used by the assembler to build the "What Changed" section.
--                                NULL on the first run.

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS run_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS previous_report_id UUID REFERENCES reports(id);
