// db.js — Database access layer for the Camel Milk Business Plan system.
// All Supabase queries live here so the rest of the codebase never touches
// the client directly. Each function throws a descriptive error on failure
// so callers can surface the problem without parsing raw Supabase error objects.

const { supabase } = require('./supabaseClient');

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Creates a new client record.
 * A "client" is the person or organisation commissioning the report.
 * @param {Object} data - Fields matching the `clients` table schema.
 * @returns {Object} The inserted row.
 */
async function createClient(data) {
  const { data: row, error } = await supabase
    .from('clients')
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`createClient failed: ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/**
 * Creates a new organization record.
 * An "organization" is a company or entity that can have multiple client contacts.
 * Admins are managed separately via addOrganizationAdmin().
 * @param {Object} data - Fields matching the `organizations` table schema (name).
 * @returns {Object} The inserted row.
 */
async function createOrganization(data) {
  const { data: row, error } = await supabase
    .from('organizations')
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`createOrganization failed: ${error.message}`);
  return row;
}

/**
 * Returns all admins for a given organization.
 * Admin records are independent of the clients table — removing someone as a client
 * does not affect their admin status.
 * @param {string} organizationId - Primary key of the organization.
 * @returns {Array} Array of organization_admins rows (email, name, created_at).
 */
async function getOrganizationAdmins(organizationId) {
  const { data: rows, error } = await supabase
    .from('organization_admins')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getOrganizationAdmins failed for org ${organizationId}: ${error.message}`);
  return rows;
}

/**
 * Adds an admin to an organization.
 * Uses upsert so calling it twice for the same email is safe.
 * @param {string} organizationId - Primary key of the organization.
 * @param {string} email          - Admin's email address.
 * @param {string} [name]         - Admin's display name (optional).
 * @returns {Object} The upserted row.
 */
async function addOrganizationAdmin(organizationId, email, name) {
  const { data: row, error } = await supabase
    .from('organization_admins')
    .upsert(
      { organization_id: organizationId, email, name: name || null },
      { onConflict: 'organization_id,email' }
    )
    .select()
    .single();

  if (error) throw new Error(`addOrganizationAdmin failed for org ${organizationId}, email ${email}: ${error.message}`);
  return row;
}

/**
 * Fetches all client contacts belonging to a given organization.
 * Used when you need to reach every point of contact at a company —
 * e.g. sending reports or proposals to multiple people.
 * @param {string} organizationId - Primary key of the organization.
 * @returns {Array} Array of client rows for that organization.
 */
