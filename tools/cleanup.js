/**
 * tools/cleanup.js — Periodic data pruning for the McKeever Consulting pipeline.
 *
 * Enforces a 6-month retention window on report data. Clients can access any
 * report from the past 6 months; anything older is deleted from both the DB
 * and Supabase Storage. Client and proposition records are never touched.
 *
 * Usage:
 *   node tools/cleanup.js --prune            # delete data older than 6 months (dry-run by default)
 *   node tools/cleanup.js --prune --confirm  # actually delete (required to make changes)
 *
 * What gets deleted:
 *   - reports rows (status = 'complete') older than 6 months
 *   - report_sources rows linked to those reports
 *   - agent_outputs rows linked to those reports (belt-and-suspenders — normally gone post-run)
 *   - Supabase Storage files: {proposition_id}/{reportId}.pdf and {reportId}_content.json
 *   - api_cache entries older than 7 days
 *
 * What is NEVER deleted:
 *   - clients rows
 *   - propositions rows
 *   - reports with status 'failed' or 'running' (left for debugging)
 *   - The most recent completed report per proposition, regardless of age
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');

// Supabase client — service key required for Storage delete operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const REPORT_RETENTION_DAYS = 180; // 6 months
const CACHE_TTL_DAYS        = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns an ISO timestamp for N days ago.
 * @param {number} days
 * @returns {string}
 */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Prune — 6-month report retention
// ---------------------------------------------------------------------------

/**
 * Finds and deletes all completed reports older than REPORT_RETENTION_DAYS,
 * along with their linked sources, agent_outputs, and Storage files.
 * Skips the most recent completed report per proposition regardless of age
 * so clients always have at least one accessible report.
 *
 * @param {boolean} dryRun - If true, log what would be deleted without deleting.
 */
async function pruneOldReports(dryRun) {
  const cutoff = daysAgo(REPORT_RETENTION_DAYS);
  console.log(`\nReport retention cutoff: ${new Date(cutoff).toDateString()} (${REPORT_RETENTION_DAYS} days)`);

  // Fetch all completed reports older than the cutoff
  const { data: candidates, error: fetchErr } = await supabase
    .from('reports')
    .select('id, proposition_id, created_at')
    .eq('status', 'complete')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true });

  if (fetchErr) throw new Error(`Could not fetch old reports: ${fetchErr.message}`);
  if (!candidates.length) {
    console.log('  No reports older than 6 months found.');
    return;
  }

  // Find the most recent completed report per proposition so we can protect it.
  // A client should always have at least their last report accessible.
  const { data: latestReports, error: latestErr } = await supabase
    .from('reports')
    .select('id, proposition_id')
    .eq('status', 'complete')
    .order('created_at', { ascending: false });

  if (latestErr) throw new Error(`Could not fetch latest reports: ${latestErr.message}`);

  // Build a set of the most recent report ID per proposition
  const latestIdPerProposition = new Set();
  const seen = new Set();
  for (const r of latestReports) {
    if (!seen.has(r.proposition_id)) {
      latestIdPerProposition.add(r.id);
      seen.add(r.proposition_id);
    }
  }

  // Filter out protected reports
  const toDelete = candidates.filter(r => !latestIdPerProposition.has(r.id));

  console.log(`  Found ${candidates.length} reports older than 6 months`);
  console.log(`  Protected (most recent per proposition): ${candidates.length - toDelete.length}`);
  console.log(`  To delete: ${toDelete.length}`);

  if (!toDelete.length) {
    console.log('  Nothing to delete after applying protection rules.');
    return;
  }

  for (const report of toDelete) {
    const age = Math.round((Date.now() - new Date(report.created_at)) / (1000 * 60 * 60 * 24));
    console.log(`\n  Report ${report.id} (${age} days old)`);

    if (dryRun) {
      // In dry-run mode, just describe what would happen
      console.log(`    [dry-run] Would delete Storage: ${report.proposition_id}/${report.id}.pdf`);
      console.log(`    [dry-run] Would delete Storage: ${report.proposition_id}/${report.id}_content.json`);
      console.log(`    [dry-run] Would delete report_sources rows`);
      console.log(`    [dry-run] Would delete agent_outputs rows`);
      console.log(`    [dry-run] Would delete reports row`);
      continue;
    }

    // Delete Storage files (PDF + content JSON)
    const { error: storageErr } = await supabase.storage
      .from('reports')
      .remove([
        `${report.proposition_id}/${report.id}.pdf`,
        `${report.proposition_id}/${report.id}_content.json`,
      ]);

    if (storageErr) {
      // Non-fatal — file may already be gone; log and continue
      console.warn(`    ⚠ Storage delete failed (continuing): ${storageErr.message}`);
    } else {
      console.log(`    ✓ Storage files deleted`);
    }

    // Delete report_sources
    const { error: sourcesErr } = await supabase
      .from('report_sources')
      .delete()
      .eq('report_id', report.id);

    if (sourcesErr) console.warn(`    ⚠ report_sources delete failed: ${sourcesErr.message}`);
    else console.log(`    ✓ report_sources deleted`);

    // Delete agent_outputs (belt-and-suspenders — normally purged post-run)
    const { error: agentErr } = await supabase
      .from('agent_outputs')
      .delete()
      .eq('report_id', report.id);

    if (agentErr) console.warn(`    ⚠ agent_outputs delete failed: ${agentErr.message}`);
    else console.log(`    ✓ agent_outputs deleted`);

    // Delete the report row itself (last, so FK-linked tables are already clean)
    const { error: reportErr } = await supabase
      .from('reports')
      .delete()
      .eq('id', report.id);

    if (reportErr) console.warn(`    ⚠ reports row delete failed: ${reportErr.message}`);
    else console.log(`    ✓ reports row deleted`);
  }
}

