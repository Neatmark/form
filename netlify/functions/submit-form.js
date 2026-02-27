/**
 * submit-form.js
 * ──────────────
 * Legacy endpoint kept for backward compatibility.
 * All logic now lives in submit.js — this is a thin pass-through.
 */

const { handler } = require('./submit');
exports.handler = handler;