async function getClientsByOrganizationId(organizationId) {
  const { data: rows, error } = await supabase
    .from('clients')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getClientsByOrganizationId failed for org ${organizationId}: ${error.message}`);
  return rows;
}

// ---------------------------------------------------------------------------
// Propositions
// ---------------------------------------------------------------------------

/**
 * Creates a new proposition record.
 * A "proposition" is a research focus area or hypothesis that a report
 * will investigate (e.g. "Is the US camel milk market viable in 2026?").
 *
 * Schema fields:
 *   organization_id — FK to organizations; the company that owns this proposition
 *   client_id       — FK to clients; the primary contact who receives report emails
 *   title, description, industry, product_type,
 *   origin_country, target_country, target_demographic,
 *   estimated_budget, additional_context,
 *   schedule_type ('monthly'|'weekly'|'quarterly'|'on_demand') — default 'monthly'
 *   schedule_day (1-28, day of month for monthly runs) — default 1
 *   next_run_at (timestamptz) — when the next automated run should fire
 *   last_run_at (timestamptz) — when the last run completed
 *
 * @param {Object} data - Fields matching the `propositions` table schema.
 * @returns {Object} The inserted row.
 */
async function createProposition(data) {
  const { data: row, error } = await supabase
    .from('propositions')
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`createProposition failed: ${error.message}`);
  return row;
}

/**
 * Updates the schedule settings for a proposition.
 * Used when a client changes their preferred delivery frequency.
 * @param {string} propositionId - Primary key of the proposition to update.
 * @param {Object} schedule - Schedule fields to update.
 *   @param {string} schedule.schedule_type - 'monthly'|'weekly'|'quarterly'|'on_demand'
 *   @param {number} schedule.schedule_day  - Day of month (1-28) for monthly runs.
 *   @param {string} schedule.next_run_at   - ISO timestamp for the next run.
 * @returns {Object} The updated row.
 */
async function updatePropositionSchedule(propositionId, schedule) {
  const { data: row, error } = await supabase
    .from('propositions')
    .update(schedule)
    .eq('id', propositionId)
    .select()
    .single();

  if (error) throw new Error(`updatePropositionSchedule failed for proposition ${propositionId}: ${error.message}`);
  return row;
}

/**
 * Returns all propositions whose next_run_at is due (i.e. <= now),
 * restricted to propositions whose owning organization is 'active'.
 * Flipping an org to 'inactive' or 'cancelled' immediately halts their reports.
 * Called by the orchestrator on a schedule to find what needs to run.
 * Only returns propositions where schedule_type is not 'on_demand'.
 * @returns {Array} Array of proposition rows ready to be run.
 */
async function getDuePropositions() {
  // Join to organizations so we can gate on org status in one query.
  // Propositions without an organization_id (legacy data) are excluded — they
  // cannot be validated as 'active' and should not run automatically.
  const { data: rows, error } = await supabase
    .from('propositions')
    .select('*, organizations!inner(status)')
    .neq('schedule_type', 'on_demand')
    .lte('next_run_at', new Date().toISOString())
    .eq('organizations.status', 'active');

  if (error) throw new Error(`getDuePropositions failed: ${error.message}`);

  // Strip the nested organizations object — callers expect plain proposition rows
  return rows.map(({ organizations: _org, ...proposition }) => proposition);
}

/**
 * Marks a proposition's last_run_at as now and either advances next_run_at
 * (retainer) or flips schedule_type to 'on_demand' (starter/pro) once the
 * plan's included run count is exhausted.
 *
 * Plan run limits:
 *   starter  — 1 run total  → on_demand after run 1
 *   pro      — 2 runs total → on_demand after run 2
 *   retainer — unlimited    → always advances next_run_at
 *
 * Called by the orchestrator after a report run completes successfully.
 * @param {string} propositionId - Primary key of the proposition.
 * @param {string} scheduleType  - 'monthly'|'weekly'|'quarterly'
 * @param {number} scheduleDay   - Day of month for monthly cadence.
 * @returns {Object} The updated proposition row.
 */
async function advancePropositionSchedule(propositionId, scheduleType, scheduleDay) {
  // Fetch plan_tier and count of completed reports for this proposition.
  // We need both to decide whether to advance or retire the schedule.
  const [propResult, countResult] = await Promise.all([
    supabase
      .from('propositions')
      .select('plan_tier')
      .eq('id', propositionId)
      .single(),
    supabase
      .from('reports')
      .select('*', { count: 'exact', head: true })
      .eq('proposition_id', propositionId)
      .eq('status', 'complete'),
  ]);

  if (propResult.error) throw new Error(`advancePropositionSchedule: could not fetch plan_tier: ${propResult.error.message}`);
  if (countResult.error) throw new Error(`advancePropositionSchedule: could not count reports: ${countResult.error.message}`);

  const planTier   = propResult.data.plan_tier;
  const runCount   = countResult.count ?? 0;

  // Determine run limit for this plan tier
  const RUN_LIMITS = { starter: 1, pro: 2, retainer: Infinity };
  const limit = RUN_LIMITS[planTier] ?? Infinity;

  const now = new Date();

  if (runCount >= limit) {
    // Plan exhausted — retire the schedule so it never auto-runs again.
    // The proposition and org stay active; Brendon can manually re-run or upsell.
    console.log(`  Plan limit reached (${planTier}: ${runCount}/${limit} runs) — retiring schedule to on_demand`);

    const { data: row, error } = await supabase
      .from('propositions')
      .update({
        schedule_type: 'on_demand',
        last_run_at:   now.toISOString(),
      })
      .eq('id', propositionId)
      .select()
      .single();

    if (error) throw new Error(`advancePropositionSchedule failed for proposition ${propositionId}: ${error.message}`);
    return row;
  }

  // Plan still has runs remaining — advance next_run_at to the next cycle
  let nextRun;
  if (scheduleType === 'monthly') {
    nextRun = new Date(now.getFullYear(), now.getMonth() + 1, scheduleDay);
  } else if (scheduleType === 'weekly') {
    nextRun = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  } else if (scheduleType === 'quarterly') {
    nextRun = new Date(now.getFullYear(), now.getMonth() + 3, scheduleDay);
  }

  const { data: row, error } = await supabase
    .from('propositions')
    .update({
      last_run_at: now.toISOString(),
      next_run_at: nextRun.toISOString(),
    })
    .eq('id', propositionId)
    .select()
    .single();

  if (error) throw new Error(`advancePropositionSchedule failed for proposition ${propositionId}: ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Creates a new report record.
 * Reports track the full lifecycle of a single research run — from kick-off
 * through agent execution to PDF generation and delivery.
 * @param {Object} data - Fields matching the `reports` table schema.
 * @returns {Object} The inserted row.
 */
async function createReport(data) {
  const { data: row, error } = await supabase
    .from('reports')
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`createReport failed: ${error.message}`);
  return row;
}

