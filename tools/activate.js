/**
 * tools/activate.js
 *
 * Activates a proposition after the client has signed and paid.
 * Flips both the client and proposition status to 'active', sets the
 * initial run schedule based on the plan tier, and triggers the first report run.
 *
 * Usage:
 *   node tools/activate.js --proposition-id <uuid>
 *
 * Optional flags:
 *   --schedule-day <1-28>   Day of month for monthly runs (default: today's date, capped at 28)
 *   --skip-first-run        Set up the schedule but do NOT trigger a report run immediately
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execSync }   = require('child_process');
const path           = require('path');
const {
  getPropositionById,
  getClientById,
  updateClientStatus,
  activateProposition,
} = require('../db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Maps plan tier → schedule type for the propositions table
// Starter = on_demand (single run, no recurring schedule)
// Pro     = on_demand (two runs total — managed manually)
// Retainer = monthly recurring
const PLAN_SCHEDULE = {
  starter:  'on_demand',
  pro:      'on_demand',
  retainer: 'monthly',
};

const ADMIN_EMAIL = 'brennon.mckeever@gmail.com';
const FROM_EMAIL  = 'McKeever Consulting <onboarding@resend.dev>';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses --proposition-id, --schedule-day, and --skip-first-run from argv.
 */
function parseArgs() {
  const args    = process.argv.slice(2);
  const result  = { skipFirstRun: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proposition-id' && args[i + 1]) {
      result.propositionId = args[++i];
    } else if (args[i] === '--schedule-day' && args[i + 1]) {
      result.scheduleDay = parseInt(args[++i], 10);
    } else if (args[i] === '--skip-first-run') {
      result.skipFirstRun = true;
    }
  }

  if (!result.propositionId) {
    console.error('Usage: node tools/activate.js --proposition-id <uuid> [--schedule-day <1-28>] [--skip-first-run]');
    process.exit(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Schedule calculation
// ---------------------------------------------------------------------------

/**
 * Calculates the next_run_at timestamp for monthly retainer plans.
 * Fires on the same day next month (or today if same day is desired).
 * For non-retainer plans returns null — runs are triggered on demand.
 *
 * @param {string} scheduleType - 'monthly' | 'on_demand'
 * @param {number} scheduleDay  - Day of month (1–28)
 * @returns {string|null} ISO timestamp or null
 */
function calcNextRunAt(scheduleType, scheduleDay) {
  if (scheduleType !== 'monthly') return null;

  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, scheduleDay);
  return next.toISOString();
}

// ---------------------------------------------------------------------------
// Activation email
// ---------------------------------------------------------------------------

/**
 * Sends a confirmation email to Brendon after activation.
 * This is an internal-only alert — client communication is handled separately.
 *
 * @param {Object} client      - Client row.
 * @param {Object} proposition - Proposition row (post-activation).
 */
async function sendActivationEmail(client, proposition) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1C3557; padding: 24px 32px;">
        <h1 style="color: #C8A94A; font-size: 22px; margin: 0;">McKeever Consulting</h1>
        <p style="color: #8A9BB0; font-size: 13px; margin: 4px 0 0;">Proposition Activated</p>
      </div>

      <div style="padding: 32px; background: #F7F8FA; border: 1px solid #e0e0e0;">
        <h2 style="color: #1C3557; margin-top: 0;">✓ ${client.name} is now active</h2>

        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; color: #555; width: 140px;"><strong>Client</strong></td>
              <td>${client.name} &lt;${client.email}&gt;</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Plan</strong></td>
              <td style="color: #C8A94A; font-weight: bold;">${proposition.plan_tier}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Schedule</strong></td>
              <td>${proposition.schedule_type}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Next Run</strong></td>
              <td>${proposition.next_run_at ? new Date(proposition.next_run_at).toDateString() : 'On demand'}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Proposition ID</strong></td>
              <td style="font-size: 12px; color: #888;">${proposition.id}</td></tr>
        </table>

        <p style="color: #555; font-size: 13px; margin-top: 20px;">
          The first report run has been triggered automatically.<br>
          Check your inbox for the completed report within a few minutes.
        </p>
      </div>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [ADMIN_EMAIL],
      subject: `[Activated] ${client.name} — ${proposition.plan_tier} plan`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Non-fatal — log but don't crash the activation
    console.warn(`Warning: activation email failed: ${res.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { propositionId, scheduleDay: argDay, skipFirstRun } = parseArgs();

  console.log(`\nActivating proposition: ${propositionId}`);

  // 1. Fetch current proposition + client
  const proposition = await getPropositionById(propositionId);
  const client      = await getClientById(proposition.client_id);

  console.log(`  Client:    ${client.name}`);
  console.log(`  Plan:      ${proposition.plan_tier}`);
  console.log(`  Current status: ${proposition.status}`);

  // Guard — don't re-activate something already active
  if (proposition.status === 'active') {
    console.warn('\nWarning: proposition is already active. Use --force to re-activate.');
    console.warn('Exiting without changes.');
    process.exit(0);
  }

  // 2. Determine schedule settings
  const scheduleType = PLAN_SCHEDULE[proposition.plan_tier] || 'on_demand';
  // Use provided day, or today's day of month (capped at 28 to avoid month-end issues)
  const scheduleDay  = argDay || Math.min(new Date().getDate(), 28);
  const nextRunAt    = calcNextRunAt(scheduleType, scheduleDay);

  console.log(`  Schedule:  ${scheduleType}${nextRunAt ? ` (day ${scheduleDay} monthly)` : ''}`);

  // 3. Flip proposition to active
  const updatedProposition = await activateProposition(propositionId, {
    status:        'active',
    schedule_type: scheduleType,
    schedule_day:  scheduleType === 'monthly' ? scheduleDay : null,
    next_run_at:   nextRunAt,
  });
  console.log('✓ Proposition status → active');

  // 4. Flip client to active
  await updateClientStatus(client.id, 'active');
  console.log('✓ Client status → active');

  // 5. Send activation email to Brendon
  await sendActivationEmail(client, updatedProposition);
  console.log('✓ Activation email sent');

  // 6. Trigger first report run (unless --skip-first-run)
  if (skipFirstRun) {
    console.log('  Skipping first run (--skip-first-run flag set)');
  } else {
    console.log('\n  Triggering first report run...');
    // run.js is the orchestrator — built in the next step (Step 10/11)
    // For now we check if it exists and call it, otherwise print instructions
    const runScript = require('path').join(__dirname, '..', 'run.js');
    const fs        = require('fs');

    if (fs.existsSync(runScript)) {
      try {
        execSync(
          `node "${runScript}" --proposition-id ${propositionId} --force`,
          { stdio: 'inherit', cwd: path.join(__dirname, '..') }
        );
      } catch (err) {
        // Non-fatal — activation succeeded, report failure is logged separately
        console.error(`  Warning: first run failed: ${err.message}`);
        console.error('  The proposition is active. Retry with:');
        console.error(`    node run.js --proposition-id ${propositionId} --force`);
      }
    } else {
      // run.js not built yet — print instructions
      console.log('\n  run.js not found (not built yet).');
      console.log('  Once built, trigger the first run with:');
      console.log(`    node run.js --proposition-id ${propositionId} --force`);
    }
  }

  console.log('\n── Activation complete ──────────────────────────────');
  console.log(`  Client:         ${client.name} (active)`);
  console.log(`  Proposition ID: ${propositionId} (active)`);
  console.log(`  Schedule:       ${scheduleType}`);
  if (nextRunAt) {
    console.log(`  Next run:       ${new Date(nextRunAt).toDateString()}`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
