/**
 * _ratelimit.js
 * ─────────────
 * Cross-instance rate limiter backed by a Supabase `rate_limits` table.
 *
 * WHY: In-memory Maps inside Netlify Functions (AWS Lambda) are per-container.
 * Under load, Netlify spins up many parallel containers — each with its own
 * counter.  An attacker can bypass all per-instance limits simply by spreading
 * requests across containers.  This module uses a single Supabase table as the
 * authoritative counter, so limits hold regardless of how many instances exist.
 *
 * HOW: A PostgreSQL function `rate_limit_check` does an atomic upsert
 * (INSERT … ON CONFLICT DO UPDATE SET count = count + 1) and returns whether
 * the new count exceeds the limit.  The round-trip adds ~20–50 ms of latency
 * on warm Lambda instances — acceptable for abuse-prevention paths.
 *
 * FALLBACK: If Supabase is unreachable, the module falls back to an in-memory
 * counter so legitimate users are never blocked by a DB outage.  The fallback
 * logs a warning so the issue is visible in Netlify function logs.
 *
 * CLEANUP: Old rate_limit rows are pruned probabilistically (1 % of calls)
 * inside the Postgres function itself — no separate cron required.
 *
 * USAGE:
 *   const { isRateLimited } = require('./_ratelimit');
 *
 *   if (await isRateLimited(
 *     process.env.SUPABASE_URL,
 *     process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
 *     clientIp,          // string — identifies the requester
 *     'submit',          // string — identifies the endpoint (for per-endpoint limits)
 *     5,                 // max requests allowed in the window
 *     10 * 60 * 1000     // window length in milliseconds
 *   )) {
 *     return { statusCode: 429, ... };
 *   }
 */

const { createClient } = require('@supabase/supabase-js');

// ── In-memory fallback ────────────────────────────────────────────────────────
// Used when Supabase is unavailable.  Per-instance only, but better than nothing.
const _fallback = new Map();

function _fallbackCheck(ip, endpoint, maxRequests, windowMs) {
  const key = `${endpoint}:${ip}`;
  const now = Date.now();
  let entry = _fallback.get(key);

  if (!entry || now > entry.resetAt) {
    _fallback.set(key, { count: 1, resetAt: now + windowMs });
    return false; // not limited
  }

  entry.count++;

  // Prune stale entries to prevent unbounded growth
  if (_fallback.size > 5000) {
    for (const [k, v] of _fallback) {
      if (now > v.resetAt) _fallback.delete(k);
    }
  }

  return entry.count > maxRequests;
}

/**
 * Returns true if the caller should be rate-limited.
 *
 * @param {string}  supabaseUrl   - SUPABASE_URL env var value
 * @param {string}  supabaseKey   - SUPABASE_SERVICE_KEY env var value
 * @param {string}  ip            - Client IP address
 * @param {string}  endpoint      - Short name for the calling function (e.g. 'submit')
 * @param {number}  maxRequests   - Maximum number of requests allowed in the window
 * @param {number}  windowMs      - Window duration in milliseconds
 * @returns {Promise<boolean>}    - true = rate limited, false = allow
 */
async function isRateLimited(supabaseUrl, supabaseKey, ip, endpoint, maxRequests, windowMs) {
  // No credentials → can only use in-memory fallback
  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[ratelimit:${endpoint}] Supabase credentials not set — using in-memory fallback.`);
    return _fallbackCheck(ip, endpoint, maxRequests, windowMs);
  }

  // window_start: floor to the nearest windowMs boundary so all counters
  // within the same window share the same row key.
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('rate_limit_check', {
      p_ip:          String(ip      || 'unknown').slice(0, 64),
      p_endpoint:    String(endpoint || 'unknown').slice(0, 64),
      p_window_start: windowStart,
      p_max_requests: maxRequests
    });

    if (error) {
      // DB error — fail open (allow the request) so legit users aren't blocked
      // by a transient Supabase hiccup.  Log so ops can see the issue.
      console.warn(
        `[ratelimit:${endpoint}] Supabase RPC error — failing open (allowing request):`,
        error.message
      );
      return _fallbackCheck(ip, endpoint, maxRequests, windowMs);
    }

    // data is the boolean returned by the Postgres function (true = limited)
    return data === true;

  } catch (err) {
    console.warn(
      `[ratelimit:${endpoint}] Unexpected error — failing open:`,
      err instanceof Error ? err.message : String(err)
    );
    return _fallbackCheck(ip, endpoint, maxRequests, windowMs);
  }
}

module.exports = { isRateLimited };
