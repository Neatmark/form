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
  status                          text        NOT NULL    DEFAULT 'pending',
  project_status                  text,
  agreed_delivery_date            text,

  -- Client meta
  client_name                     text,
  brand_name                      text,
  email                           text,
  client_website                  text,
  delivery_date                   text,

  -- Section 01: Brand Foundation
  "business-description"          text,
  "problem-transformation"        text,
  "ideal-customer"                text,
  "customer-desire"               text,
  competitors                      text,
  "brand-personality"             text,
  positioning                      text,
  "launch-context"                text,

  -- Section 02: Visual Direction
  "brands-admired"                text,
  color_direction                   text[],   -- multi-select
  color_choice                      text,
  "colors-to-avoid"               text,
  aesthetic                        text[],   -- multi-select (ranked by selection order)
  "aesthetic-description"         text,
  deliverables                     text[],   -- multi-select
  budget                           text,

  -- Inspiration refs: each entry is a JSON string:
  --   '{"smallRef":"small/...","originalRef":"originals/..."}'
  -- Legacy entries may be plain storage-path strings.
  "inspiration-refs"              text[],

  -- Section 03: Project and Scope
  "decision-maker"                text,
  "decision-maker-other"          text,
  "existing-assets"               text,
  "anything-else"                 text,

  -- Brand / company logo (stored in the 'logos' bucket)
  brand_logo_ref                   text,

  -- Secure edit token (UUID) — single use, expires after 30 days
  -- Generated on new submission, cleared after client edits
  edit_token                      text        UNIQUE,
  edit_token_expires_at           timestamptz,

  -- Auto-detected from Netlify geo header (x-country) — not user-submitted
  client_country                   text
);


-- ── 2. Migrations — add any columns that might be missing ─────────────
--  Safe no-ops if columns already exist.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS client_website                 text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "customer-desire"             text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "launch-context"              text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS history                        jsonb        NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS status                         text         NOT NULL DEFAULT 'pending';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS project_status                 text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS agreed_delivery_date           text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS client_name                    text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS brand_name                     text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS email                          text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS delivery_date                  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS brand_logo_ref                 text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "business-description"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "problem-transformation"      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "ideal-customer"              text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS competitors                    text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "brand-personality"           text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS positioning                    text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "brands-admired"              text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS color_direction               text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS color_choice                  text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "colors-to-avoid"             text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS aesthetic                      text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "aesthetic-description"       text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "existing-assets"             text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS deliverables                   text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS budget                         text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "inspiration-refs"            text[];
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "decision-maker"              text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "decision-maker-other"        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "anything-else"               text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS edit_token                   text UNIQUE;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS edit_token_expires_at        timestamptz;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS client_country                text;


-- ── 3. Indexes (optional but recommended for dashboard queries) ────────
CREATE INDEX IF NOT EXISTS idx_submissions_created_at
  ON submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_email
  ON submissions (lower(email));

CREATE INDEX IF NOT EXISTS idx_submissions_brand_name
  ON submissions (lower(brand_name));

CREATE INDEX IF NOT EXISTS idx_submissions_status
  ON submissions (status);

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
