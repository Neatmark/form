-- =====================================================================
-- Neatmark – Supabase Schema (Current Form Version)
-- Run this entire file in your Supabase SQL editor.
-- Safe to run multiple times: uses IF NOT EXISTS everywhere.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Core table (created only if it doesn't exist)
CREATE TABLE IF NOT EXISTS submissions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL    DEFAULT now(),
  history      jsonb       NOT NULL    DEFAULT '[]'::jsonb,
  "status"     text        NOT NULL    DEFAULT 'pending',
  "project-status"          text,
  "client-name"             text,
  "brand-name"              text,
  "email"                   text,
  "delivery-date"           text,
  "agreed-delivery-date"    text,
  -- Section 01 – Brand Foundation
  "q1-business-description"  text,
  "q2-problem-transformation" text,
  "q3-ideal-customer"        text,
  "q4-competitors"           text,
  "q5-brand-personality"     text,
  "q6-positioning"           text,
  "q7-decision-maker"        text,
  "q7-decision-maker-other"  text,
  -- Section 02 – Visual Direction
  "q8-brands-admired"        text,
  "q9-color"                 text[],
  "q10-colors-to-avoid"      text,
  "q11-aesthetic"            text[],
  "q11-aesthetic-description" text,
  "q12-existing-assets"      text,
  "q13-deliverables"         text[],
  "q14-budget"               text,
  "q15-inspiration-refs"     text[],
  "q16-anything-else"        text,
  "brand-logo-ref"           text
);

-- ── Migration block: add new columns to existing tables ─────────────
-- Each ALTER TABLE is safe to run repeatedly because of IF NOT EXISTS.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS history           jsonb        NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "status"          text         NOT NULL DEFAULT 'pending';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "project-status"  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "agreed-delivery-date" text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "brand-logo-ref"  text;

-- Section 01
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q1-business-description"   text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q2-problem-transformation" text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q3-ideal-customer"         text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q4-competitors"            text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q5-brand-personality"      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q6-positioning"            text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q7-decision-maker"         text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q7-decision-maker-other"   text;

-- Section 02
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q8-brands-admired"          text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q9-color"                   text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q10-colors-to-avoid"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q11-aesthetic"              text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q11-aesthetic-description"  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q12-existing-assets"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q13-deliverables"           text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q14-budget"                 text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q15-inspiration-refs"       text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q16-anything-else"          text;
