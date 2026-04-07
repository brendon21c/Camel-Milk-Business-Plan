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

// ---------------------------------------------------------------------------
// Agent Outputs
// ---------------------------------------------------------------------------

/**
 * Saves the output produced by a single research sub-agent.
 * Each agent handles one workflow area (e.g. competitor analysis, regulatory)
 * and writes its findings here so the assembly agent can pull them together.
 * @param {Object} data - Fields matching the `agent_outputs` table schema.
 *   Expected keys: report_id, agent_name, output (text/JSON), status.
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
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createClient,
  createProposition,
  createReport,
  updateReportStatus,
  saveAgentOutput,
  getAgentOutputsByReportId,
  getCachedApiResponse,
  setCachedApiResponse,
  saveReportSource,
};