// ---------------------------------------------------------------------------
// Cache sweep — 7-day TTL
// ---------------------------------------------------------------------------

/**
 * Deletes api_cache entries older than CACHE_TTL_DAYS.
 * The cache stores Brave Search results to avoid redundant API calls.
 * Stale entries waste storage and may return outdated data.
 *
 * @param {boolean} dryRun
 */
async function sweepCache(dryRun) {
  const cutoff = daysAgo(CACHE_TTL_DAYS);
  console.log(`\nCache sweep — entries older than ${new Date(cutoff).toDateString()} (${CACHE_TTL_DAYS} days)`);

  if (dryRun) {
    // Count without deleting
    const { count, error } = await supabase
      .from('api_cache')
      .select('*', { count: 'exact', head: true })
      .lt('cached_at', cutoff);

    if (error) console.warn(`  ⚠ Could not count cache entries: ${error.message}`);
    else console.log(`  [dry-run] Would delete ${count ?? '?'} expired cache entries`);
    return;
  }

  const { error, count } = await supabase
    .from('api_cache')
    .delete({ count: 'exact' })
    .lt('cached_at', cutoff);

  if (error) console.warn(`  ⚠ Cache sweep failed: ${error.message}`);
  else console.log(`  ✓ Deleted ${count ?? '?'} expired cache entries`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args    = process.argv.slice(2);
  const prune   = args.includes('--prune');
  const confirm = args.includes('--confirm');

  if (!prune) {
    console.log('Usage:');
    console.log('  node tools/cleanup.js --prune            # dry-run: shows what would be deleted');
    console.log('  node tools/cleanup.js --prune --confirm  # actually delete');
    process.exit(0);
  }

  const dryRun = !confirm;

  console.log('McKeever Consulting — Data Cleanup');
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --confirm to apply changes)' : 'LIVE — changes will be made'}`);
  console.log(`Started: ${new Date().toISOString()}`);

  await pruneOldReports(dryRun);
  await sweepCache(dryRun);

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
