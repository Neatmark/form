#!/usr/bin/env node
/**
 * setup-supabase.js
 * ─────────────────
 * Run once to ensure every required column exists in the `submissions` table.
 * Columns that already exist are silently skipped.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=your_key node setup-supabase.js
 *
 * Or put the env vars in a .env file and run:
 *   node -r dotenv/config setup-supabase.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required.');
  process.exit(1);
}

// Each entry: [column_name, pg_type, optional_default_clause]
const REQUIRED_COLUMNS = [
  // Core / metadata
  ['history',                 'jsonb',   "NOT NULL DEFAULT '[]'::jsonb"],
  ['status',                  'text',    "NOT NULL DEFAULT 'pending'"],
  ['project-status',          'text',    null],
  ['client-name',             'text',    null],
  ['brand-name',              'text',    null],
  ['email',                   'text',    null],
  ['delivery-date',           'text',    null],
  ['agreed-delivery-date',    'text',    null],
  ['brand-logo-ref',          'text',    null],
  // Section 01 – Brand Foundation
  ['q1-business-description',   'text',  null],
  ['q2-problem-transformation', 'text',  null],
  ['q3-ideal-customer',         'text',  null],
  ['q4-competitors',            'text',  null],
  ['q5-brand-personality',      'text',  null],
  ['q6-positioning',            'text',  null],
  ['q7-decision-maker',         'text',  null],
  ['q7-decision-maker-other',   'text',  null],
  // Section 02 – Visual Direction
  ['q8-brands-admired',          'text',    null],
  ['q9-color',                   'text[]',  null],
  ['q10-colors-to-avoid',        'text',    null],
  ['q11-aesthetic',              'text[]',  null],
  ['q11-aesthetic-description',  'text',    null],
  ['q12-existing-assets',        'text',    null],
  ['q13-deliverables',           'text[]',  null],
  ['q14-budget',                 'text',    null],
  ['q15-inspiration-refs',       'text[]',  null],
  ['q16-anything-else',          'text',    null],
];

async function run() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });

  console.log('Checking columns in `submissions` table…\n');

  // Fetch existing columns via information_schema
  const { data: existingCols, error: fetchError } = await supabase
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', 'submissions');

  let existingSet = new Set();
  if (fetchError) {
    // Supabase RLS may block information_schema; fall back to raw SQL approach
    console.warn('Could not read information_schema, will attempt ALTER TABLE for each column.\n');
  } else {
    existingSet = new Set((existingCols || []).map(r => r.column_name));
  }

  let added = 0;
  let skipped = 0;
  let errors = 0;

  for (const [col, type, extra] of REQUIRED_COLUMNS) {
    if (existingSet.size > 0 && existingSet.has(col)) {
      console.log(`  ✓ SKIP   "${col}" already exists`);
      skipped++;
      continue;
    }

    const extraClause = extra ? ` ${extra}` : '';
    const sql = `ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "${col}" ${type}${extraClause};`;

    const { error } = await supabase.rpc('exec_sql', { sql }).catch(() => ({ error: { message: 'rpc not available' } }));

    if (error) {
      // exec_sql RPC may not exist — log the SQL for manual execution
      console.warn(`  ⚠ MANUAL  "${col}": run manually → ${sql}`);
      errors++;
    } else {
      console.log(`  + ADDED   "${col}" ${type}`);
      added++;
    }
  }

  console.log(`\nDone. Added: ${added} | Skipped: ${skipped} | Manual: ${errors}`);

  if (errors > 0) {
    console.log('\nFor columns marked MANUAL, run the following SQL in your Supabase SQL Editor:');
    console.log('──────────────────────────────────────────────────────────────────────────');
    for (const [col, type, extra] of REQUIRED_COLUMNS) {
      const extraClause = extra ? ` ${extra}` : '';
      console.log(`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "${col}" ${type}${extraClause};`);
    }
  }
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
