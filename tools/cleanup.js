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
 *   - reports rows (status = 'failed') older than 7 days + any orphaned agent_outputs
 *   - api_cache entries older than 7 days
 *
 * What is NEVER deleted:
 *   - clients rows
 *   - propositions rows
 *   - reports with status 'running' (active run in progress)
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
const FAILED_REPORT_TTL_DAYS = 7;  // failed reports deleted after 7 days — error already emailed at failure time
const CACHE_TTL_DAYS         = 7;

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
// Failed report pruning — 7-day TTL
// ---------------------------------------------------------------------------

/**
 * Deletes failed report rows (and any orphaned agent_outputs) older than FAILED_REPORT_TTL_DAYS.
 * The error message and failure alert are emailed to Brendon at failure time, so there is no
 * operational value in keeping these rows beyond a short debugging window.
 * Note: agent_outputs are also deleted immediately at failure time in run.js, but this acts
 * as a belt-and-suspenders sweep for any that slipped through.
 *
 * @param {boolean} dryRun - If true, log what would be deleted without deleting.
 */
async function pruneFailedReports(dryRun) {
  const cutoff = daysAgo(FAILED_REPORT_TTL_DAYS);
  console.log(`\nFailed report cutoff: ${new Date(cutoff).toDateString()} (${FAILED_REPORT_TTL_DAYS} days)`);

  const { data: failed, error: fetchErr } = await supabase
    .from('reports')
    .select('id, proposition_id, created_at, error_message')
    .eq('status', 'failed')
    .lt('created_at', cutoff);

  if (fetchErr) throw new Error(`Could not fetch failed reports: ${fetchErr.message}`);
  if (!failed.length) {
    console.log('  No failed reports older than 7 days found.');
    return;
  }

  console.log(`  Found ${failed.length} failed report(s) to delete`);

  for (const report of failed) {
    const age = Math.round((Date.now() - new Date(report.created_at)) / (1000 * 60 * 60 * 24));
    console.log(`\n  Failed report ${report.id} (${age} days old)`);

    if (dryRun) {
      console.log(`    [dry-run] Error was: ${(report.error_message || 'none').slice(0, 120)}`);
      console.log(`    [dry-run] Would delete agent_outputs rows`);
      console.log(`    [dry-run] Would delete reports row`);
      continue;
    }

    // Delete any orphaned agent_outputs (normally gone at failure time, but sweep anyway)
    const { error: agentErr } = await supabase
      .from('agent_outputs')
      .delete()
      .eq('report_id', report.id);

    if (agentErr) console.warn(`    ⚠ agent_outputs delete failed: ${agentErr.message}`);
    else console.log(`    ✓ agent_outputs deleted`);

    // Delete the report row
    const { error: reportErr } = await supabase
      .from('reports')
      .delete()
      .eq('id', report.id);

    if (reportErr) console.warn(`    ⚠ reports row delete failed: ${reportErr.message}`);
    else console.log(`    ✓ Failed report ${report.id} deleted`);
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
// Test data purge
// ---------------------------------------------------------------------------

/**
 * Deletes all records tagged is_test=true across all tables.
 * Runs in FK-safe order: child tables first, parent tables last.
 *
 * Deletion order:
 *   1. proposition_context  (FK → propositions)
 *   2. proposition_recipients (FK → propositions + clients)
 *   3. report_sources       (FK → reports)
 *   4. agent_outputs        (FK → reports)
 *   5. Storage files        (keyed by proposition_id + report_id)
 *   6. reports              (FK → propositions)
 *   7. propositions         (FK → organizations)
 *   8. clients              (FK → organizations)
 *   9. organizations
 *
 * @param {boolean} dryRun - If true, log what would be deleted without deleting.
 */
async function purgeTestData(dryRun) {
  console.log('\nTest data purge — is_test = true records only');

  // ── Collect test proposition IDs for FK traversal ────────────────────────

  const { data: testProps, error: propFetchErr } = await supabase
    .from('propositions')
    .select('id')
    .eq('is_test', true);

  if (propFetchErr) throw new Error(`Could not fetch test propositions: ${propFetchErr.message}`);
  const testPropIds = (testProps || []).map(r => r.id);
  console.log(`  Test propositions found: ${testPropIds.length}`);

  // ── Collect test report IDs so we can purge Storage and child rows ────────

  let testReportIds = [];
  if (testPropIds.length > 0) {
    const { data: testReports, error: reportFetchErr } = await supabase
      .from('reports')
      .select('id, proposition_id')
      .in('proposition_id', testPropIds);

    if (reportFetchErr) throw new Error(`Could not fetch test reports: ${reportFetchErr.message}`);
    testReportIds = (testReports || []).map(r => ({ id: r.id, proposition_id: r.proposition_id }));
    console.log(`  Test reports found: ${testReportIds.length}`);
  }

  if (dryRun) {
    // In dry-run mode just describe scope without touching anything
    const { count: orgCount }    = await supabase.from('organizations').select('*', { count: 'exact', head: true }).eq('is_test', true);
    const { count: clientCount } = await supabase.from('clients').select('*', { count: 'exact', head: true }).eq('is_test', true);
    console.log(`  [dry-run] Would delete ${orgCount ?? '?'} test organization(s)`);
    console.log(`  [dry-run] Would delete ${clientCount ?? '?'} test client(s)`);
    console.log(`  [dry-run] Would delete ${testPropIds.length} test proposition(s)`);
    console.log(`  [dry-run] Would delete ${testReportIds.length} test report(s) + Storage files`);
    console.log('  Pass --confirm to apply.');
    return;
  }

  // ── 1. proposition_context ────────────────────────────────────────────────

  if (testPropIds.length > 0) {
    const { error } = await supabase.from('proposition_context').delete().in('proposition_id', testPropIds);
    if (error) console.warn(`  ⚠ proposition_context delete failed: ${error.message}`);
    else console.log(`  ✓ proposition_context rows deleted`);
  }

  // ── 2. proposition_recipients ─────────────────────────────────────────────

  if (testPropIds.length > 0) {
    const { error } = await supabase.from('proposition_recipients').delete().in('proposition_id', testPropIds);
    if (error) console.warn(`  ⚠ proposition_recipients delete failed: ${error.message}`);
    else console.log(`  ✓ proposition_recipients rows deleted`);
  }

  // ── 3. report_sources + 4. agent_outputs (per report) ────────────────────

  for (const report of testReportIds) {
    const { error: srcErr } = await supabase.from('report_sources').delete().eq('report_id', report.id);
    if (srcErr) console.warn(`  ⚠ report_sources delete failed for report ${report.id}: ${srcErr.message}`);

    const { error: aoErr } = await supabase.from('agent_outputs').delete().eq('report_id', report.id);
    if (aoErr) console.warn(`  ⚠ agent_outputs delete failed for report ${report.id}: ${aoErr.message}`);
  }
  if (testReportIds.length > 0) console.log(`  ✓ report_sources + agent_outputs deleted`);

  // ── 5. Storage files ──────────────────────────────────────────────────────

  const storagePaths = testReportIds.flatMap(r => [
    `${r.proposition_id}/${r.id}.pdf`,
    `${r.proposition_id}/${r.id}_content.json`,
  ]);

  if (storagePaths.length > 0) {
    const { error: storageErr } = await supabase.storage.from('reports').remove(storagePaths);
    if (storageErr) console.warn(`  ⚠ Storage delete failed (files may already be gone): ${storageErr.message}`);
    else console.log(`  ✓ Storage files deleted (${storagePaths.length} paths)`);
  }

  // ── 6. reports ────────────────────────────────────────────────────────────

  if (testPropIds.length > 0) {
    const { error } = await supabase.from('reports').delete().in('proposition_id', testPropIds);
    if (error) console.warn(`  ⚠ reports delete failed: ${error.message}`);
    else console.log(`  ✓ reports rows deleted`);
  }

  // ── 7. propositions ───────────────────────────────────────────────────────

  if (testPropIds.length > 0) {
    const { error } = await supabase.from('propositions').delete().eq('is_test', true);
    if (error) console.warn(`  ⚠ propositions delete failed: ${error.message}`);
    else console.log(`  ✓ propositions rows deleted`);
  }

  // ── 8. clients ────────────────────────────────────────────────────────────

  const { error: clientErr } = await supabase.from('clients').delete().eq('is_test', true);
  if (clientErr) console.warn(`  ⚠ clients delete failed: ${clientErr.message}`);
  else console.log(`  ✓ clients rows deleted`);

  // ── 9. organizations ──────────────────────────────────────────────────────

  const { error: orgErr } = await supabase.from('organizations').delete().eq('is_test', true);
  if (orgErr) console.warn(`  ⚠ organizations delete failed: ${orgErr.message}`);
  else console.log(`  ✓ organizations rows deleted`);

  console.log('\n  ✓ Test data purge complete.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args       = process.argv.slice(2);
  const prune      = args.includes('--prune');
  const purgeTest  = args.includes('--purge-test');
  const confirm    = args.includes('--confirm');

  if (!prune && !purgeTest) {
    console.log('Usage:');
    console.log('  node tools/cleanup.js --prune                       # dry-run: shows what would be deleted (6-month retention)');
    console.log('  node tools/cleanup.js --prune --confirm             # actually delete old reports');
    console.log('  node tools/cleanup.js --purge-test                  # dry-run: shows all is_test=true records');
    console.log('  node tools/cleanup.js --purge-test --confirm        # delete ALL test data permanently');
    process.exit(0);
  }

  const dryRun = !confirm;

  console.log('McKeever Consulting — Data Cleanup');
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --confirm to apply changes)' : 'LIVE — changes will be made'}`);
  console.log(`Started: ${new Date().toISOString()}`);

  if (purgeTest) {
    await purgeTestData(dryRun);
  }

  if (prune) {
    await pruneOldReports(dryRun);
    await pruneFailedReports(dryRun);
    await sweepCache(dryRun);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
