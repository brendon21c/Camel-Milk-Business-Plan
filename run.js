/**
 * run.js — Main orchestrator for the McKeever Consulting report pipeline.
 *
 * Determines which propositions need a report run, creates the report record
 * in Supabase, coordinates all research sub-agents, triggers the assembler,
 * uploads the PDF, and delivers it to the client by email.
 *
 * Usage:
 *   # Run all scheduled (due) propositions
 *   node run.js
 *
 *   # Run a specific proposition on demand (bypasses next_run_at check)
 *   node run.js --proposition-id <uuid> --force
 *
 * Part 1 — Structure complete (argument parsing, scheduling, report record,
 *           error handling, agent stubs).
 * Part 2 — Agent orchestration, assembler, PDF generation, Storage upload,
 *           email delivery, and quality gate will be filled in next session.
 */

require('dotenv').config();

const {
  getPropositionById,
  getClientById,
  getDuePropositions,
  getReportsByPropositionId,
  createReport,
  updateReportStatus,
  updateReportError,
  saveAgentOutput,
  advancePropositionSchedule,
} = require('./db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The 10 research agent names — must match workflow filenames (without .md)
// and the agent_name field written to agent_outputs in the DB.
const RESEARCH_AGENTS = [
  'market_overview',
  'competitors',
  'regulatory',
  'production',
  'packaging',
  'distribution',
  'marketing',
  'financials',
  'origin_ops',
  'legal',
];

// Email address that receives failure alerts
const ADMIN_EMAIL = 'brennon.mckeever@gmail.com';
const FROM_EMAIL  = 'McKeever Consulting <onboarding@resend.dev>';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses CLI arguments from process.argv.
 * Recognises:
 *   --proposition-id <uuid>  Target a specific proposition (required with --force)
 *   --force                  Bypass next_run_at and run immediately
 *
 * @returns {{ propositionId: string|undefined, force: boolean }}
 */
function parseArgs() {
  const args   = process.argv.slice(2);
  const result = { propositionId: undefined, force: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proposition-id' && args[i + 1]) {
      result.propositionId = args[++i];
    } else if (args[i] === '--force') {
      result.force = true;
    }
  }

  // --force without --proposition-id is ambiguous — refuse it
  if (result.force && !result.propositionId) {
    console.error('Error: --force requires --proposition-id <uuid>');
    console.error('Usage: node run.js --proposition-id <uuid> --force');
    process.exit(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Proposition selection
// ---------------------------------------------------------------------------

/**
 * Returns the list of propositions that should run in this invocation.
 *
 * Two modes:
 *   --proposition-id + --force → run exactly that one proposition now.
 *   (no flags)                 → query DB for all propositions whose
 *                               next_run_at has passed (scheduled runs).
 *
 * @param {{ propositionId: string|undefined, force: boolean }} args
 * @returns {Promise<Object[]>} Array of proposition rows to process.
 */
async function getPropositionsToRun(args) {
  if (args.propositionId && args.force) {
    // On-demand: load the single target proposition
    console.log(`\nForce run requested for proposition: ${args.propositionId}`);
    const proposition = await getPropositionById(args.propositionId);
    return [proposition];
  }

  // Scheduled run: find all propositions whose next_run_at <= now
  console.log('\nChecking for due propositions...');
  const due = await getDuePropositions();

  if (due.length === 0) {
    console.log('No propositions due. Nothing to run.');
  } else {
    console.log(`Found ${due.length} due proposition(s).`);
  }

  return due;
}

// ---------------------------------------------------------------------------
// Report record creation
// ---------------------------------------------------------------------------

/**
 * Creates the report record in Supabase before the run begins.
 * Sets status to 'pending' and populates run_number and previous_report_id
 * by inspecting the proposition's historical reports.
 *
 * run_number    = total past reports for this proposition + 1
 * previous_report_id = the most recent completed report (or null on first run)
 *
 * @param {Object} proposition - The proposition row being run.
 * @returns {Promise<Object>}  The newly created report row.
 */
async function createReportRecord(proposition) {
  // Fetch all historical reports for this proposition, newest first
  const history = await getReportsByPropositionId(proposition.id);

  // run_number is 1-indexed
  const runNumber = history.length + 1;

  // The most recent *completed* report becomes the basis for "What Changed"
  const previousCompleted = history.find(r => r.status === 'complete');
  const previousReportId  = previousCompleted ? previousCompleted.id : null;

  // Title format: "<Proposition Title> — Report #<N>"
  const title = `${proposition.title} — Report #${runNumber}`;

  const report = await createReport({
    proposition_id:     proposition.id,
    client_id:          proposition.client_id,
    run_number:         runNumber,
    previous_report_id: previousReportId,
    title,
    status:             'pending',
  });

  console.log(`✓ Report record created (ID: ${report.id}, run #${runNumber})`);
  return report;
}

// ---------------------------------------------------------------------------
// Research agent stubs
// ─────────────────────────────────────────────────────────────────────────────
// Each function below will be filled in during Part 2. In Part 2 each stub
// will:
//   1. Read its corresponding workflow file from workflows/
//   2. Build a prompt that includes the workflow SOP + proposition context
//   3. Call Claude Haiku via the Anthropic SDK (fast tier — narrow, well-defined)
//   4. Parse the structured output
//   5. Call saveAgentOutput() to persist the result
//   6. Return the parsed output for the quality gate
//
// The context object passed to every agent:
// {
//   reportId:          string,   — for saveAgentOutput calls
//   proposition:       Object,   — full proposition row
//   client:            Object,   — full client row
//   runNumber:         number,   — 1-indexed run count (affects "What Changed")
//   previousReportId:  string|null,
// }
// ---------------------------------------------------------------------------

/**
 * Runs the Market Overview research agent.
 * Covers: market size, growth trends, consumer demand, segment analysis.
 * Workflow: workflows/research_market_overview.md
 *
 * @param {Object} context - Run context (see above).
 * @returns {Promise<Object|null>} Structured agent output, or null (stub).
 */
async function runMarketOverviewAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_market_overview.md workflow
  console.log('    [stub] market_overview — skipped (Part 2)');
  return null;
}

/**
 * Runs the Competitor Analysis research agent.
 * Covers: direct/indirect competitors, pricing, positioning, market gaps.
 * Workflow: workflows/research_competitors.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runCompetitorsAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_competitors.md workflow
  console.log('    [stub] competitors — skipped (Part 2)');
  return null;
}

/**
 * Runs the Regulatory Landscape research agent.
 * Covers: FDA/USDA import rules, labelling, certifications, customs.
 * Workflow: workflows/research_regulatory.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runRegulatoryAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_regulatory.md workflow
  console.log('    [stub] regulatory — skipped (Part 2)');
  return null;
}

/**
 * Runs the Production & Equipment research agent.
 * Covers: processing equipment, capacity, suppliers, unit economics.
 * Workflow: workflows/research_production.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runProductionAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_production.md workflow
  console.log('    [stub] production — skipped (Part 2)');
  return null;
}

/**
 * Runs the Packaging research agent.
 * Covers: packaging options, materials, suppliers, unit costs, shelf life.
 * Workflow: workflows/research_packaging.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runPackagingAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_packaging.md workflow
  console.log('    [stub] packaging — skipped (Part 2)');
  return null;
}

/**
 * Runs the Distribution Strategy research agent.
 * Covers: logistics, importers, distributors, retail channels, e-commerce.
 * Workflow: workflows/research_distribution.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runDistributionAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_distribution.md workflow
  console.log('    [stub] distribution — skipped (Part 2)');
  return null;
}

/**
 * Runs the Marketing & Influencers research agent.
 * Covers: marketing channels, influencers, ad spend benchmarks, messaging.
 * Workflow: workflows/research_marketing.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runMarketingAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_marketing.md workflow
  console.log('    [stub] marketing — skipped (Part 2)');
  return null;
}

/**
 * Runs the Financial Projections research agent.
 * Covers: revenue model, cost structure, break-even, 3-year projections.
 * Workflow: workflows/research_financials.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runFinancialsAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_financials.md workflow
  console.log('    [stub] financials — skipped (Part 2)');
  return null;
}

/**
 * Runs the Origin Operations research agent.
 * Covers: sourcing in the origin country, suppliers, export logistics, quality.
 * Uses domestic path when origin_country == target_country.
 * Workflow: workflows/research_origin_ops.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runOriginOpsAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_origin_ops.md workflow
  console.log('    [stub] origin_ops — skipped (Part 2)');
  return null;
}

/**
 * Runs the Legal research agent.
 * Covers: business entity, contracts, IP, liability, import/export law.
 * Workflow: workflows/research_legal.md
 *
 * @param {Object} context - Run context.
 * @returns {Promise<Object|null>}
 */
async function runLegalAgent(context) {
  // TODO Part 2: Call Claude Haiku with research_legal.md workflow
  console.log('    [stub] legal — skipped (Part 2)');
  return null;
}

// ---------------------------------------------------------------------------
// Research orchestration
// ---------------------------------------------------------------------------

/**
 * Runs all 10 research sub-agents sequentially for a single proposition.
 * Sequential by default — avoids hammering Brave Search rate limits.
 * Returns the collected outputs keyed by agent name.
 *
 * In Part 2 this will aggregate real outputs; for now each agent returns null
 * since the stubs are placeholders only.
 *
 * @param {Object} context - Run context shared by all agents.
 * @returns {Promise<Object>} Map of agent_name → output (null in Part 1).
 */
async function runResearchAgents(context) {
  console.log('\n  Running research agents...');

  // Run agents sequentially to respect Brave Search rate limits (500ms between calls)
  const outputs = {};

  outputs.market_overview = await runMarketOverviewAgent(context);
  outputs.competitors      = await runCompetitorsAgent(context);
  outputs.regulatory       = await runRegulatoryAgent(context);
  outputs.production       = await runProductionAgent(context);
  outputs.packaging        = await runPackagingAgent(context);
  outputs.distribution     = await runDistributionAgent(context);
  outputs.marketing        = await runMarketingAgent(context);
  outputs.financials       = await runFinancialsAgent(context);
  outputs.origin_ops       = await runOriginOpsAgent(context);
  outputs.legal            = await runLegalAgent(context);

  return outputs;
}

// ---------------------------------------------------------------------------
// Assembler agent stub
// ---------------------------------------------------------------------------

/**
 * Runs the report assembler agent.
 * In Part 2 this will:
 *   1. Call Claude Sonnet with assemble_report.md + all 10 research outputs
 *   2. Produce the PDF content JSON at .tmp/<reportId>_content.json
 *   3. Spawn generate_report_pdf.py to build the branded PDF
 *   4. Upload the PDF to Supabase Storage and save the URL
 *   5. Email the PDF to the client via Resend
 *
 * @param {Object}  context       - Run context.
 * @param {Object}  agentOutputs  - Map of agent_name → research output.
 * @returns {Promise<string|null>} Path to the generated PDF, or null (stub).
 */
async function runAssemblerAgent(context, agentOutputs) {
  // TODO Part 2: Call Claude Sonnet with assemble_report.md + all research outputs
  console.log('\n  [stub] Assembler agent — skipped (Part 2)');
  return null;
}

// ---------------------------------------------------------------------------
// Quality gate stub
// ---------------------------------------------------------------------------

/**
 * Validates that all research agents produced usable output.
 * In Part 2 this will check:
 *   - All 10 agents produced non-null output
 *   - All 6 viability score factors are populated (non-null, 1–5 range)
 *   - No agent output is missing required fields
 *
 * Throws if validation fails so the run is marked failed rather than
 * silently delivering a broken report.
 *
 * @param {Object} agentOutputs - Map of agent_name → output.
 * @throws {Error} If any required agent output is missing or malformed.
 */
function checkQuality(agentOutputs) {
  // TODO Part 2: Validate all 10 agent outputs and 6 viability score factors
  // For now, skip validation since all agents are stubs returning null
  console.log('\n  [stub] Quality gate — skipped (Part 2)');
}

// ---------------------------------------------------------------------------
// Failure alerting
// ---------------------------------------------------------------------------

/**
 * Sends a failure alert email to Brendon when a report run fails.
 * Client is NOT notified of failures — internal only.
 * Non-fatal: logs a warning if the email itself fails rather than crashing.
 *
 * @param {Object}      proposition  - The proposition that failed.
 * @param {Object|null} report       - The report record (may be null if creation failed).
 * @param {Error}       err          - The error that caused the failure.
 */
async function sendFailureAlert(proposition, report, err) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1C3557; padding: 24px 32px;">
        <h1 style="color: #C8A94A; font-size: 22px; margin: 0;">McKeever Consulting</h1>
        <p style="color: #8A9BB0; font-size: 13px; margin: 4px 0 0;">Report Run Failed</p>
      </div>

      <div style="padding: 32px; background: #F7F8FA; border: 1px solid #e0e0e0;">
        <h2 style="color: #c0392b; margin-top: 0;">&#x26A0; Report generation failed</h2>

        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; color: #555; width: 160px;"><strong>Proposition</strong></td>
              <td>${proposition.title}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Proposition ID</strong></td>
              <td style="font-size: 12px; color: #888;">${proposition.id}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Report ID</strong></td>
              <td style="font-size: 12px; color: #888;">${report ? report.id : 'not created'}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Time</strong></td>
              <td>${new Date().toISOString()}</td></tr>
        </table>

        <div style="background: #fdecea; border-left: 4px solid #c0392b; padding: 16px 20px; margin: 24px 0;">
          <p style="margin: 0 0 8px; font-weight: bold; color: #c0392b;">Error</p>
          <pre style="margin: 0; font-size: 12px; white-space: pre-wrap; color: #333;">${err.message}</pre>
        </div>

        <p style="color: #555; font-size: 13px;">
          To retry this run manually:<br>
          <code style="background: #eee; padding: 4px 8px; border-radius: 3px;">
            node run.js --proposition-id ${proposition.id} --force
          </code>
        </p>
      </div>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      [ADMIN_EMAIL],
        subject: `[FAILED] Report run — ${proposition.title}`,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`  Warning: failure alert email itself failed: ${res.status} ${body}`);
    }
  } catch (emailErr) {
    // Don't let email failure mask the original error
    console.warn(`  Warning: could not send failure alert email: ${emailErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Single proposition run
// ---------------------------------------------------------------------------

/**
 * Executes the full report pipeline for one proposition.
 * Handles its own errors — a failure here marks that report as failed
 * and sends a Brendon alert, but does NOT crash the overall run loop
 * (other due propositions will still be processed).
 *
 * @param {Object} proposition - The proposition row to run.
 * @param {boolean} force      - True if this was triggered on demand.
 */
async function runProposition(proposition, force) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Proposition: ${proposition.title}`);
  console.log(`ID:          ${proposition.id}`);
  console.log(`Type:        ${proposition.proposition_type}`);
  console.log(`Plan:        ${proposition.plan_tier}`);

  let report = null;

  try {
    // 1. Fetch the client (needed for email delivery in Part 2)
    const client = await getClientById(proposition.client_id);
    console.log(`Client:      ${client.name} <${client.email}>`);

    // 2. Create the report record in Supabase
    report = await createReportRecord(proposition);

    // 3. Mark the report as running
    await updateReportStatus(report.id, 'running');
    console.log('✓ Report status → running');

    // 4. Build the run context — passed to every agent
    const context = {
      reportId:         report.id,
      proposition,
      client,
      runNumber:        report.run_number,
      previousReportId: report.previous_report_id,
    };

    // 5. Run all 10 research sub-agents
    const agentOutputs = await runResearchAgents(context);

    // 6. Quality gate — validates all agent outputs before assembly
    checkQuality(agentOutputs);

    // 7. Run the assembler (builds PDF, uploads to Storage, emails client)
    // pdfPath is null in Part 1 since the assembler is a stub
    const pdfPath = await runAssemblerAgent(context, agentOutputs);

    // 8. Mark report complete
    // In Part 2 the assembler handles this after email delivery —
    // kept here for now so Part 1 runs cleanly end-to-end
    await updateReportStatus(report.id, 'complete');
    console.log('✓ Report status → complete');

    // 9. Advance the schedule so this proposition isn't picked up again immediately
    // Skip for on_demand plans — no recurring schedule to advance
    if (proposition.schedule_type && proposition.schedule_type !== 'on_demand') {
      await advancePropositionSchedule(
        proposition.id,
        proposition.schedule_type,
        proposition.schedule_day,
      );
      console.log('✓ Proposition schedule advanced');
    }

    console.log(`\n✓ Run complete — Report ID: ${report.id}`);

  } catch (err) {
    // Mark the report as failed (if it was created before the error)
    console.error(`\n✗ Run failed: ${err.message}`);

    if (report) {
      try {
        await updateReportError(report.id, err.message);
        console.error(`  Report ${report.id} marked as failed.`);
      } catch (dbErr) {
        // Don't let the DB write failure mask the original error
        console.error(`  Warning: could not mark report as failed in DB: ${dbErr.message}`);
      }
    }

    // Send failure alert email to Brendon
    await sendFailureAlert(proposition, report, err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Parses args, determines which propositions to run,
 * and calls runProposition() for each one.
 *
 * Exits with code 1 only on fatal infrastructure failures (e.g. can't
 * load the target proposition). Individual proposition failures are
 * caught inside runProposition() and don't abort the loop.
 */
async function main() {
  console.log('McKeever Consulting — Report Orchestrator');
  console.log(`Started: ${new Date().toISOString()}`);

  const args = parseArgs();

  // Determine which propositions to process
  let propositions;
  try {
    propositions = await getPropositionsToRun(args);
  } catch (err) {
    console.error(`\nFatal: could not load propositions — ${err.message}`);
    process.exit(1);
  }

  if (propositions.length === 0) {
    // Nothing to do — exit cleanly (this is not an error)
    process.exit(0);
  }

  // Process each proposition — failures are isolated, not fatal
  for (const proposition of propositions) {
    await runProposition(proposition, args.force);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Finished: ${new Date().toISOString()}`);
  console.log(`Processed: ${propositions.length} proposition(s)`);
}

main().catch(err => {
  // Unhandled top-level error — should never reach here in normal operation
  console.error('\nFatal unhandled error:', err.message);
  process.exit(1);
});
