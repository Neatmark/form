-- ======================================================================
--  NEATMARK — Complete Supabase Setup
--  Run this entire file in: Supabase Dashboard → SQL Editor → Run
--
--  Safe to run more than once:
--    - CREATE TABLE IF NOT EXISTS
--    - ADD COLUMN IF NOT EXISTS
--    - ON CONFLICT … DO UPDATE on buckets
--    - DROP POLICY IF EXISTS before every CREATE POLICY
-- ======================================================================


-- ── 0. Extension ───────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ── 1. Core submissions table ──────────────────────────────────────────
--  All form fields use quoted, hyphenated names to match the JS payload.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  -- System columns
  id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                      timestamptz NOT NULL    DEFAULT now(),
  history                         jsonb       NOT NULL    DEFAULT '[]'::jsonb,
  "status"                        text        NOT NULL    DEFAULT 'pending',
  "project-status"                text,
  "agreed-delivery-date"          text,

  -- Client meta
  "client-name"                   text,
  "brand-name"                    text,
  "email"                         text,
  "delivery-date"                 text,

  -- Section 01 – Brand Foundation (Q1–Q7)
  "q1-business-description"       text,
  "q2-problem-transformation"     text,
  "q3-ideal-customer"             text,
  "q4-competitors"                text,
  "q5-brand-personality"          text,
  "q6-positioning"                text,
  "q7-decision-maker"             text,
  "q7-decision-maker-other"       text,

  -- Section 02 – Visual Direction (Q8–Q16)
  "q8-brands-admired"             text,
  "q9-color"                      text[],   -- multi-select
  "q10-colors-to-avoid"           text,
  "q11-aesthetic"                 text[],   -- multi-select
  "q11-aesthetic-description"     text,
  "q12-existing-assets"           text,
  "q13-deliverables"              text[],   -- multi-select
  "q14-budget"                    text,

  -- Q15: each entry is a JSON string:
  --   '{"smallRef":"small/...","originalRef":"originals/..."}'
  -- Legacy entries may be plain storage-path strings.
  "q15-inspiration-refs"          text[],

  "q16-anything-else"             text,

  -- Brand / company logo (stored in the 'logos' bucket)
  "brand-logo-ref"                text,

  -- Secure edit token (UUID) — single use, expires after 30 days
  -- Generated on new submission, cleared after client edits
  edit_token                      text        UNIQUE,
  edit_token_expires_at           timestamptz
);


-- ── 2. Migrations — add any columns that might be missing ─────────────
--  Safe no-ops if columns already exist.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS history                        jsonb        NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "status"                       text         NOT NULL DEFAULT 'pending';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "project-status"               text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "agreed-delivery-date"         text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "client-name"                  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "brand-name"                   text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "email"                        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "delivery-date"                text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "brand-logo-ref"               text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q1-business-description"      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q2-problem-transformation"    text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q3-ideal-customer"            text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q4-competitors"               text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q5-brand-personality"         text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q6-positioning"               text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q7-decision-maker"            text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q7-decision-maker-other"      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q8-brands-admired"            text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q9-color"                     text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q10-colors-to-avoid"          text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q11-aesthetic"                text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q11-aesthetic-description"    text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q12-existing-assets"          text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q13-deliverables"             text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q14-budget"                   text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q15-inspiration-refs"         text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "q16-anything-else"            text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS edit_token                   text UNIQUE;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS edit_token_expires_at        timestamptz;


-- ── 3. Indexes (optional but recommended for dashboard queries) ────────
CREATE INDEX IF NOT EXISTS idx_submissions_created_at
  ON submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_email
  ON submissions (lower("email"));

CREATE INDEX IF NOT EXISTS idx_submissions_brand_name
  ON submissions (lower("brand-name"));

CREATE INDEX IF NOT EXISTS idx_submissions_status
  ON submissions ("status");

CREATE INDEX IF NOT EXISTS idx_submissions_edit_token
  ON submissions (edit_token)
  WHERE edit_token IS NOT NULL;


