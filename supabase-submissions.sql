-- =====================================================================
-- Neatmark – Full Supabase Schema  (run in the SQL Editor)
-- Safe to run multiple times: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Core submissions table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL    DEFAULT now(),
  history      jsonb       NOT NULL    DEFAULT '[]'::jsonb,
  "status"     text        NOT NULL    DEFAULT 'pending',
  "project-status"           text,
  "client-name"              text,
  "brand-name"               text,
  "email"                    text,
  "delivery-date"            text,
  "agreed-delivery-date"     text,
  -- Section 01 – Brand Foundation
  "q1-business-description"   text,
  "q2-problem-transformation" text,
  "q3-ideal-customer"         text,
  "q4-competitors"            text,
  "q5-brand-personality"      text,
  "q6-positioning"            text,
  "q7-decision-maker"         text,
  "q7-decision-maker-other"   text,
  -- Section 02 – Visual Direction
  "q8-brands-admired"         text,
  "q9-color"                  text[],
  "q10-colors-to-avoid"       text,
  "q11-aesthetic"             text[],
  "q11-aesthetic-description" text,
  "q12-existing-assets"       text,
  "q13-deliverables"          text[],
  "q14-budget"                text,
  -- q15 stores JSON strings: '{"smallRef":"small/…","originalRef":"originals/…"}'
  "q15-inspiration-refs"      text[],
  "q16-anything-else"         text,
  "brand-logo-ref"            text
);

-- ── Migration block (safe to re-run) ───────────────────────────────
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS history                    jsonb        NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "status"                   text         NOT NULL DEFAULT 'pending';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "project-status"           text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "agreed-delivery-date"     text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "brand-logo-ref"           text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q1-business-description"  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q2-problem-transformation" text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q3-ideal-customer"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q4-competitors"           text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q5-brand-personality"     text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q6-positioning"           text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q7-decision-maker"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q7-decision-maker-other"  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q8-brands-admired"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q9-color"                 text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q10-colors-to-avoid"      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q11-aesthetic"            text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q11-aesthetic-description" text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q12-existing-assets"      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q13-deliverables"         text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q14-budget"               text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q15-inspiration-refs"     text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q16-anything-else"        text;

-- ── Row Level Security ─────────────────────────────────────────────
-- Enable RLS (idempotent — safe to run again)
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- ── STORAGE BUCKETS ────────────────────────────────────────────────
-- Run these in the SQL Editor OR create buckets in the Supabase dashboard.
-- NOTE: public = false means private buckets (requires signed URLs or service key to access).

INSERT INTO storage.buckets (id, name, public)
VALUES ('logos',           'logos',           false)
ON CONFLICT (id) DO UPDATE SET public = false;

INSERT INTO storage.buckets (id, name, public)
VALUES ('original-photos', 'original-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

INSERT INTO storage.buckets (id, name, public)
VALUES ('small-photos',    'small-photos',    false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- ── STORAGE POLICIES ───────────────────────────────────────────────
-- Only the service role (your Netlify functions) can read/write any bucket.
-- Unauthenticated / anon users have NO access.
-- 
-- These policies are for the `storage.objects` table.
-- Replace / drop old permissive policies first if they exist.

-- Drop old permissive policies if present (safe no-op if they don't exist)
DROP POLICY IF EXISTS "Public logos read"         ON storage.objects;
DROP POLICY IF EXISTS "Public logos upload"       ON storage.objects;
DROP POLICY IF EXISTS "Authenticated logos read"  ON storage.objects;
DROP POLICY IF EXISTS "Authenticated logos upload" ON storage.objects;

-- logos bucket: service role only (Netlify functions use service key → bypasses RLS)
CREATE POLICY "Service role logos access"
  ON storage.objects FOR ALL
  USING      (bucket_id = 'logos'           AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'logos'           AND auth.role() = 'service_role');

-- original-photos: service role only
CREATE POLICY "Service role original-photos access"
  ON storage.objects FOR ALL
  USING      (bucket_id = 'original-photos' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'original-photos' AND auth.role() = 'service_role');

-- small-photos: service role only
CREATE POLICY "Service role small-photos access"
  ON storage.objects FOR ALL
  USING      (bucket_id = 'small-photos'    AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'small-photos'    AND auth.role() = 'service_role');

-- ── RLS POLICIES ON submissions ────────────────────────────────────
-- Since this form does NOT use Supabase Auth for submitters (public form),
-- all DB operations are done server-side via the service role key.
-- The service role bypasses RLS, so these policies protect against
-- direct DB access by any unauthenticated actor:

-- Deny all direct access from anon / authenticated roles
-- (Service role bypasses these — only your Netlify functions touch the DB)
DROP POLICY IF EXISTS "Allow anon insert"  ON submissions;
DROP POLICY IF EXISTS "Allow anon select"  ON submissions;
DROP POLICY IF EXISTS "Admin full access"  ON submissions;
DROP POLICY IF EXISTS "No direct access"   ON submissions;

-- Single lockdown policy: nobody except service_role can touch submissions
CREATE POLICY "Service role only"
  ON submissions FOR ALL
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

