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
// Propositions
// ---------------------------------------------------------------------------

/**
 * Creates a new proposition record.
 * A "proposition" is a research focus area or hypothesis that a report
 * will investigate (e.g. "Is the US camel milk market viable in 2026?").
 *
 * Schema fields:
 *   client_id, title, description, industry, product_type,
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
 * Returns all propositions whose next_run_at is due (i.e. <= now).
 * Called by the orchestrator on a schedule to find what needs to run.
 * Only returns propositions where schedule_type is not 'on_demand'.
 * @returns {Array} Array of proposition rows ready to be run.
 */
async function getDuePropositions() {
  const { data: rows, error } = await supabase
    .from('propositions')
    .select('*')
    .neq('schedule_type', 'on_demand')
    .lte('next_run_at', new Date().toISOString());

  if (error) throw new Error(`getDuePropositions failed: ${error.message}`);
  return rows;
}

/**
 * Marks a proposition's last_run_at as now and advances next_run_at
 * based on its schedule_type and schedule_day.
 * Called by the orchestrator after a report run completes successfully.
 * @param {string} propositionId - Primary key of the proposition.
 * @param {string} scheduleType  - 'monthly'|'weekly'|'quarterly'
 * @param {number} scheduleDay   - Day of month for monthly cadence.
 * @returns {Object} The updated row.
 */
async function advancePropositionSchedule(propositionId, scheduleType, scheduleDay) {
  // Calculate the next run timestamp based on schedule type
  const now = new Date();
  let nextRun;

  if (scheduleType === 'monthly') {
    // Advance to the same day next month
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

  // Agent outputs
  saveAgentOutput,
  getAgentOutputsByReportId,

  // Sources
  saveReportSource,

  // Cache
  getCachedApiResponse,
  setCachedApiResponse,

  // Cleanup
  deleteAgentOutputsByReportId,
};