/**
 * Updates the status field of an existing report.
 * Expected status values: 'pending' | 'running' | 'complete' | 'failed'
 * @param {string|number} reportId - Primary key of the report to update.
 * @param {string} status - The new status value.
 * @returns {Object} The updated row.
 */
async function updateReportStatus(reportId, status) {
  const { data: row, error } = await supabase
    .from('reports')
    .update({ status })
    .eq('id', reportId)
    .select()
    .single();

  if (error) throw new Error(`updateReportStatus failed for report ${reportId}: ${error.message}`);
  return row;
}

/**
 * Saves the Supabase Storage signed URL for a completed report PDF.
 * Called by the assembler after the PDF is uploaded to the `reports` bucket.
 * The signed URL is attached to the email so the client can access the file.
 * @param {string} reportId - Primary key of the report.
 * @param {string} pdfUrl   - Signed Supabase Storage URL (7-day TTL).
 * @returns {Object} The updated row.
 */
async function updateReportPdfUrl(reportId, pdfUrl) {
  const { data: row, error } = await supabase
    .from('reports')
    .update({ pdf_url: pdfUrl })
    .eq('id', reportId)
    .select()
    .single();

  if (error) throw new Error(`updateReportPdfUrl failed for report ${reportId}: ${error.message}`);
  return row;
}

/**
 * Marks a report as failed and records the error message.
 * Sets status to 'failed' and writes the error detail to error_message in one call
 * so the failure is always fully recorded even if the status update is the last thing done.
 * Called by the assembler quality gate and any post-gate step that fails unrecoverably.
 * @param {string} reportId     - Primary key of the report.
 * @param {string} errorMessage - Description of what failed and why.
 * @returns {Object} The updated row.
 */
async function updateReportError(reportId, errorMessage) {
  const { data: row, error } = await supabase
    .from('reports')
    .update({ status: 'failed', error_message: errorMessage })
    .eq('id', reportId)
    .select()
    .single();

  if (error) throw new Error(`updateReportError failed for report ${reportId}: ${error.message}`);
  return row;
}

/**
 * Fetches a single report by its primary key.
 * Used by the orchestrator to check the current state of a specific report
 * and by the assembler to retrieve context when building the "What Changed" section.
 * @param {string} reportId - Primary key of the report.
 * @returns {Object} The report row.
 */