-- ── 4. Row Level Security ──────────────────────────────────────────────
--  Enable RLS — the service role key used by Netlify functions bypasses
--  RLS entirely, so all DB operations go through server-side code only.
--  Direct client (anon / browser) access is blocked.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Drop any old, conflicting policies first
DROP POLICY IF EXISTS "Allow anon insert"    ON submissions;
DROP POLICY IF EXISTS "Allow anon select"    ON submissions;
DROP POLICY IF EXISTS "Admin full access"    ON submissions;
DROP POLICY IF EXISTS "No direct access"     ON submissions;
DROP POLICY IF EXISTS "Service role only"    ON submissions;

-- Single lock-down policy: only the service role may touch this table
CREATE POLICY "Service role only"
  ON submissions
  FOR ALL
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');


-- ── 5. Storage Buckets ────────────────────────────────────────────────
--  Three private buckets.
--  TIP: You can also create these manually in Storage → New bucket
--  if you prefer the dashboard UI (just make sure Public is OFF).
-- ──────────────────────────────────────────────────────────────────────

-- Brand / company logos (PNG, JPG, SVG, WEBP — max 2 MB)
INSERT INTO storage.buckets (id, name, public)
VALUES ('logos', 'logos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Full-resolution inspiration images uploaded by clients (max 10 MB each)
INSERT INTO storage.buckets (id, name, public)
VALUES ('original-photos', 'original-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Resized copies (max 1 200 px, 80 % JPEG) used for dashboard previews
-- and inline email thumbnails — generated server-side by upload-photo.js
INSERT INTO storage.buckets (id, name, public)
VALUES ('small-photos', 'small-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;


-- ── 6. Storage Policies ───────────────────────────────────────────────
--  All bucket access goes through Netlify serverless functions that use
--  the service role key.  Browsers / email clients never touch the
--  buckets directly.
-- ──────────────────────────────────────────────────────────────────────

-- Drop any old/permissive policies that might exist
DROP POLICY IF EXISTS "Public logos read"              ON storage.objects;
DROP POLICY IF EXISTS "Public logos upload"            ON storage.objects;
DROP POLICY IF EXISTS "Authenticated logos read"       ON storage.objects;
DROP POLICY IF EXISTS "Authenticated logos upload"     ON storage.objects;
DROP POLICY IF EXISTS "Service role logos access"      ON storage.objects;
DROP POLICY IF EXISTS "Service role original-photos access" ON storage.objects;
DROP POLICY IF EXISTS "Service role small-photos access"    ON storage.objects;

-- logos — service role only
CREATE POLICY "Service role logos access"
  ON storage.objects
  FOR ALL
  USING      (bucket_id = 'logos'           AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'logos'           AND auth.role() = 'service_role');

-- original-photos — service role only
CREATE POLICY "Service role original-photos access"
  ON storage.objects
  FOR ALL
  USING      (bucket_id = 'original-photos' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'original-photos' AND auth.role() = 'service_role');

-- small-photos — service role only
CREATE POLICY "Service role small-photos access"
  ON storage.objects
  FOR ALL
  USING      (bucket_id = 'small-photos'    AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'small-photos'    AND auth.role() = 'service_role');


-- ======================================================================
--  DONE ✓
--
--  After running this script, verify in the dashboard:
--
--  1. Database → Tables → submissions
--     • All columns present (id, created_at, history, status, q1–q16…)
--     • Shield icon shows RLS is ON
--     • One policy: "Service role only"
--
--  2. Storage → Buckets
--     • logos          (private)
--     • original-photos (private)
--     • small-photos   (private)
--
--  3. Storage → Policies
--     • Service role logos access
--     • Service role original-photos access
--     • Service role small-photos access
--
--  4. Netlify Environment Variables (Site → Environment Variables):
--
--     SUPABASE_URL          https://xxxx.supabase.co
--     SUPABASE_SERVICE_KEY  <service role key — NOT the anon key>
--     RESEND_API_KEY        <your Resend.com API key>
--     RESEND_FROM_EMAIL     noreply@yourdomain.com
--     RECIPIENT_EMAIL       you@yourdomain.com
--     ALLOWED_ORIGIN        https://your-site.netlify.app   (your production URL)
--     SITE_URL              https://your-site.netlify.app   (base URL for edit links)
--     TURNSTILE_SECRET_KEY  <your Cloudflare Turnstile secret key>
--
-- ======================================================================
