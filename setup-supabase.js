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
  ['project_status',          'text',    null],
  ['client_name',             'text',    null],
  ['brand_name',              'text',    null],
  ['email',                   'text',    null],
  ['delivery_date',           'text',    null],
  ['agreed_delivery_date',    'text',    null],
  ['brand_logo_ref',          'text',    null],
  ['client_website',          'text',    null],
  ['client_country',          'text',    null],
  // Section 01 – Brand Foundation
  ['business-description',      'text',  null],
  ['problem-transformation',    'text',  null],
  ['ideal-customer',            'text',  null],
  ['customer-desire',           'text',  null],
  ['competitors',               'text',  null],
  ['brand-personality',         'text',  null],
  ['positioning',               'text',  null],
  ['launch-context',            'text',  null],
  ['decision-maker',            'text',  null],
  ['decision-maker-other',      'text',  null],
  // Section 02 – Visual Direction
  ['brands-admired',            'text',    null],
  ['color',                     'text[]',  null],
  ['colors-to-avoid',           'text',    null],
  ['aesthetic',                 'text[]',  null],
  ['aesthetic-description',     'text',    null],
  ['existing-assets',           'text',    null],
  ['deliverables',              'text[]',  null],
  ['budget',                    'text',    null],
  ['inspiration-refs',          'text[]',  null],
  ['anything-else',             'text',    null],
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