async function getReportById(reportId) {
  const { data: row, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .single();

  if (error) throw new Error(`getReportById failed for report ${reportId}: ${error.message}`);
  return row;
}

/**
 * Fetches all reports for a given proposition, ordered newest-first.
 * Used by the orchestrator to determine the run_number (count + 1) and
 * the previous_report_id (the most recent completed report) before starting a new run.
 * @param {string} propositionId - Primary key of the proposition.
 * @returns {Array} Array of report rows, newest first.
 */
async function getReportsByPropositionId(propositionId) {
  const { data: rows, error } = await supabase
    .from('reports')
    .select('*')
    .eq('proposition_id', propositionId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getReportsByPropositionId failed for proposition ${propositionId}: ${error.message}`);
  return rows;
}

/**
 * Fetches a single proposition by its primary key.
 * Used by the orchestrator to load proposition details (product, countries,
 * factor_weights, schedule) when running a specific proposition on demand.
 * @param {string} propositionId - Primary key of the proposition.
 * @returns {Object} The proposition row.
 */
async function getPropositionById(propositionId) {
  const { data: row, error } = await supabase
    .from('propositions')
    .select('*')
    .eq('id', propositionId)
    .single();

  if (error) throw new Error(`getPropositionById failed for proposition ${propositionId}: ${error.message}`);
  return row;
}

/**
 * Fetches a single client by their primary key.
 * Used by the orchestrator and assembler to get the client's name and email
 * for the report email delivery step.
 * @param {string} clientId - Primary key of the client.
 * @returns {Object} The client row.
 */
async function getClientById(clientId) {
  const { data: row, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error) throw new Error(`getClientById failed for client ${clientId}: ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Proposition Recipients
// ---------------------------------------------------------------------------

/**
 * Returns all clients who are configured to receive reports for a given proposition.
 * Used by the assembler to build the recipient list for email delivery.
 * Returns full client rows (not just IDs) so callers have name + email ready.
 * @param {string} propositionId - Primary key of the proposition.
 * @returns {Array} Array of client rows, ordered by when they were added as recipients.
 */
async function getPropositionRecipients(propositionId) {
  const { data: rows, error } = await supabase
    .from('proposition_recipients')
    .select('clients(*)')
    .eq('proposition_id', propositionId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getPropositionRecipients failed for proposition ${propositionId}: ${error.message}`);

  // Unwrap the nested join — each row is { clients: { ...clientRow } }
  return rows.map(r => r.clients);
}

/**
 * Adds a client as a recipient for a proposition.
 * Uses upsert so calling it twice for the same pair is safe.
 * @param {string} propositionId - Primary key of the proposition.
 * @param {string} clientId      - Primary key of the client to add.
 * @returns {Object} The upserted row.
 */
async function addPropositionRecipient(propositionId, clientId) {
  const { data: row, error } = await supabase
    .from('proposition_recipients')
    .upsert({ proposition_id: propositionId, client_id: clientId }, { onConflict: 'proposition_id,client_id' })
    .select()
    .single();

  if (error) throw new Error(`addPropositionRecipient failed for proposition ${propositionId}, client ${clientId}: ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Agent Outputs
// ---------------------------------------------------------------------------

/**
 * Saves the output produced by a single research sub-agent.
 * Each agent handles one workflow area (e.g. competitor analysis, regulatory)
 * and writes its findings here so the assembly agent can pull them together.
 * @param {Object} data - Fields matching the `agent_outputs` table schema.
 *   Expected keys: report_id, agent_name, output_data (JSONB), status.
 * @returns {Object} The inserted row.
 */
async function saveAgentOutput(data) {
  const { data: row, error } = await supabase
    .from('agent_outputs')
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`saveAgentOutput failed: ${error.message}`);
  return row;
}

/**
 * Retrieves all agent outputs associated with a given report.
 * Used by the assembly agent to collect every research section before
 * building the final PDF.
 * @param {string|number} reportId - The report to fetch outputs for.
 * @returns {Array} Array of agent_output rows, ordered by creation time.
 */
async function getAgentOutputsByReportId(reportId) {
  const { data: rows, error } = await supabase
    .from('agent_outputs')
    .select('*')
    .eq('report_id', reportId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getAgentOutputsByReportId failed for report ${reportId}: ${error.message}`);
  return rows;
}

// ---------------------------------------------------------------------------
// API Response Cache
// ---------------------------------------------------------------------------

/**
 * Looks up a previously cached API response by its cache key.
 * Prevents redundant API calls across report runs for data that hasn't
 * changed (e.g. regulatory text, supplier pricing).
 * Returns null when no cached entry exists — callers should treat null
 * as a cache miss and fetch fresh data.
 * @param {string} cacheKey - Unique identifier for the cached response.
 * @returns {Object|null} The cached row, or null on a cache miss.
 */
async function getCachedApiResponse(cacheKey) {
  const { data: row, error } = await supabase
    .from('api_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .maybeSingle(); // returns null instead of error when no row found

  if (error) throw new Error(`getCachedApiResponse failed for key "${cacheKey}": ${error.message}`);
  return row; // null on miss, row object on hit
}

/**
 * Inserts or updates a cached API response.
 * Uses upsert so the same cache key can be refreshed without a separate
 * delete step. The `cache_key` column must have a unique constraint in
 * the database for upsert to resolve conflicts correctly.
 * @param {string} cacheKey - Unique identifier for this cache entry.
 * @param {*} responseData - The data to cache (will be stored as JSON).
 * @returns {Object} The upserted row.
 */
async function setCachedApiResponse(cacheKey, responseData) {
  const { data: row, error } = await supabase
    .from('api_cache')
    .upsert(
      { cache_key: cacheKey, response_data: responseData, cached_at: new Date().toISOString() },
      { onConflict: 'cache_key' }
    )
    .select()
    .single();

  if (error) throw new Error(`setCachedApiResponse failed for key "${cacheKey}": ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Report Sources
// ---------------------------------------------------------------------------

/**
 * Saves a source citation associated with a report.
 * Sources are URLs, documents, or data references that agents used during
 * research — stored so the final report can include a references section
 * and so claims can be audited after the fact.
 * @param {Object} data - Fields matching the `report_sources` table schema.
 *   Expected keys: report_id, url, title, agent_name, retrieved_at.
 * @returns {Object} The inserted row.
 */
async function saveReportSource(data) {
  const { data: row, error } = await supabase
    .from('report_sources')
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`saveReportSource failed: ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Proposition Context
// ---------------------------------------------------------------------------

/**
 * Returns all admin-entered context notes for a proposition, grouped by category.
 * These are enrichment entries added via the admin panel's Context Panel —
 * they represent scope adjustments, sourcing details, or additional context
 * that the next research run should factor in.
 *
 * Example: { sourcing: ["Milk processed in Kenya before export to US"], regulatory: [...] }
 *
 * Empty categories are omitted. Returns an empty object if no notes exist.
 * Uses the service key — this table has RLS enabled (anon key is blocked).
 *
 * @param {string} propositionId - Primary key of the proposition.
 * @returns {Object} Map of category → array of note strings.
 */
async function getPropositionContext(propositionId) {
  const { data: rows, error } = await supabase
    .from('proposition_context')
    .select('category, content')
    .eq('proposition_id', propositionId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getPropositionContext failed for proposition ${propositionId}: ${error.message}`);
  if (!rows || rows.length === 0) return {};

  // Group content strings by their category key
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push(row.content);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

/**
 * Deletes all agent_outputs rows for a given report.
 * Called immediately after the assembler completes — these rows are only
 * needed during the research-to-assembly window. Keeping them wastes storage
 * (each row is a large JSONB blob; 10 per run × many runs = significant growth).
 * @param {string} reportId - Primary key of the completed report.
 */
async function deleteAgentOutputsByReportId(reportId) {
  const { error } = await supabase
    .from('agent_outputs')
    .delete()
    .eq('report_id', reportId);

  if (error) throw new Error(`deleteAgentOutputsByReportId failed for report ${reportId}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * Updates the status of a client record.
 * Valid values: 'prospect' | 'active' | 'inactive'
 * @param {string} clientId - Primary key of the client.
 * @param {string} status   - New status value.
 * @returns {Object} The updated row.
 */
async function updateClientStatus(clientId, status) {
  const { data: row, error } = await supabase
    .from('clients')
    .update({ status })
    .eq('id', clientId)
    .select()
    .single();

  if (error) throw new Error(`updateClientStatus failed for client ${clientId}: ${error.message}`);
  return row;
}

/**
 * Activates a proposition — flips status to 'active' and sets the initial schedule.
 * Called by activate.js after the client has signed and paid.
 * @param {string} propositionId - Primary key of the proposition.
 * @param {Object} data          - Fields to update (status, schedule_type, schedule_day, next_run_at).
 * @returns {Object} The updated row.
 */
async function activateProposition(propositionId, data) {
  const { data: row, error } = await supabase
    .from('propositions')
    .update(data)
    .eq('id', propositionId)
    .select()
    .single();

  if (error) throw new Error(`activateProposition failed for proposition ${propositionId}: ${error.message}`);
  return row;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Organizations
  createOrganization,
  getOrganizationAdmins,
  addOrganizationAdmin,
  getClientsByOrganizationId,

  // Clients
  createClient,
  getClientById,
  updateClientStatus,

  // Propositions
  createProposition,
  getPropositionById,
  updatePropositionSchedule,
  activateProposition,
  getDuePropositions,
  advancePropositionSchedule,

  // Reports
  createReport,
  getReportById,
  getReportsByPropositionId,
  updateReportStatus,
  updateReportPdfUrl,
  updateReportError,

  // Proposition recipients
  getPropositionRecipients,
  addPropositionRecipient,

  // Agent outputs
  saveAgentOutput,
  getAgentOutputsByReportId,

  // Sources
  saveReportSource,

  // Cache
  getCachedApiResponse,
  setCachedApiResponse,

  // Proposition context
  getPropositionContext,

  // Cleanup
  deleteAgentOutputsByReportId,
};
