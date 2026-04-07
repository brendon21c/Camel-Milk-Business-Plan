// Initializes and exports a single Supabase client instance.
// Uses the service key (not the anon key) so this client has full
// database access — only use server-side, never expose to the browser.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Fail fast if credentials are missing rather than producing silent runtime errors
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'Missing Supabase credentials. Ensure SUPABASE_URL and SUPABASE_SERVICE_KEY are set in your .env file.'
  );
}

// Single shared client — createClient is not cheap to call on every request
const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = { supabase };
