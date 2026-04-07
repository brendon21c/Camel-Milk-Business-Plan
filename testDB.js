// testDB.js — Temporary smoke test for the db.js / Supabase integration.
// Creates a dummy client row, reads it back, logs it, then cleans up.
// Run with: node testDB.js
// Delete this file once the DB connection is confirmed working.

const { createClient } = require('./db');
const { supabase } = require('./supabaseClient');

async function run() {
  console.log('--- DB smoke test ---');

  // 1. Insert a dummy client row
  console.log('Creating test client...');
  const created = await createClient({ name: 'Test Client', email: 'test@test.com' });
  console.log('Inserted row:', created);

  // 2. Read it back directly from Supabase using its generated id
  console.log('Reading back from Supabase...');
  const { data: fetched, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', created.id)
    .single();

  if (error) throw new Error(`Read-back failed: ${error.message}`);
  console.log('Fetched row:', fetched);

  // 3. Delete the test row so the table stays clean
  console.log('Deleting test client...');
  const { error: deleteError } = await supabase
    .from('clients')
    .delete()
    .eq('id', created.id);

  if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);
  console.log('Deleted successfully. Test passed.');
}

run().catch((err) => {
  console.error('Test FAILED:', err.message);
  process.exit(1);
});
