/**
 * process-form.js — DEPRECATED
 * ─────────────────────────────
 * This endpoint has been replaced by:
 *   /.netlify/functions/submit       → saves to DB, returns immediately
 *   /.netlify/functions/send-emails  → generates docs & sends emails (background)
 *
 * Returns 410 Gone so any old/cached callers get a clear error instead of
 * triggering the old synchronous PDF + email generation path.
 */

exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    error: 'This endpoint has been removed. Use /.netlify/functions/submit instead.'
  })
});
