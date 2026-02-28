-- ======================================================================
--  NEATMARK — Rate Limiting Migration
--  Run this in: Supabase Dashboard → SQL Editor → Run
--
--  Safe to run more than once (all statements are idempotent).
--
--  This replaces the previous per-Lambda-instance in-memory rate limiters
--  with a single authoritative Supabase table.  All Netlify Function
--  instances share the same counters, so burst limits cannot be bypassed
--  by spreading requests across parallel containers.
-- ======================================================================


-- ── 1. Table ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  ip           TEXT    NOT NULL,
  endpoint     TEXT    NOT NULL,
  window_start BIGINT  NOT NULL,   -- Unix timestamp (ms) of window start
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip, endpoint, window_start)
);

COMMENT ON TABLE rate_limits IS
  'Cross-instance rate limiting counters. Rows are short-lived and pruned automatically.';

COMMENT ON COLUMN rate_limits.window_start IS
  'Floor(Date.now() / windowMs) * windowMs — all requests in the same window share one row.';


-- ── 2. Index (for efficient cleanup of old windows) ────────────────────────
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON rate_limits (window_start);


-- ── 3. Row Level Security ──────────────────────────────────────────────────
--  All access goes through the service role key used by Netlify functions.
--  No direct browser/anon access is ever needed.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON rate_limits;
CREATE POLICY "Service role only"
  ON rate_limits
  FOR ALL
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');


-- ── 4. Atomic check-and-increment function ────────────────────────────────
--
--  Called by every Netlify function via supabase.rpc('rate_limit_check', …).
--  The INSERT … ON CONFLICT … DO UPDATE is atomic at the row level in
--  PostgreSQL, so concurrent Lambda invocations cannot race past the limit.
--
--  Returns: TRUE  → caller is rate limited (count exceeds p_max_requests)
--           FALSE → caller is allowed
--
--  Cleanup: With 1 % probability, old rows (older than 2× the window)
--  are deleted from the table.  This keeps the table small without needing
--  a separate cron job.  At typical traffic volumes the table stays under
--  a few thousand rows at all times.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rate_limit_check(
  p_ip           TEXT,
  p_endpoint     TEXT,
  p_window_start BIGINT,
  p_max_requests INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER   -- runs as the table owner, bypasses per-user RLS checks
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Atomic upsert: insert the first request in this window, or increment
  INSERT INTO rate_limits (ip, endpoint, window_start, count)
  VALUES (p_ip, p_endpoint, p_window_start, 1)
  ON CONFLICT (ip, endpoint, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING count INTO v_count;

  -- Probabilistic cleanup (~1 % of calls) — keeps the table tidy without
  -- a dedicated background job.  The cleanup targets rows whose window
  -- ended more than one full window ago (i.e. definitely expired).
  --
  -- We derive the window length from the gap between p_window_start and
  -- the current time, but use a fixed 24-hour horizon as a safe upper bound
  -- so we never accidentally delete rows that are still within their window.
  IF random() < 0.01 THEN
    DELETE FROM rate_limits
    WHERE window_start < (
      EXTRACT(EPOCH FROM now()) * 1000 - 24 * 60 * 60 * 1000
    )::BIGINT;
  END IF;

  RETURN v_count > p_max_requests;
END;
$$;

-- Grant execute to the service role (already has table access via RLS policy above)
GRANT EXECUTE ON FUNCTION rate_limit_check(TEXT, TEXT, BIGINT, INTEGER)
  TO service_role;


-- ======================================================================
--  DONE ✓
--
--  After running this script, verify in the Supabase dashboard:
--
--  1. Database → Tables → rate_limits
--     • Columns: ip, endpoint, window_start, count
--     • Shield icon shows RLS is ON
--     • One policy: "Service role only"
--
--  2. Database → Functions → rate_limit_check
--     • Present and owned by postgres / service role
--
--  No environment variables need to change — the Netlify functions already
--  use SUPABASE_URL + SUPABASE_SERVICE_KEY to reach this table.
-- ======================================================================
