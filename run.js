/**
 * run.js — Main orchestrator for the McKeever Consulting report pipeline.
 *
 * Determines which propositions need a report run, creates the report record
 * in Supabase, coordinates all research sub-agents via Claude Haiku (tool-use),
 * triggers the assembler (Claude Sonnet), uploads the PDF to Storage,
 * and delivers it to the client by email.
 *
 * Usage:
 *   # Run all scheduled (due) propositions
 *   node run.js
 *
 *   # Run a specific proposition on demand (bypasses next_run_at check)
 *   node run.js --proposition-id <uuid> --force
 *
 *   # Regenerate the PDF for an existing completed report (no agents, no email)
 *   # Downloads the stored content JSON, rebuilds the PDF, saves to outputs/ for review
 *   node run.js --regen-pdf --report-id <uuid>
 *
 * Architecture (WAT framework):
 *   Workflows (instructions) → Agents (Claude — reasoning/synthesis)
 *   → Tools (Python scripts — deterministic execution)
 */

require('dotenv').config();

const Anthropic  = require('@anthropic-ai/sdk');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const {
  getPropositionById,
  getClientById,
  getDuePropositions,
  getReportsByPropositionId,
  getReportById,
  getAgentOutputsByReportId,
  createReport,
  updateReportStatus,
  updateReportPdfUrl,
  updateReportError,
  saveAgentOutput,
  saveReportSource,
  advancePropositionSchedule,
  deleteAgentOutputsByReportId,
  getPropositionRecipients,
} = require('./db');

// ---------------------------------------------------------------------------
// Clients & constants
// ---------------------------------------------------------------------------

// Anthropic client — long timeout for the assembler's large Sonnet call.
// maxRetries: 6 gives the SDK up to ~2 minutes of exponential backoff on 429
// rate limit errors before giving up. This handles burst exhaustion between agents.
const anthropic = new Anthropic({
  apiKey:     process.env.ANTHROPIC_API_KEY,
  timeout:    600_000, // 10 minutes — assembler can produce ~30k tokens
  maxRetries: 6,       // 429 rate limit backoff — default is 2, not enough for 50k TPM limit
});

// Supabase client for Storage uploads (separate from the db.js client)
const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Admin email receives failure alerts; client never sees failures
const ADMIN_EMAIL = 'brennon.mckeever@gmail.com';
const FROM_EMAIL  = 'McKeever Consulting <reports@mckeeverconsulting.org>';

// Research agent names — must match workflow filenames (research_<name>.md)
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

// Critical agents — failure of any = hard fail (report not delivered)
const CRITICAL_AGENTS = new Set([
  'market_overview',
  'regulatory',
  'financials',
  'origin_ops',
]);

// Python executable — prefer venv if present
const VENV_PYTHON = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
const PYTHON      = fs.existsSync(VENV_PYTHON) ? `"${VENV_PYTHON}"` : 'python';

// ---------------------------------------------------------------------------
// Tool definitions for Claude research agents
// ---------------------------------------------------------------------------
// These tools map 1:1 to the Python scripts in tools/. Claude Haiku calls
// them when executing a research workflow; we execute the Python scripts
// and return results back into the conversation.

const RESEARCH_TOOLS = [
  {
    name:        'web_search',
    description: 'Search the web using Brave Search. Use this for market research, competitor data, regulatory information, price discovery, and any web-based research. Implements caching (24h default TTL) and rate limiting automatically.',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string',  description: 'Search query string' },
        count:     { type: 'integer', description: 'Number of results to return (max 20, default 10)', default: 10 },
        freshness: { type: 'integer', description: 'Cache TTL in hours (default 24)', default: 24 },
      },
      required: ['query'],
    },
  },
  {
    name:        'fetch_fda_data',
    description: 'Fetch FDA food enforcement (recalls) and adverse event data from openFDA. Use for regulatory research, product safety history, and recall risk assessment.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', enum: ['food_enforcement', 'food_event'],
                    description: 'food_enforcement = recalls/enforcement actions; food_event = consumer adverse events' },
        search:   { type: 'string', description: 'Product or ingredient search term (e.g. "camel milk")' },
        limit:    { type: 'integer', description: 'Max results (default 10, max 100)', default: 10 },
      },
      required: ['endpoint', 'search'],
    },
  },
  {
    name:        'fetch_usda_data',
    description: 'Fetch USDA food and agricultural data. FDC gives nutritional composition (useful for health claims); NASS gives agricultural production statistics.',
    input_schema: {
      type: 'object',
      properties: {
        source:    { type: 'string', enum: ['fdc', 'nass'],
                     description: 'fdc = FoodData Central (nutritional); nass = QuickStats (agricultural production)' },
        query:     { type: 'string', description: 'Search query (FDC only) — e.g. "camel milk powder"' },
        commodity: { type: 'string', description: 'Commodity name (NASS only) — e.g. "MILK", "CATTLE"' },
        limit:     { type: 'integer', default: 5 },
      },
      required: ['source'],
    },
  },
  {
    name:        'fetch_census_data',
    description: 'Fetch US Census Bureau data. ACS5 gives demographic market profiles (population, income, education). CBP gives industry establishment counts and payroll benchmarks.',
    input_schema: {
      type: 'object',
      properties: {
        dataset:   { type: 'string', enum: ['acs5', 'cbp'],
                     description: 'acs5 = American Community Survey demographics; cbp = County Business Patterns (industry sizing)' },
        geography: { type: 'string', description: 'Geography scope (default: "us:1" for national)', default: 'us:1' },
        naics:     { type: 'string', description: 'NAICS code for CBP (e.g. "311" = food mfg, "31151" = dairy mfg)' },
        year:      { type: 'integer', description: 'Data year (ACS5 default: 2022; CBP default: 2021)' },
      },
      required: ['dataset'],
    },
  },
  {
    name:        'fetch_usaspending_data',
    description: 'Fetch US federal contract and grant spending data from USASpending.gov. Useful for finding government procurement in an industry and identifying grant opportunities.',
    input_schema: {
      type: 'object',
      properties: {
        command:     { type: 'string', enum: ['search', 'naics'],
                       description: 'search = keyword search; naics = spending by NAICS code' },
        keyword:     { type: 'string', description: 'Search keyword (search command only)' },
        award_type:  { type: 'string', enum: ['contracts', 'grants', 'all'], default: 'contracts' },
        naics_code:  { type: 'string', description: '6-digit NAICS code (naics command only)' },
        fiscal_year: { type: 'integer', description: 'Fiscal year filter (e.g. 2023)' },
        limit:       { type: 'integer', default: 10 },
      },
      required: ['command'],
    },
  },
  {
    name:        'fetch_sec_edgar',
    description: 'Fetch SEC EDGAR public company filing data. Search for companies in the industry via 10-K filings, look up a company\'s CIK, or fetch standardised financial facts (revenue, margins) for a specific public company.',
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['search', 'company', 'facts'],
                    description: 'search = full-text filing search; company = look up CIK by name; facts = fetch financial facts by CIK' },
        query:    { type: 'string', description: 'Search query (search command only)' },
        form:     { type: 'string', description: 'Form type filter (e.g. "10-K") (search command only)' },
        name:     { type: 'string', description: 'Company name to look up (company command only)' },
        cik:      { type: 'string', description: '10-digit CIK number (facts command only)' },
        concept:  { type: 'string', description: 'XBRL concept (facts command only — e.g. Revenues, GrossProfit)', default: 'Revenues' },
        limit:    { type: 'integer', default: 10 },
      },
      required: ['command'],
    },
  },
  {
    name:        'search_perplexity',
    description: 'Fallback search using Perplexity Sonar. Returns a synthesized answer with citations instead of raw web results. Use ONLY when web_search returns fewer than 3 useful results for a query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Research question to answer' },
        model: { type: 'string', enum: ['sonar', 'sonar-pro'], default: 'sonar' },
      },
      required: ['query'],
    },
  },
];

// ---------------------------------------------------------------------------
// Python tool execution
// ---------------------------------------------------------------------------

/**
 * Runs a Python tool script and returns the parsed JSON output.
 * All tools write JSON to stdout; we capture and parse it.
 * Throws if the script fails or output is not valid JSON.
 *
 * @param {string}   scriptPath - Relative path to the Python script.
 * @param {string[]} args       - CLI arguments array.
 * @returns {Object} Parsed JSON result from the script.
 */
function execPython(scriptPath, args) {
  // Quote args that contain spaces to prevent shell injection
  const safeArgs = args.map(a => {
    // Only quote string args that aren't flags (--flag) or look complex
    if (typeof a === 'string' && !a.startsWith('-') && a.includes(' ')) {
      return `"${a.replace(/"/g, '\\"')}"`;
    }
    return a;
  });

  const cmd = `${PYTHON} "${path.join(__dirname, scriptPath)}" ${safeArgs.join(' ')}`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout:  60_000, // 60s per tool call
      cwd:      __dirname,
    });
    return JSON.parse(output.trim());
  } catch (err) {
    // execSync throws on non-zero exit; err.stdout may still have useful data
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    const stderr = err.stderr ? err.stderr.toString().trim() : '';

    // If stdout has valid JSON despite the error, use it (some scripts exit 1
    // but still produce partial output that's useful)
    if (stdout) {
      try { return JSON.parse(stdout); } catch (_) { /* fall through */ }
    }

    throw new Error(`Tool ${scriptPath} failed: ${err.message}. stderr: ${stderr.slice(0, 200)}`);
  }
}

/**
 * Dispatches a tool call from Claude to the correct Python script.
 * Maps tool names to their Python implementations and argument shapes.
 *
 * @param {string} toolName - The tool name from Claude's tool_use block.
 * @param {Object} input    - The input object from Claude's tool_use block.
 * @returns {Object} Parsed JSON result.
 */
function executeTool(toolName, input) {
  switch (toolName) {

    case 'web_search':
      return execPython('tools/search_brave.py', [
        '--query',    input.query,
        '--count',    String(input.count    || 10),
        '--freshness', String(input.freshness || 24),
      ]);

    case 'fetch_fda_data':
      return execPython('tools/fetch_fda_data.py', [
        '--endpoint', input.endpoint,
        '--search',   input.search,
        '--limit',    String(input.limit || 10),
      ]);

    case 'fetch_usda_data': {
      if (input.source === 'fdc') {
        return execPython('tools/fetch_usda_data.py', [
          'fdc',
          '--query', input.query || '',
          '--limit', String(input.limit || 5),
        ]);
      } else {
        // NASS subcommand
        const nassArgs = ['nass', '--commodity', input.commodity || ''];
        if (input.year) nassArgs.push('--year', String(input.year));
        return execPython('tools/fetch_usda_data.py', nassArgs);
      }
    }

    case 'fetch_census_data': {
      if (input.dataset === 'acs5') {
        const acs5Args = ['acs5', '--geography', input.geography || 'us:1'];
        if (input.year) acs5Args.push('--year', String(input.year));
        return execPython('tools/fetch_census_data.py', acs5Args);
      } else {
        // CBP subcommand
        if (!input.naics) return { error: 'naics is required for CBP dataset' };
        const cbpArgs = ['cbp', '--naics', input.naics, '--geography', input.geography || 'us:1'];
        if (input.year) cbpArgs.push('--year', String(input.year));
        return execPython('tools/fetch_census_data.py', cbpArgs);
      }
    }

    case 'fetch_usaspending_data': {
      if (input.command === 'search') {
        const searchArgs = ['search', '--keyword', input.keyword || '', '--award-type', input.award_type || 'contracts', '--limit', String(input.limit || 10)];
        if (input.fiscal_year) searchArgs.push('--fiscal-year', String(input.fiscal_year));
        return execPython('tools/fetch_usaspending_data.py', searchArgs);
      } else {
        // naics subcommand
        return execPython('tools/fetch_usaspending_data.py', [
          'naics',
          '--code',        input.naics_code || '',
          '--fiscal-year', String(input.fiscal_year || 2023),
        ]);
      }
    }

    case 'fetch_sec_edgar': {
      if (input.command === 'search') {
        const edgarArgs = ['search', '--query', input.query || '', '--limit', String(input.limit || 10)];
        if (input.form) edgarArgs.push('--form', input.form);
        return execPython('tools/fetch_sec_edgar.py', edgarArgs);
      } else if (input.command === 'company') {
        return execPython('tools/fetch_sec_edgar.py', ['company', '--name', input.name || '']);
      } else {
        // facts subcommand
        return execPython('tools/fetch_sec_edgar.py', [
          'facts',
          '--cik',     input.cik     || '',
          '--concept', input.concept || 'Revenues',
        ]);
      }
    }

    case 'search_perplexity':
      return execPython('tools/search_perplexity.py', [
        '--query', input.query,
        '--model', input.model || 'sonar',
      ]);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// Claude API helpers
// ---------------------------------------------------------------------------

/**
 * Runs a Claude model in a tool-use loop until it produces a final text response.
 * Handles all agentic turns — calls tools, feeds results back, repeats until done.
 *
 * @param {Object}   opts
 * @param {string}   opts.model        - Anthropic model ID.
 * @param {string}   opts.system       - System prompt.
 * @param {string}   opts.userPrompt   - Initial user message.
 * @param {Array}    opts.tools        - Tool definitions (or empty array for no tools).
 * @param {number}   opts.maxTokens    - Max tokens per turn.
 * @param {number}   [opts.maxIter=40] - Max tool-use iterations before giving up.
 * @returns {Promise<string>} The final text content from the model's end_turn response.
 */
async function callClaude({ model, system, userPrompt, tools = [], maxTokens = 8096, maxIter = 40 }) {
  const messages = [{ role: 'user', content: userPrompt }];
  let iterations = 0;

  while (iterations < maxIter) {
    iterations++;

    const createParams = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
    };

    // Only pass tools if the caller provided them — avoids API errors when
    // calling the assembler which doesn't need tool access
    if (tools.length > 0) {
      createParams.tools = tools;
    }

    // Rate-limit handling — Anthropic enforces 50k input tokens/minute.
    // Agents with many tool calls accumulate large contexts and hit 429 mid-loop.
    // When that happens we wait 60s (resets the per-minute window) and retry
    // the same turn rather than escalating to a more expensive model.
    let response;
    let rateLimitAttempts = 0;
    while (true) {
      try {
        response = await anthropic.messages.create(createParams);
        break; // success — exit the retry loop
      } catch (apiErr) {
        const is429 = apiErr.status === 429 ||
          (apiErr.message && apiErr.message.includes('rate_limit_error'));
        if (is429 && rateLimitAttempts < 5) {
          rateLimitAttempts++;
          const waitSec = 60 * rateLimitAttempts; // 60s, 120s, 180s, 240s, 300s
          console.warn(`      ⚠ Rate limited (429) — waiting ${waitSec}s before retry ${rateLimitAttempts}/5...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        } else {
          throw apiErr; // not a 429, or retries exhausted — surface to caller
        }
      }
    }

    if (response.stop_reason === 'end_turn') {
      // Normal completion — extract text content
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock ? textBlock.text.trim() : '';
    }

    if (response.stop_reason === 'tool_use') {
      // Claude wants to call one or more tools — execute them all
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`      → tool: ${block.name}(${JSON.stringify(block.input).slice(0, 120)}...)`);

        let result;
        try {
          result = executeTool(block.name, block.input);
        } catch (err) {
          // Return the error as the tool result — Claude can decide how to handle it
          result = { error: err.message };
          console.warn(`        tool error: ${err.message.slice(0, 120)}`);
        }

        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason (max_tokens, stop_sequence, etc.)
    throw new Error(`Unexpected stop_reason "${response.stop_reason}" after ${iterations} iterations`);
  }

  throw new Error(`Claude agent exceeded max iterations (${maxIter}) — workflow may be too complex`);
}

/**
 * Robustly parses a JSON string that may be wrapped in markdown code fences.
 * Claude sometimes wraps JSON in ```json ... ``` despite being told not to.
 *
 * @param {string} raw - Raw text from Claude.
 * @returns {Object} Parsed JSON object.
 * @throws {Error} If no valid JSON can be extracted.
 */
function parseJSON(raw) {
  if (!raw) throw new Error('Empty response from Claude — cannot parse JSON');

  // Try direct parse first (ideal case — no markdown wrapping)
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }

  // Strip markdown code fences and try again
  const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(stripped); } catch (_) { /* fall through */ }

  // Last resort: find the first { ... } block in the response
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
  }

  throw new Error(`Could not parse JSON from Claude response. First 300 chars: ${raw.slice(0, 300)}`);
}

/**
 * Reads a workflow file from the workflows/ directory.
 * Throws with a clear error if the file is missing.
 *
 * @param {string} filename - Filename including .md extension.
 * @returns {string} Full workflow file content.
 */
function loadWorkflow(filename) {
  const filePath = path.join(__dirname, 'workflows', filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses CLI arguments from process.argv.
 * @returns {{ propositionId: string|undefined, force: boolean, regenPdf: boolean, reportId: string|undefined }}
 */
function parseArgs() {
  const args   = process.argv.slice(2);
  const result = { propositionId: undefined, force: false, regenPdf: false, reportId: undefined };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proposition-id' && args[i + 1]) {
      result.propositionId = args[++i];
    } else if (args[i] === '--force') {
      result.force = true;
    } else if (args[i] === '--regen-pdf') {
      result.regenPdf = true;
    } else if (args[i] === '--report-id' && args[i + 1]) {
      result.reportId = args[++i];
    }
  }

  if (result.force && !result.propositionId) {
    console.error('Error: --force requires --proposition-id <uuid>');
    process.exit(1);
  }

  if (result.regenPdf && !result.reportId) {
    console.error('Error: --regen-pdf requires --report-id <uuid>');
    process.exit(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Proposition selection
// ---------------------------------------------------------------------------

/**
 * Returns the list of propositions to run in this invocation.
 * @param {{ propositionId: string|undefined, force: boolean }} args
 * @returns {Promise<Object[]>}
 */
async function getPropositionsToRun(args) {
  if (args.propositionId && args.force) {
    console.log(`\nForce run requested for proposition: ${args.propositionId}`);
    const proposition = await getPropositionById(args.propositionId);
    return [proposition];
  }

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
 * Creates the report record in Supabase with run_number and previous_report_id.
 * @param {Object} proposition - Proposition row.
 * @returns {Promise<Object>} The new report row.
 */
async function createReportRecord(proposition) {
  const history  = await getReportsByPropositionId(proposition.id);
  // Count only completed runs — failed/crashed attempts don't count as real runs
  const runNumber = history.filter(r => r.status === 'complete').length + 1;

  // The most recent completed report is the baseline for "What Changed"
  const previousCompleted = history.find(r => r.status === 'complete');
  const previousReportId  = previousCompleted ? previousCompleted.id : null;

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
// Generic research agent runner
// ---------------------------------------------------------------------------

/**
 * Runs a single research agent by name.
 * Reads the corresponding workflow file, calls Claude Haiku with tool access,
 * parses the structured JSON output, saves it to the DB, and persists citations.
 *
 * This is the single function behind all 10 research agent stubs. The workflow
 * file is the complete instruction set — Claude reads and executes it.
 *
 * @param {string} agentName - Short name (e.g. 'market_overview').
 * @param {Object} context   - Run context (reportId, proposition, client, runNumber).
 * @returns {Promise<Object|null>} Parsed agent output, or null on failure.
 */
async function runResearchAgent(agentName, context, { sonnetOnly = false } = {}) {
  const workflowFile = `research_${agentName}.md`;
  console.log(`\n    Running ${agentName}...`);

  // Load the SOP for this agent
  const workflow = loadWorkflow(workflowFile);

  // Build the proposition context object the workflow expects
  const propositionContext = {
    report_id:          context.reportId,
    proposition_id:     context.proposition.id,
    product_type:       context.proposition.product_type,
    industry:           context.proposition.industry,
    origin_country:     context.proposition.origin_country  || null,
    target_country:     context.proposition.target_country,
    target_demographic: context.proposition.target_demographic || null,
    estimated_budget:   context.proposition.estimated_budget || null,
    current_year:       new Date().getFullYear().toString(),
  };

  const systemPrompt = `You are a research agent for McKeever Consulting's Business Viability Intelligence System.

Your role is to execute the workflow instructions provided and produce a structured JSON research report.

CRITICAL RULES:
1. You MUST use the provided tools to gather information — do NOT fabricate data or invent figures
2. Run ALL primary search queries listed in the workflow before synthesizing
3. If a primary query returns fewer than 3 useful results, run the corresponding fallback queries
4. For regulatory research: also query the FDA and USDA tools as instructed in the workflow
5. For market/financial research: also query Census and USASpending tools as instructed
6. Your FINAL response must be ONLY the JSON object from the workflow's "Output Format" section
7. Do not wrap the JSON in markdown code fences
8. Do not include any explanation, preamble, or text before or after the JSON
9. If a field cannot be populated due to thin data, use null and add to data_gaps — do not guess`;

  // Build optional briefing blocks — only included when Perplexity returned data.
  // These give agents venture-specific framing (which regulatory bodies apply,
  // which research dimensions matter) and current market awareness before they
  // start their tool calls. Agents use this to adapt their generic SOP to the
  // specific proposition — e.g. skip FDA/USDA for a solar-panel proposition.
  //
  // Capped at 500 chars each to prevent context overflow on data-heavy agents
  // (financials hit 211k tokens when full 2.5k briefs were injected).
  const MAX_BRIEF_CHARS = 500;
  const truncate = (str) => str.length > MAX_BRIEF_CHARS
    ? str.slice(0, MAX_BRIEF_CHARS) + '...'
    : str;

  const ventureBlock = context.ventureIntelligence
    ? `\n## VENTURE INTELLIGENCE BRIEF\n${truncate(context.ventureIntelligence)}\n\n` +
      `Use this brief to: prioritise relevant tools, skip agencies that don't apply ` +
      `to this venture type, and focus on the research dimensions that matter most.\n`
    : '';

  const landscapeBlock = context.landscapeBriefing
    ? `\n## CURRENT MARKET LANDSCAPE\n${truncate(context.landscapeBriefing)}\n\n` +
      `Factor recent developments from this brief into your analysis and flag anything ` +
      `time-sensitive (rule changes, new competitors, trade shifts) in your output.\n`
    : '';

  const userPrompt = `Execute this research workflow and produce the JSON output.

## WORKFLOW INSTRUCTIONS
${workflow}

## PROPOSITION CONTEXT
\`\`\`json
${JSON.stringify(propositionContext, null, 2)}
\`\`\`
${ventureBlock}${landscapeBlock}
Follow all steps in the workflow. Use the tools to run the required searches and data pulls.
Synthesize the results and respond with ONLY the JSON object from the Output Format section.`;

  // ---------------------------------------------------------------------------
  // Model escalation helper — per CLAUDE.md: start Fast (Haiku), escalate to
  // Balanced (Sonnet) only if results are poor. Ceiling is Sonnet — Opus is
  // reserved for tasks requiring deep reasoning, not structured research agents.
  // Two escalation triggers: (1) Haiku exhausts maxIter, (2) Haiku output fails
  // JSON parsing. In both cases we retry once with Sonnet before giving up.
  // ---------------------------------------------------------------------------

  /**
   * Attempt a single model call. Returns { raw, escalated } where escalated=true
   * means Sonnet was used. Throws only if both Haiku AND Sonnet fail.
   */
  async function attemptWithEscalation() {
    // Skip Haiku entirely when sonnetOnly=true (e.g. financials always exceeds
    // Haiku's 200k context limit — running Haiku first wastes tokens and time)
    // haikusErr is declared here (outer scope) so it's accessible in the Sonnet
    // catch block below — needed to surface the original error if both models fail.
    let haikusErr = null;
    if (!sonnetOnly) {
      // --- Haiku attempt ---
      let rawHaiku   = null;
      try {
        rawHaiku = await callClaude({
          model:      'claude-haiku-4-5-20251001',
          system:     systemPrompt,
          userPrompt,
          tools:      RESEARCH_TOOLS,
          maxTokens:  8096,
          maxIter:    50, // Research agents make many tool calls (6+ searches + gov data)
        });
      } catch (err) {
        haikusErr = err;
      }

      // If Haiku succeeded, try to parse. If parse succeeds, we're done.
      if (!haikusErr) {
        try {
          const parsed = parseJSON(rawHaiku);
          return { parsed, escalated: false };
        } catch (_parseErr) {
          // Parse failed — escalate to Sonnet (trigger 2)
          console.warn(`      ⚠ ${agentName}: Haiku output failed JSON parse — escalating to Sonnet`);
        }
      } else {
        // Haiku call itself threw (trigger 1: iteration exhaustion or API error)
        console.warn(`      ⚠ ${agentName}: Haiku failed (${haikusErr.message.slice(0, 120)}) — escalating to Sonnet`);
      }
    }

    // --- Sonnet (escalation or sonnetOnly direct start) ---
    let rawSonnet;
    try {
      rawSonnet = await callClaude({
        model:      'claude-sonnet-4-6',
        system:     systemPrompt,
        userPrompt,
        tools:      RESEARCH_TOOLS,
        maxTokens:  16000, // Raised from 8096 — sonnetOnly agents (marketing, financials, packaging) can produce large JSON outputs
        maxIter:    20, // Sonnet converges faster — lower ceiling to control cost
      });
    } catch (sonnetErr) {
      // Both models failed — surface original Haiku error if available, else Sonnet's
      throw haikusErr || sonnetErr;
    }

    // Parse Sonnet output — if this fails too, let it throw naturally
    const parsed = parseJSON(rawSonnet);
    return { parsed, escalated: true };
  }

  // Run with escalation logic, catching terminal failures
  let parsed;
  let escalated = false;
  try {
    ({ parsed, escalated } = await attemptWithEscalation());
  } catch (err) {
    // Both Haiku and Sonnet failed (or parse failed after Sonnet)
    console.error(`      ✗ ${agentName} failed after escalation: ${err.message.slice(0, 200)}`);
    await saveAgentOutput({
      report_id:   context.reportId,
      agent_name:  `research_${agentName}`,
      status:      'failed',
      output_data: { error: err.message },
    });
    return null;
  }

  if (escalated) {
    console.log(`      ↑ ${agentName} completed via Sonnet escalation`);
  }

  // Save the structured output to the DB
  await saveAgentOutput({
    report_id:   context.reportId,
    agent_name:  `research_${agentName}`,
    status:      'complete',
    output_data: parsed,
  });

  // Persist source citations from the agent output
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  for (const src of sources) {
    if (!src.url) continue;
    try {
      await saveReportSource({
        report_id:    context.reportId,
        agent_name:   `research_${agentName}`,
        url:          src.url,
        title:        src.title   || null,
        retrieved_at: src.relevance ? null : new Date().toISOString(),
      });
    } catch (_) { /* Non-fatal — source persistence failure does not fail the run */ }
  }

  console.log(`      ✓ ${agentName} complete`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Individual research agent stubs — all delegate to runResearchAgent()
// ---------------------------------------------------------------------------

async function runMarketOverviewAgent(context) {
  return runResearchAgent('market_overview', context);
}
async function runCompetitorsAgent(context) {
  return runResearchAgent('competitors', context);
}
async function runRegulatoryAgent(context) {
  return runResearchAgent('regulatory', context);
}
async function runProductionAgent(context) {
  return runResearchAgent('production', context);
}
async function runPackagingAgent(context) {
  // Packaging agent accumulates too much context across tool calls and reliably
  // hits Haiku's max_tokens limit. Skip straight to Sonnet like financials.
  return runResearchAgent('packaging', context, { sonnetOnly: true });
}
async function runDistributionAgent(context) {
  return runResearchAgent('distribution', context);
}
async function runMarketingAgent(context) {
  // Marketing accumulates too much context across tool calls and reliably hits
  // Haiku's 200k token limit. Skip straight to Sonnet like financials and packaging.
  return runResearchAgent('marketing', context, { sonnetOnly: true });
}
async function runFinancialsAgent(context) {
  // Financials always exceeds Haiku's 200k context limit (12+ tool calls accumulate
  // too much context). Skip the Haiku attempt and go straight to Sonnet.
  return runResearchAgent('financials', context, { sonnetOnly: true });
}
async function runOriginOpsAgent(context) {
  return runResearchAgent('origin_ops', context);
}
async function runLegalAgent(context) {
  return runResearchAgent('legal', context);
}

// ---------------------------------------------------------------------------
// Pre-run intelligence briefings (Perplexity)
// ---------------------------------------------------------------------------

/**
 * Calls Perplexity once before the research agents run to analyse the venture
 * itself — what type of business it is, which regulatory bodies matter, what the
 * critical success factors are, and which research dimensions to prioritise.
 *
 * This makes the system adaptive: a solar-panel proposition gets DOE/EPA framing;
 * a food proposition gets FDA/USDA framing — without any workflow rewrites.
 * Agents read this brief and naturally skip tools that aren't relevant.
 *
 * Non-fatal — if Perplexity fails the brief is null and agents fall back to
 * their generic workflow SOPs.
 *
 * @param {Object} proposition - Proposition row.
 * @returns {string|null} Synthesised venture intelligence brief, or null.
 */
function runVentureIntelligence(proposition) {
  console.log('\n  Running venture intelligence brief (Perplexity)...');

  // Build a rich, structured prompt so Perplexity returns actionable framing
  const parts = [
    `Business venture analysis: "${proposition.title}".`,
    proposition.description ? `Description: ${proposition.description}.` : '',
    `Product type: ${proposition.product_type || 'physical product'}.`,
    proposition.industry   ? `Industry: ${proposition.industry}.`            : '',
    proposition.origin_country  ? `Origin country: ${proposition.origin_country}.`   : '',
    proposition.target_country  ? `Target market: ${proposition.target_country}.`    : '',
    proposition.target_demographic ? `Target demographic: ${proposition.target_demographic}.` : '',
  ].filter(Boolean).join(' ');

  const query = `${parts}

For a business like this, provide a structured intelligence brief covering:
1. Venture classification — what type of business is this and what are the key business model dynamics?
2. Critical success factors — the 3-5 things that will determine whether this succeeds or fails.
3. Highest-risk unknowns — what a researcher should investigate most urgently.
4. Relevant regulatory bodies — which government agencies, trade bodies, and standards organisations apply (be specific to the product and countries involved).
5. Research priorities — which dimensions (market sizing, regulatory path, competitive landscape, supply chain, financials) matter most for this specific venture.
6. Useful data sources — which databases, industry associations, or benchmarks are most relevant.
Keep the answer factual and specific to this venture. Avoid generic business advice.`;

  try {
    const result = execPython('tools/search_perplexity.py', [
      '--query', query,
      '--model', 'sonar',
    ]);

    const brief = result.answer;
    if (!brief || brief.length < 100) {
      console.warn('  ⚠ Venture intelligence brief too short — skipping');
      return null;
    }

    console.log(`  ✓ Venture intelligence brief: ${brief.length} chars, ${(result.sources || []).length} citations`);
    return brief;
  } catch (err) {
    console.warn(`  ⚠ Venture intelligence brief failed (non-fatal): ${err.message.slice(0, 120)}`);
    return null;
  }
}

/**
 * Calls Perplexity once to get a current-events snapshot of the market landscape.
 * Surfaces recent regulatory changes, market shifts, new competitors, and
 * trade/political risks that static workflow queries might miss.
 *
 * This is Layer 1 context (what's happening right now) vs. venture intelligence
 * which is Layer 2 (what matters for this type of business).
 *
 * Non-fatal — agents proceed with their generic workflows if this fails.
 *
 * @param {Object} proposition - Proposition row.
 * @returns {string|null} Synthesised landscape brief, or null.
 */
function runCurrentLandscapeBriefing(proposition) {
  console.log('  Running current landscape briefing (Perplexity)...');

  const product = proposition.product_type || proposition.title;
  const origin  = proposition.origin_country  ? `from ${proposition.origin_country}` : '';
  const target  = proposition.target_country  ? `entering the ${proposition.target_country} market` : '';
  const year    = new Date().getFullYear();

  const query = `Current market intelligence briefing (${year}): ${product} ${origin} ${target}.

Provide a factual snapshot covering:
1. Regulatory developments — any significant rule changes, enforcement actions, or pending regulations in the past 12 months.
2. Market trends — key demand shifts, pricing movements, or consumer behaviour changes right now.
3. Competitive landscape — notable new entrants, funding rounds, acquisitions, or exits recently.
4. Trade and political factors — tariffs, import restrictions, bilateral agreements, or geopolitical risks currently affecting this market.
5. Recent news — anything in the last 6 months that someone launching this business right now must know.
Be specific and cite dates where possible. Avoid historical background — focus on what is current.`;

  try {
    const result = execPython('tools/search_perplexity.py', [
      '--query', query,
      '--model', 'sonar',
    ]);

    const brief = result.answer;
    if (!brief || brief.length < 100) {
      console.warn('  ⚠ Landscape briefing too short — skipping');
      return null;
    }

    console.log(`  ✓ Landscape briefing: ${brief.length} chars, ${(result.sources || []).length} citations`);
    return brief;
  } catch (err) {
    console.warn(`  ⚠ Landscape briefing failed (non-fatal): ${err.message.slice(0, 120)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Research orchestration
// ---------------------------------------------------------------------------

/**
 * Runs all 10 research sub-agents sequentially.
 * Sequential — not parallel — to respect Brave Search rate limits.
 * Each agent runs its workflow, calls Python tools, and saves its output.
 *
 * @param {Object} context - Shared run context.
 * @returns {Promise<Object>} Map of agent_name → parsed output (null if failed).
 */
async function runResearchAgents(context) {
  console.log('\n  Running research agents (sequential)...');

  // Inter-agent delay — Anthropic enforces a 50,000 input-token-per-minute rate
  // limit. Each agent sends 15–40k tokens (workflow + briefs + tool results).
  // Without a gap, back-to-back agents exhaust the minute budget and trigger 429s.
  // 30 seconds gives the limit window time to partially reset between agents.
  const INTER_AGENT_DELAY_MS = 30_000;
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const outputs = {};

  outputs.market_overview = await runMarketOverviewAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.competitors      = await runCompetitorsAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.regulatory       = await runRegulatoryAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.production       = await runProductionAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.packaging        = await runPackagingAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.distribution     = await runDistributionAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.marketing        = await runMarketingAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.financials       = await runFinancialsAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.origin_ops       = await runOriginOpsAgent(context);
  await sleep(INTER_AGENT_DELAY_MS);
  outputs.legal            = await runLegalAgent(context);

  return outputs;
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/**
 * Validates research outputs before assembly.
 * Hard fail: a critical agent returned null, or the run can't proceed.
 * Soft fail: non-critical agent null — logs and continues (gap flagged in report).
 *
 * @param {Object} agentOutputs - Map of agent_name → output.
 * @throws {Error} If a critical agent failed or fewer than 9 of 10 completed.
 */
function checkQuality(agentOutputs) {
  console.log('\n  Quality gate...');

  const failed   = [];
  const complete = [];

  for (const name of RESEARCH_AGENTS) {
    if (agentOutputs[name] === null || agentOutputs[name] === undefined) {
      failed.push(name);
    } else {
      complete.push(name);
    }
  }

  // Hard fail: any critical agent is missing
  const criticalFailed = failed.filter(n => CRITICAL_AGENTS.has(n));
  if (criticalFailed.length > 0) {
    throw new Error(
      `Quality gate failed — critical agents produced no output: ${criticalFailed.join(', ')}. ` +
      'Report cannot be assembled without this data.'
    );
  }

  // Hard fail: more than 1 non-critical agent failed (9-of-10 minimum)
  if (failed.length > 1) {
    throw new Error(
      `Quality gate failed — too many agents failed (${failed.length}/10): ${failed.join(', ')}. ` +
      'Minimum 9/10 agents required for a reliable report.'
    );
  }

  if (failed.length === 1) {
    console.log(`  ⚠ Soft failure: ${failed[0]} produced no output — gap will be noted in report`);
  }

  console.log(`  ✓ Quality gate passed (${complete.length}/10 agents complete)`);

  // Return soft-failed agent names so the caller can attempt a retry
  return failed;
}

// ---------------------------------------------------------------------------
// Data confidence score
// ---------------------------------------------------------------------------

/**
 * Computes the data confidence score for this report run.
 * Calls the Python tool which aggregates per-field confidence ratings
 * across all 10 agent outputs into a single 0–100 score.
 *
 * Returns null (with a warning) if the tool fails — non-fatal.
 *
 * @param {string} reportId - The report UUID.
 * @returns {{ score: number, interpretation: string, description: string }|null}
 */
function computeDataConfidence(reportId) {
  console.log('\n  Computing data confidence score...');
  try {
    const result = execPython('tools/compute_data_confidence.py', ['--report-id', reportId]);
    const score  = result.data_confidence_score;
    console.log(`  ✓ Data confidence: ${score}/100 — ${result.interpretation}`);
    return {
      score:          score,
      interpretation: result.interpretation,
      description:    result.description,
    };
  } catch (err) {
    console.warn(`  ⚠ Confidence tool failed (non-fatal): ${err.message.slice(0, 120)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assembler agent — helpers
// ---------------------------------------------------------------------------

/**
 * Per-section writing instructions for each report section.
 * Injected into individual section prompts to keep each call focused.
 */
const ASSEMBLER_SECTION_INSTRUCTIONS = {
  executive_summary:
    `Write a maximum 1-page executive summary. Lead with the viability verdict and weighted score.
     Include a key_figures block showing the overall viability score and data confidence score.
     Write 3-5 key findings as a bullets block. List the top 3 risks and top 3 opportunities as bullets.
     Reference the data confidence interpretation in the prose.`,

  market_overview:
    `Synthesise the market_overview agent output into a narrative section.
     Cover market size, growth rate, and demand drivers. Include key figures as a key_figures block.
     Discuss the target demographic in a paragraph.`,

  competitor_analysis:
    `Synthesise the competitors agent output. Use the narrative_summary as the foundation.
     Include a table of key competitors with columns: Competitor | Product | Price Point | Channels | Key Differentiator.`,

  regulatory_landscape:
    `Synthesise the regulatory agent output. Flag any hard blockers prominently using callout blocks
     with label "Regulatory Blocker". Cover FDA import requirements, labeling rules, and any
     Somalia-specific trade restrictions or sanctions flags.`,

  production_equipment:
    `Synthesise the production agent output. Cover the production process and key technical requirements.
     Include a table of key equipment with columns: Equipment | Purpose | Estimated Cost.`,

  packaging:
    `Synthesise the packaging agent output. Cover packaging options and their trade-offs.
     Include a table with columns: Format | Material | MOQ | Cost Per Unit | Pros | Cons.`,

  distribution_strategy:
    `Synthesise the distribution agent output. Cover the recommended channel mix and entry requirements.
     Include a table with columns: Channel | Entry Requirement | Margin Impact | Best For.`,

  marketing_influencers:
    `Synthesise the marketing agent output. Cover key marketing channels and target audience segments.
     If influencer data is available, include a table with columns: Platform | Audience | Opportunity.
     Cover compliant health claim language — what can and cannot be said under FDA guidelines.`,

  financial_projections:
    `Synthesise the financials agent output. Include a unit economics table with columns:
     Metric | Value (showing Revenue, COGS, Gross Margin %, Operating Costs, Net Margin per unit).
     Include a startup capital table with columns: Item | Estimated Cost.
     Cover break-even timeline and 3-year trajectory in prose.`,

  risk_assessment:
    `Consolidate risks from the legal, regulatory, and origin_ops agent outputs.
     Include a risk table with columns: Risk | Category | Likelihood | Impact | Mitigation.
     Use High / Medium / Low for Likelihood and Impact. At least 5 risks required.`,

  recommendations:
    `Provide 5-7 prioritised, actionable recommendations drawn from all research.
     Most critical first. Each recommendation must be a concrete next step, not vague advice.
     Use a numbered bullets block.`,

  data_confidence:
    `Write the Data Confidence section explaining the score in plain language.
     (1) A key_figures block showing the score (e.g. 79/100) and interpretation label.
     (2) A table with columns: Signal | Weight | What Drove It — covering all 4 signals:
         Field Confidence Ratings (45%), Agent Completion (25%), Source Coverage (20%), Data Gaps (10%).
     (3) A paragraph explaining in plain English what this score means in real-world terms.
         Name specific sections with lower confidence. State whether the viability verdict
         should be treated as definitive or directional.
     (4) If any research agents failed, name the affected report sections explicitly.`,
};

/**
 * Makes a streaming Sonnet call and returns the text.
 * Retries automatically on 429 rate limits and transient stream terminations.
 * Throws if all retry attempts are exhausted.
 *
 * @param {string} systemPrompt
 * @param {Array}  messages      - Conversation history array for the API call.
 * @param {number} maxTokens     - Output token ceiling for this call.
 */
async function streamSonnetCall(systemPrompt, messages, maxTokens) {
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      return await anthropic.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages,
      }).finalText();
    } catch (err) {
      const is429        = err.status === 429 || (err.message && err.message.includes('rate_limit_error'));
      const isTerminated = err.message && err.message.includes('terminated');
      if ((is429 || isTerminated) && attempts <= 3) {
        const waitSec = is429 ? 60 * attempts : 30;
        const reason  = is429 ? 'rate limited (429)' : 'stream terminated';
        console.warn(`      ⚠ Sonnet ${reason} — waiting ${waitSec}s (attempt ${attempts}/3)...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Calls Sonnet with a prompt, attempts to parse the JSON response, and retries
 * up to maxRepairs times on parse failure. Each repair sends the bad output back
 * to Sonnet with the parse error so it can self-correct.
 *
 * Returns parsed JSON on success.
 * Returns null if hardFail=false and all attempts are exhausted.
 * Throws if hardFail=true and all attempts are exhausted.
 *
 * @param {string}  systemPrompt
 * @param {string}  userPrompt
 * @param {number}  maxTokens   - Output ceiling for this section.
 * @param {number}  maxRepairs  - How many repair cycles to attempt (default 2).
 * @param {boolean} hardFail    - If true, throw on total failure instead of returning null.
 */
async function callWithRepair(systemPrompt, userPrompt, maxTokens, maxRepairs = 2, hardFail = false) {
  const messages = [{ role: 'user', content: userPrompt }];
  let rawContent;

  // Initial generation attempt
  try {
    rawContent = await streamSonnetCall(systemPrompt, messages, maxTokens);
  } catch (err) {
    const msg = `Initial generation failed: ${err.message}`;
    if (hardFail) throw new Error(msg);
    console.warn(`      ✗ ${msg}`);
    return null;
  }

  // Parse + repair loop — attempt 0 is the initial parse, attempts 1..maxRepairs are repairs
  for (let repair = 0; repair <= maxRepairs; repair++) {
    try {
      return parseJSON(rawContent);
    } catch (parseErr) {
      if (repair === maxRepairs) {
        // All repair attempts exhausted
        const msg = `JSON parse failed after ${maxRepairs} repair(s): ${parseErr.message}`;
        if (hardFail) throw new Error(msg);
        console.warn(`      ✗ ${msg}`);
        return null;
      }

      console.warn(`      ⚠ JSON parse failed — repair attempt ${repair + 1}/${maxRepairs}...`);

      // Show Sonnet what it returned and ask it to fix the specific error
      messages.push({ role: 'assistant', content: rawContent });
      messages.push({
        role:    'user',
        content: `Your response was not valid JSON.\n\nParse error: ${parseErr.message}\n\n` +
                 `Return ONLY the corrected JSON — no markdown fences, no explanation, ` +
                 `no text before or after the JSON object.`,
      });

      try {
        rawContent = await streamSonnetCall(systemPrompt, messages, maxTokens);
      } catch (repairErr) {
        const msg = `Repair attempt ${repair + 1} stream failed: ${repairErr.message}`;
        if (hardFail) throw new Error(msg);
        console.warn(`      ✗ ${msg}`);
        return null;
      }
    }
  }
}

/**
 * Builds a compact structural audit view of the content JSON for the Haiku review pass.
 * Much smaller than the full JSON — sends structure and metadata, not prose content.
 * This keeps the review call cheap and fast.
 *
 * @param {Object} contentJson - Fully assembled content JSON.
 * @returns {Object} Compact audit representation.
 */
function buildAuditView(contentJson) {
  return {
    viability_score: {
      overall: contentJson.viability_score?.overall,
      verdict: contentJson.viability_score?.verdict,
      factors: (contentJson.viability_score?.factors || []).map(f => ({
        name:         f.name,
        score:        f.score,
        hasRationale: !!(f.rationale && f.rationale.trim()),
      })),
    },
    sections: (contentJson.sections || []).map(s => ({
      id:             s.id,
      title:          s.title,
      blockCount:     s.blocks?.length || 0,
      isPlaceholder:  s.blocks?.some(b => b.label === 'Section Unavailable') || false,
      blocks: (s.blocks || []).map(b => ({
        type:       b.type,
        // Structural check per block type — not the content itself
        isEmpty:    b.type === 'paragraph'   ? !b.text?.trim() :
                    b.type === 'table'       ? (!b.headers?.length || !b.rows?.length) :
                    b.type === 'bullets'     ? !b.items?.length :
                    b.type === 'callout'     ? !b.text?.trim() :
                    b.type === 'key_figures' ? !b.items?.length : false,
      })),
    })),
    sourceCount:    contentJson.sources?.length || 0,
    hasWhatChanged: Array.isArray(contentJson.what_changed) && contentJson.what_changed.length > 0,
  };
}

/**
 * Build a compact text-only view of the report's prose content for the proofread pass.
 *
 * Only paragraph, bullets, and callout blocks are included — tables and key_figures
 * are data blocks that the proofreader should not alter. The view is indexed by
 * section_id and block_index so patches returned by the model can be applied directly.
 *
 * @param {Object} contentJson - Fully assembled content JSON.
 * @returns {string} Human-readable multi-section text view.
 */
function buildProofreadView(contentJson) {
  const lines = [];
  for (const section of (contentJson.sections || [])) {
    lines.push(`\n=== [${section.id}] ${section.title} ===`);
    for (const [i, block] of (section.blocks || []).entries()) {
      if (block.type === 'paragraph') {
        lines.push(`PARA ${i}: ${block.text}`);
      } else if (block.type === 'bullets') {
        // Show label + items so the proofreader can spot repeated bullet points
        const label = block.label ? `(${block.label}) ` : '';
        lines.push(`BULLETS ${i} ${label}| ${(block.items || []).join(' | ')}`);
      } else if (block.type === 'callout') {
        lines.push(`CALLOUT ${i} (${block.label || ''}): ${block.text}`);
      }
      // tables and key_figures intentionally omitted
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Assembler agent
// ---------------------------------------------------------------------------

/**
 * Runs the assembler agent using a section-by-section approach.
 *
 * Instead of one giant 25k-token Sonnet call (which reliably produces malformed JSON),
 * we make one small call per report section (~2-6k tokens each). Each call has a
 * 2-cycle repair loop. A Haiku quality pass runs after assembly. The content JSON is
 * uploaded to Storage BEFORE PDF build so it's recoverable if PDF fails.
 *
 * This function owns the final `updateReportStatus('complete')` transition.
 *
 * @param {Object} context      - Run context.
 * @param {Object} agentOutputs - Map of agent_name → parsed research output.
 */
async function runAssemblerAgent(context, agentOutputs) {
  console.log('\n  Running assembler (section-by-section)...');

  const { reportId, proposition, client, runNumber, previousReportId } = context;

  // 1. Load the assembler workflow SOP
  const assemblerWorkflow = loadWorkflow('assemble_report.md');

  // 2. Compute data confidence score (reads from Supabase, needs agents saved first)
  const confidence = computeDataConfidence(reportId);

  // 3. Fetch previous report outputs for "What Changed" (run 2+)
  let previousOutputs = null;
  if (runNumber > 1 && previousReportId) {
    try {
      const prevRows = await getAgentOutputsByReportId(previousReportId);
      previousOutputs = {};
      for (const row of prevRows) {
        previousOutputs[row.agent_name] = row.output_data;
      }
      console.log(`  ✓ Loaded ${prevRows.length} previous agent outputs for "What Changed"`);
    } catch (err) {
      console.warn(`  ⚠ Could not load previous report outputs: ${err.message.slice(0, 120)}`);
    }
  }

  // 4. Build the report month string for file naming and display
  const now          = new Date();
  const reportMonth  = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const reportYYYYMM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // 5. Build the proposition slug for file naming
  const slug = proposition.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // 6. System prompt — shared across all section calls
  const systemPrompt = `You are the report assembler for McKeever Consulting's Business Viability Intelligence System.
Your role is to write ONE specific section of a professional business viability report.

CRITICAL RULES:
1. Your response must be ONLY the JSON object specified — no markdown code fences, no text before or after
2. Write all prose in plain, professional English — paragraphs, not bullet-point walls
3. Every claim must be traceable to the research data provided — do not invent figures
4. Every block must have non-empty content — no empty strings, no placeholder text`;

  // 7. Build the shared research context — injected into every section prompt.
  // All research data is included in every call so sections can cross-reference freely.
  const researchContext = `## ASSEMBLER WORKFLOW (scoring guide and section guidance)
${assemblerWorkflow}

## REPORT METADATA
\`\`\`json
${JSON.stringify({
    report_id:          reportId,
    proposition_id:     proposition.id,
    client_id:          client.id,
    run_number:         runNumber,
    previous_report_id: previousReportId,
    proposition: {
      title:              proposition.title,
      product_type:       proposition.product_type,
      industry:           proposition.industry,
      origin_country:     proposition.origin_country  || null,
      target_country:     proposition.target_country,
      target_demographic: proposition.target_demographic || null,
      factor_weights:     proposition.factor_weights,
    },
    client: { name: client.name, email: client.email },
  }, null, 2)}
\`\`\`

## DATA CONFIDENCE SCORE (pre-computed)
\`\`\`json
${JSON.stringify(confidence || { score: null, interpretation: 'Unavailable', description: 'Confidence tool failed.' }, null, 2)}
\`\`\`

## RESEARCH AGENT OUTPUTS (10 agents)
\`\`\`json
${JSON.stringify(agentOutputs, null, 2)}
\`\`\`

${previousOutputs
    ? `## PREVIOUS REPORT OUTPUTS (for "What Changed")\n\`\`\`json\n${JSON.stringify(previousOutputs, null, 2)}\n\`\`\``
    : '## PREVIOUS REPORT OUTPUTS\nRun #1 — no previous outputs.'}`;

  // Block schema reminder injected into every section prompt
  const blockSchema = `Block types available:
{ "type": "paragraph",   "text": "..." }
{ "type": "bullets",     "label": "Optional heading", "items": ["...", "..."] }
{ "type": "table",       "headers": ["Col1","Col2"], "rows": [["a","b"]] }
{ "type": "callout",     "label": "Key Finding", "text": "..." }
{ "type": "key_figures", "items": [{"label": "...", "value": "..."}] }`;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 20s between section calls — each call sends ~20k input tokens; 20s keeps us
  // safely within the 50k TPM rate limit window shared with research agents.
  const INTER_SECTION_DELAY_MS = 20_000;

  // ── Call 1: Meta + Viability Score ────────────────────────────────────────
  // Hard fail — viability verdict is the core deliverable. No placeholder possible.
  console.log('    [1/15] Computing viability score...');
  const metaViabilityPrompt = `${researchContext}

## YOUR TASK
Compute the viability score from the research data. Apply the factor weights from the proposition.
Score each factor 1–5 using the scoring guide in the workflow above. Calculate the weighted overall score.

## OUTPUT SCHEMA
Return ONLY this JSON object (no markdown fences, no other text):
{
  "meta": {
    "proposition_title": "${proposition.title}",
    "proposition_slug":  "${slug}",
    "client_name":       "${client.name}",
    "report_date":       "${reportMonth}",
    "run_number":        ${runNumber},
    "data_confidence": {
      "score":          ${confidence?.score ?? null},
      "interpretation": "${confidence?.interpretation ?? 'Unavailable'}",
      "description":    "${(confidence?.description ?? 'Confidence tool failed.').replace(/"/g, '\\"')}"
    }
  },
  "viability_score": {
    "overall": <weighted score rounded to 1 decimal, range 1.0–5.0>,
    "verdict": "<Strong|Moderate|Weak>",
    "factors": [
      { "name": "<factor_key>", "label": "<Human-readable label>", "score": <1-5>, "weight": <0-1>, "rationale": "<one sentence>" }
    ]
  }
}`;

  const metaViability = await callWithRepair(systemPrompt, metaViabilityPrompt, 3000, 2, true);
  const meta           = metaViability.meta;
  const viabilityScore = metaViability.viability_score;
  console.log(`    ✓ Viability: ${viabilityScore.overall} — ${viabilityScore.verdict}`);
  await sleep(INTER_SECTION_DELAY_MS);

  // Viability score summary injected into all subsequent section calls for cohesion
  const viabilityContext = `## VIABILITY SCORE (pre-computed — use as reference in your section)
\`\`\`json
${JSON.stringify(viabilityScore, null, 2)}
\`\`\``;

  // ── Calls 2–13: Prose sections ────────────────────────────────────────────
  const SECTION_SPECS = [
    { callNum:  2, num: 3,  id: 'executive_summary',     title: 'Executive Summary',       maxTokens: 6000 },
    { callNum:  3, num: 4,  id: 'market_overview',       title: 'Market Overview',         maxTokens: 6000 },
    { callNum:  4, num: 5,  id: 'competitor_analysis',   title: 'Competitor Analysis',     maxTokens: 6000 },
    { callNum:  5, num: 6,  id: 'regulatory_landscape',  title: 'Regulatory Landscape',    maxTokens: 6000 },
    { callNum:  6, num: 7,  id: 'production_equipment',  title: 'Production & Equipment',  maxTokens: 6000 },
    { callNum:  7, num: 8,  id: 'packaging',             title: 'Packaging',               maxTokens: 6000 },
    { callNum:  8, num: 9,  id: 'distribution_strategy', title: 'Distribution Strategy',   maxTokens: 6000 },
    { callNum:  9, num: 10, id: 'marketing_influencers', title: 'Marketing & Influencers', maxTokens: 6000 },
    { callNum: 10, num: 11, id: 'financial_projections', title: 'Financial Projections',   maxTokens: 6000 },
    { callNum: 11, num: 12, id: 'risk_assessment',       title: 'Risk Assessment',         maxTokens: 6000 },
    { callNum: 12, num: 13, id: 'recommendations',       title: 'Recommendations',         maxTokens: 4000 },
    { callNum: 13, num: 14, id: 'data_confidence',       title: 'Data Confidence',         maxTokens: 4000 },
  ];

  const sections = [];

  for (const spec of SECTION_SPECS) {
    console.log(`    [${spec.callNum}/15] Section ${spec.num}: ${spec.title}...`);

    const sectionPrompt = `${researchContext}

${viabilityContext}

## YOUR TASK
Write section ${spec.num}: ${spec.title}

${ASSEMBLER_SECTION_INSTRUCTIONS[spec.id]}

## OUTPUT SCHEMA
Return ONLY this JSON object:
{
  "id":     "${spec.id}",
  "title":  "${spec.title}",
  "number": ${spec.num},
  "blocks": [ <one or more blocks — at least 1 paragraph required> ]
}

${blockSchema}`;

    const result = await callWithRepair(systemPrompt, sectionPrompt, spec.maxTokens, 2, false);

    if (result) {
      sections.push(result);
      console.log(`    ✓ Section ${spec.num} complete`);
    } else {
      // Non-fatal — insert a placeholder callout and continue
      sections.push({
        id:     spec.id,
        title:  spec.title,
        number: spec.num,
        blocks: [{
          type:  'callout',
          label: 'Section Unavailable',
          text:  `The ${spec.title} section could not be generated for this run due to a technical error. It will be included in the next scheduled report.`,
        }],
      });
      console.warn(`    ⚠ Section ${spec.num} failed after repairs — placeholder inserted`);
    }

    await sleep(INTER_SECTION_DELAY_MS);
  }

  // ── Call 14: What Changed (run 2+ only) ───────────────────────────────────
  let whatChanged = null;
  if (runNumber > 1 && previousOutputs) {
    console.log('    [14/15] What Changed...');
    const whatChangedPrompt = `${researchContext}

${viabilityContext}

## YOUR TASK
Compare the previous report outputs with the current report outputs and produce a list of
meaningful delta bullets for the "What Changed This Month" section.

Focus on: new findings, changed figures, resolved or new risks, regulatory updates, market shifts.
Ignore minor wording differences — only include substantive changes.

## OUTPUT SCHEMA
Return ONLY a JSON array of strings (not an object):
["<change bullet 1>", "<change bullet 2>", ...]`;

    whatChanged = await callWithRepair(systemPrompt, whatChangedPrompt, 3000, 2, false);
    if (whatChanged) {
      console.log('    ✓ What Changed complete');
    } else {
      whatChanged = ['What Changed data could not be generated for this run.'];
      console.warn('    ⚠ What Changed failed — placeholder inserted');
    }
    await sleep(INTER_SECTION_DELAY_MS);
  }

  // ── Call 15: Sources ──────────────────────────────────────────────────────
  console.log('    [15/15] Sources...');
  const sourcesPrompt = `${researchContext}

## YOUR TASK
Compile the complete list of sources cited across all research agent outputs.
Extract all URLs from the "sources" arrays within each agent output.
Include every unique source — do not deduplicate unless the exact same URL appears twice.

## OUTPUT SCHEMA
Return ONLY a JSON array (not an object):
[
  { "url": "...", "title": "...", "agent_name": "research_<name>", "retrieved_at": "<ISO timestamp or null>" }
]`;

  const sources = await callWithRepair(systemPrompt, sourcesPrompt, 4000, 2, false) || [];
  console.log(`    ✓ Sources compiled (${sources.length} entries)`);

  // ── Assemble final content JSON ───────────────────────────────────────────
  const contentJson = { meta, viability_score: viabilityScore, sections, sources, what_changed: whatChanged };

  // ── Haiku quality review + Sonnet repair loop ────────────────────────────
  // Haiku audits the assembled report for structural errors (empty blocks,
  // placeholder sections, missing viability data, etc.).
  //
  // If errors are found, we re-assemble each flagged section with Sonnet —
  // passing the specific issue as context so it knows what to fix — then
  // re-review. This repeats up to MAX_REPAIR_CYCLES times.
  //
  // After all cycles, any remaining issues are logged but never block delivery.
  const MAX_REPAIR_CYCLES = 2;

  try {
    for (let cycle = 0; cycle <= MAX_REPAIR_CYCLES; cycle++) {
      const isLastCycle = cycle === MAX_REPAIR_CYCLES;
      const cycleLabel  = cycle === 0 ? '' : ` (repair cycle ${cycle}/${MAX_REPAIR_CYCLES})`;
      console.log(`    Running quality review (Haiku)${cycleLabel}...`);

      const auditView    = buildAuditView(contentJson);
      const reviewPrompt = `You are a quality reviewer for a business report JSON. Review the structural audit below and return a JSON array of any issues found. If no issues, return [].

Issue format: { "section_id": "...", "issue": "...", "severity": "warning|error" }

Check for:
- Sections with blockCount 0 or isPlaceholder true
- Blocks where isEmpty is true
- Viability score factors with score 0 or hasRationale false
- sourceCount below 8
- hasWhatChanged false on run ${runNumber} ${runNumber > 1 ? '(expected true)' : '(ok if false — run 1)'}

AUDIT VIEW:
${JSON.stringify(auditView, null, 2)}`;

      const reviewResult = await anthropic.messages.create({
        model:     'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages:  [{ role: 'user', content: reviewPrompt }],
      });

      const reviewText = reviewResult.content[0]?.text || '[]';
      const issues     = parseJSON(reviewText) || [];
      const errors     = Array.isArray(issues) ? issues.filter(i => i.severity === 'error')   : [];
      const warnings   = Array.isArray(issues) ? issues.filter(i => i.severity === 'warning') : [];

      if (errors.length === 0) {
        // No errors — log any warnings and exit the review loop
        if (warnings.length) console.log(`    ℹ Quality review: ${warnings.length} warning(s) — ${warnings.map(i => i.section_id + ': ' + i.issue).join('; ')}`);
        console.log(`    ✓ Quality review passed${cycle > 0 ? ` after ${cycle} repair cycle(s)` : ''} — no errors`);
        break;
      }

      if (isLastCycle) {
        // All repair cycles exhausted — log unresolved errors and proceed (never block delivery)
        console.warn(`    ⚠ Quality review: ${errors.length} error(s) unresolved after ${MAX_REPAIR_CYCLES} repair cycle(s) — ${errors.map(i => i.section_id + ': ' + i.issue).join('; ')}`);
        if (warnings.length) console.log(`    ℹ Quality review: ${warnings.length} warning(s) — ${warnings.map(i => i.section_id + ': ' + i.issue).join('; ')}`);
        break;
      }

      // Re-assemble each errored section with Sonnet, passing the specific issue
      // as context so it knows exactly what to fix. Then loop back to re-review.
      console.log(`    ⚠ Quality review: ${errors.length} error(s) — repairing sections...`);
      for (const issue of errors) {
        const spec = SECTION_SPECS.find(s => s.id === issue.section_id);
        if (!spec) {
          console.warn(`      ✗ No assembler spec for section '${issue.section_id}' — skipping`);
          continue;
        }

        console.log(`      → Repairing '${spec.title}': ${issue.issue}`);

        const repairPrompt = `${researchContext}

${viabilityContext}

## REPAIR CONTEXT
This section was flagged by the quality reviewer with the following issue:
"${issue.issue}"

Address this issue directly — ensure no blocks are empty and all content is
substantive and complete.

## YOUR TASK
Write section ${spec.num}: ${spec.title}

${ASSEMBLER_SECTION_INSTRUCTIONS[spec.id]}

## OUTPUT SCHEMA
Return ONLY this JSON object:
{
  "id":     "${spec.id}",
  "title":  "${spec.title}",
  "number": ${spec.num},
  "blocks": [ <one or more blocks — at least 1 paragraph required> ]
}

${blockSchema}`;

        const repaired = await callWithRepair(systemPrompt, repairPrompt, spec.maxTokens, 2, false);

        if (repaired) {
          // Swap the repaired section into contentJson in-place
          const idx = contentJson.sections.findIndex(s => s.id === spec.id);
          if (idx !== -1) contentJson.sections[idx] = repaired;
          console.log(`      ✓ '${spec.title}' repaired`);
        } else {
          console.warn(`      ✗ '${spec.title}' repair failed — keeping original`);
        }

        await sleep(INTER_SECTION_DELAY_MS);
      }
    }
  } catch (reviewErr) {
    // Non-fatal — a review failure never blocks delivery
    console.warn(`    ⚠ Quality review failed (non-fatal): ${reviewErr.message.slice(0, 120)}`);
  }

  // ── Proofread pass (Sonnet) ───────────────────────────────────────────────
  // Sends a compact text-only view of all prose sections to Sonnet.
  // Returns targeted patches (section_id + block_index + new_text) that fix:
  //   1. Cross-section repetition — same fact restated in multiple sections
  //   2. Clarity — verbose or awkward sentences
  // Patches are applied in-place to contentJson before PDF build.
  // Non-fatal: a parse failure or Sonnet error never blocks delivery.
  console.log('    Running proofread pass (Sonnet)...');
  try {
    const proofreaderView = buildProofreadView(contentJson);
    const proofreadPrompt = `You are an editorial proofreader for a professional business viability report delivered to paying clients.

Your job is to make this report the best version it can be before it reaches the client.

Review the section content below and return a JSON array of text patches to fix:
1. REPETITION: passages that restate a specific fact, figure, or claim already made in a prior section (cross-section only — within-section structure is fine)
2. CONTRADICTION: figures or claims in one section that conflict with figures or claims in another (e.g. two sections cite different market sizes for the same metric — resolve to the most specific and sourced figure)
3. VAGUE FINANCIALS: financial language that uses relative terms without supporting numbers — flag phrases like "significant revenue", "substantial cost savings", "considerable demand" and replace with specific language or remove the unsupported claim
4. WEAK CONCLUSIONS: hedged or non-committal conclusions in Recommendations or Executive Summary that don't give the client a clear steer — replace with direct, actionable language
5. CLARITY: sentences that are verbose, ambiguous, or awkward enough to reduce readability

Patch format:
{ "section_id": "<id from [section_id] header>", "block_index": <integer from PARA/BULLETS/CALLOUT prefix>, "new_text": "<replacement text>" }

Rules:
- For PARA blocks: new_text replaces the full paragraph text
- For BULLETS blocks: new_text is a \\n-delimited list of the replacement bullet items (same count or fewer)
- For CALLOUT blocks: new_text replaces the callout body text
- Do NOT alter tables or key_figures — omit them entirely
- Keep the same professional tone and approximate length — reduce redundancy, don't change meaning
- Only patch when the improvement is clear and material. Return [] if the report reads cleanly.
- Return ONLY the JSON array — no markdown, no explanation

REPORT CONTENT:
${proofreaderView}`;

    const proofreadResult = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens:  4000,
      messages:   [{ role: 'user', content: proofreadPrompt }],
    });

    const proofreadText = proofreadResult.content[0]?.text || '[]';
    const patches       = parseJSON(proofreadText);
    let patchesApplied  = 0;

    if (Array.isArray(patches) && patches.length > 0) {
      // Build a lookup map: section_id → section object
      const sectionMap = {};
      for (const s of (contentJson.sections || [])) {
        sectionMap[s.id] = s;
      }

      for (const patch of patches) {
        const section = sectionMap[patch.section_id];
        if (!section) continue;

        const block = section.blocks?.[patch.block_index];
        if (!block || typeof patch.new_text !== 'string' || !patch.new_text.trim()) continue;

        if (block.type === 'paragraph') {
          block.text = patch.new_text;
          patchesApplied++;
        } else if (block.type === 'bullets') {
          // new_text is \\n-delimited replacement items
          const newItems = patch.new_text.split('\n').map(s => s.trim()).filter(Boolean);
          if (newItems.length > 0) {
            block.items = newItems;
            patchesApplied++;
          }
        } else if (block.type === 'callout') {
          block.text = patch.new_text;
          patchesApplied++;
        }
      }
      console.log(`    ✓ Proofread: ${patches.length} suggestion(s), ${patchesApplied} patch(es) applied`);
    } else {
      console.log('    ✓ Proofread: no changes needed');
    }
  } catch (proofreadErr) {
    // Non-fatal — a proofread failure never blocks delivery
    console.warn(`    ⚠ Proofread pass failed (non-fatal): ${proofreadErr.message.slice(0, 120)}`);
  }

  // ── Write content JSON to .tmp/ ───────────────────────────────────────────
  const tmpDir      = path.join(__dirname, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const contentFile = path.join(tmpDir, `${reportId}_content.json`);
  fs.writeFileSync(contentFile, JSON.stringify(contentJson, null, 2));
  console.log(`    ✓ Content JSON written`);

  // ── Upload content JSON to Storage BEFORE PDF build ───────────────────────
  // Critical order: if PDF generation fails, the content JSON is already in Storage
  // so Brendon can run --regen-pdf to rebuild without re-running any agents.
  const contentStoragePath = `${proposition.id}/${reportId}_content.json`;
  const { error: contentUploadError } = await supabase.storage
    .from('reports')
    .upload(contentStoragePath, JSON.stringify(contentJson, null, 2), {
      contentType: 'application/json',
      upsert:      true,
    });
  if (contentUploadError) {
    console.warn(`    ⚠ Content JSON upload failed (non-fatal): ${contentUploadError.message}`);
  } else {
    console.log('    ✓ Content JSON uploaded to Storage');
  }

  // ── Build PDF ─────────────────────────────────────────────────────────────
  const outputsDir  = path.join(__dirname, 'outputs');
  fs.mkdirSync(outputsDir, { recursive: true });
  const pdfFilename = `${slug}_${reportYYYYMM}.pdf`;
  const pdfPath     = path.join(outputsDir, pdfFilename);
  const pdfScript   = path.join(__dirname, 'tools', 'generate_report_pdf.py');

  console.log('    Building PDF...');
  try {
    execSync(
      `${PYTHON} "${pdfScript}" --report-id "${reportId}" --content "${contentFile}" --output "${pdfPath}"`,
      { stdio: 'inherit', cwd: __dirname, timeout: 120_000 }
    );
  } catch (err) {
    throw new Error(`PDF generation failed: ${err.message}`);
  }
  console.log(`    ✓ PDF generated: ${pdfFilename}`);

  // ── Upload PDF to Supabase Storage ────────────────────────────────────────
  const storagePath = `${proposition.id}/${reportId}.pdf`;
  const pdfBuffer   = fs.readFileSync(pdfPath);

  const { error: uploadError } = await supabase.storage
    .from('reports')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadError) {
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
  }

  // Store the storage path (not a signed URL) — signed URLs expire after 7 days.
  // Generate fresh signed URLs on demand from the web app or admin panel.
  await updateReportPdfUrl(reportId, storagePath);
  console.log('    ✓ PDF uploaded to Storage');

  // ── Email recipients ──────────────────────────────────────────────────────
  const viabilityScoreObj = contentJson.viability_score || {};
  for (const recipient of context.recipients) {
    await sendReportEmail(recipient, proposition, pdfPath, reportMonth, viabilityScoreObj, confidence);
    console.log(`    ✓ Report emailed to ${recipient.email}`);
  }
  await sendAdminReportCopy(context.recipients, proposition, pdfPath, reportMonth, viabilityScoreObj, confidence);
  console.log(`    ✓ Admin copy sent (${context.recipients.length} recipient(s) notified)`);

  // ── Mark complete + cleanup ───────────────────────────────────────────────
  await updateReportStatus(reportId, 'complete');
  console.log('  ✓ Report status → complete');

  try { fs.unlinkSync(contentFile); } catch (_) { /* Non-fatal */ }
  try { fs.unlinkSync(pdfPath);     } catch (_) { /* Non-fatal */ }
  try {
    await deleteAgentOutputsByReportId(reportId);
    console.log('  ✓ Agent outputs purged');
  } catch (err) {
    console.warn(`  ⚠ Agent output cleanup failed (non-fatal): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Report email delivery
// ---------------------------------------------------------------------------

/**
 * Sends the completed report PDF to a single recipient via Resend.
 * Personalized with the recipient's name. Called once per recipient in a loop.
 * Admin copy is sent separately via sendAdminReportCopy() after all recipient emails.
 *
 * @param {Object} recipient      - Client row for this recipient.
 * @param {Object} proposition    - Proposition row.
 * @param {string} pdfPath        - Local path to the generated PDF.
 * @param {string} reportMonth    - Human-readable month string (e.g. "April 2026").
 * @param {Object} viabilityScore - Score object { overall, verdict, factors }.
 * @param {Object|null} confidence - Confidence score object or null.
 */
async function sendReportEmail(recipient, proposition, pdfPath, reportMonth, viabilityScore, confidence) {
  // Alias so the rest of this function reads naturally
  const client = recipient;
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');
  const filename  = `McKeever_${proposition.title.replace(/[^a-z0-9]+/gi, '_')}_${reportMonth.replace(' ', '_')}.pdf`;

  const overall = viabilityScore.overall ?? '—';
  const verdict = viabilityScore.verdict ?? '—';

  // Verdict colour for email (mirrors the brand badge colours)
  const verdictColour = {
    Strong:   '#2e7d32',
    Moderate: '#f57c00',
    Weak:     '#c62828',
  }[verdict] || '#1C3557';

  // ── Client email ──────────────────────────────────────────────────────────

  const confidenceHtml = confidence
    ? `<tr><td style="padding:8px 0;color:#555;width:160px;"><strong>Data Confidence</strong></td>
       <td><strong>${confidence.score}/100</strong> — ${confidence.interpretation}</td></tr>`
    : '';

  const clientHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1C3557;padding:24px 32px;">
        <h1 style="color:#C8A94A;font-size:22px;margin:0;">McKeever Consulting</h1>
        <p style="color:#8A9BB0;font-size:13px;margin:4px 0 0;">Business Viability Intelligence</p>
      </div>

      <div style="padding:32px;background:#F7F8FA;border:1px solid #e0e0e0;">
        <h2 style="color:#1C3557;margin-top:0;">Your Viability Report is Ready</h2>

        <p style="color:#1E1E2E;">Dear ${client.name},</p>

        <p style="color:#1E1E2E;">
          Your business viability report for <strong>${proposition.title}</strong>
          is attached to this email. Here's the headline finding:
        </p>

        <div style="background:#fff;border-left:4px solid ${verdictColour};padding:16px 20px;margin:24px 0;">
          <p style="margin:0 0 4px;color:#1C3557;font-weight:bold;">Overall Viability Verdict</p>
          <p style="margin:0;color:${verdictColour};font-size:24px;font-weight:bold;">
            ${verdict} &nbsp; ${overall}/5.0
          </p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          <tr><td style="padding:8px 0;color:#555;width:160px;"><strong>Proposition</strong></td>
              <td>${proposition.title}</td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Report Period</strong></td>
              <td>${reportMonth}</td></tr>
          ${confidenceHtml}
        </table>

        <p style="color:#1E1E2E;">
          The full report includes market analysis, competitor research, regulatory landscape,
          financial projections, risk assessment, and prioritised recommendations.
          Please review the attached PDF for the complete findings.
        </p>

        <p style="color:#1E1E2E;">
          If you have any questions about the findings or would like to discuss next steps,
          please reply to this email.
        </p>

        <p style="color:#1E1E2E;">
          Best regards,<br>
          <strong>Brendon McKeever</strong><br>
          McKeever Consulting
        </p>
      </div>

      <div style="padding:16px 32px;background:#1C3557;text-align:center;">
        <p style="color:#8A9BB0;font-size:12px;margin:0;">
          Confidential — Prepared exclusively for ${client.name} by McKeever Consulting
        </p>
      </div>
    </div>
  `;

  const attachment = { filename, content: pdfBase64 };

  // Send personalized email to this recipient
  const clientRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:        FROM_EMAIL,
      to:          [client.email],
      subject:     `${proposition.title} — Viability Report ${reportMonth}`,
      html:        clientHtml,
      attachments: [attachment],
    }),
  });

  if (!clientRes.ok) {
    const body = await clientRes.text();
    throw new Error(`Resend error (client email) ${clientRes.status}: ${body}`);
  }
}

/**
 * Sends a single admin copy to Brendon after all recipient emails are delivered.
 * Lists every recipient who received the report so Brendon has a full delivery record.
 *
 * @param {Array}       recipients    - All client rows who received the report.
 * @param {Object}      proposition   - Proposition row.
 * @param {string}      pdfPath       - Local path to the generated PDF.
 * @param {string}      reportMonth   - Human-readable month string (e.g. "April 2026").
 * @param {Object}      viabilityScore - Score object { overall, verdict, factors }.
 * @param {Object|null} confidence    - Confidence score object or null.
 */
async function sendAdminReportCopy(recipients, proposition, pdfPath, reportMonth, viabilityScore, confidence) {
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');
  const filename  = `McKeever_${proposition.title.replace(/[^a-z0-9]+/gi, '_')}_${reportMonth.replace(' ', '_')}.pdf`;

  const overall = viabilityScore.overall ?? '—';
  const verdict = viabilityScore.verdict ?? '—';

  const verdictColour = {
    Strong:   '#2e7d32',
    Moderate: '#f57c00',
    Weak:     '#c62828',
  }[verdict] || '#1C3557';

  // Build a row for each recipient so Brendon can see exactly who got the report
  const recipientRows = recipients
    .map(r => `<tr><td style="padding:6px 0;color:#555;width:160px;"><strong>Recipient</strong></td>
                    <td>${r.name} &lt;${r.email}&gt;</td></tr>`)
    .join('\n');

  const adminHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1C3557;padding:24px 32px;">
        <h1 style="color:#C8A94A;font-size:22px;margin:0;">McKeever Consulting</h1>
        <p style="color:#8A9BB0;font-size:13px;margin:4px 0 0;">Admin Copy — Report Delivered</p>
      </div>

      <div style="padding:32px;background:#F7F8FA;border:1px solid #e0e0e0;">
        <h2 style="color:#1C3557;margin-top:0;">Report delivered to ${recipients.length} recipient(s)</h2>

        <table style="width:100%;border-collapse:collapse;">
          ${recipientRows}
          <tr><td style="padding:8px 0;color:#555;"><strong>Proposition</strong></td>
              <td>${proposition.title}</td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Verdict</strong></td>
              <td><strong style="color:${verdictColour};">${verdict} (${overall}/5.0)</strong></td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Confidence</strong></td>
              <td>${confidence ? `${confidence.score}/100 — ${confidence.interpretation}` : 'Unavailable'}</td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Report Period</strong></td>
              <td>${reportMonth}</td></tr>
        </table>
      </div>
    </div>
  `;

  const adminRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:        FROM_EMAIL,
      to:          [ADMIN_EMAIL],
      subject:     `[Admin Copy] Report delivered — ${proposition.title} ${reportMonth}`,
      html:        adminHtml,
      attachments: [{ filename, content: pdfBase64 }],
    }),
  });

  if (!adminRes.ok) {
    const body = await adminRes.text();
    throw new Error(`Resend error (admin email) ${adminRes.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Failure alerting
// ---------------------------------------------------------------------------

/**
 * Sends a failure alert email to Brendon when a run fails.
 * Client is NEVER notified of failures.
 *
 * @param {Object}      proposition - The proposition row.
 * @param {Object|null} report      - The report row (may be null if creation failed).
 * @param {Error}       err         - The error that caused the failure.
 */
async function sendFailureAlert(proposition, report, err) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1C3557;padding:24px 32px;">
        <h1 style="color:#C8A94A;font-size:22px;margin:0;">McKeever Consulting</h1>
        <p style="color:#8A9BB0;font-size:13px;margin:4px 0 0;">Report Run Failed</p>
      </div>

      <div style="padding:32px;background:#F7F8FA;border:1px solid #e0e0e0;">
        <h2 style="color:#c0392b;margin-top:0;">&#x26A0; Report generation failed</h2>

        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#555;width:160px;"><strong>Proposition</strong></td>
              <td>${proposition.title}</td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Proposition ID</strong></td>
              <td style="font-size:12px;color:#888;">${proposition.id}</td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Report ID</strong></td>
              <td style="font-size:12px;color:#888;">${report ? report.id : 'not created'}</td></tr>
          <tr><td style="padding:8px 0;color:#555;"><strong>Time</strong></td>
              <td>${new Date().toISOString()}</td></tr>
        </table>

        <div style="background:#fdecea;border-left:4px solid #c0392b;padding:16px 20px;margin:24px 0;">
          <p style="margin:0 0 8px;font-weight:bold;color:#c0392b;">Error</p>
          <pre style="margin:0;font-size:12px;white-space:pre-wrap;color:#333;">${err.message.slice(0, 1000)}</pre>
        </div>

        <p style="color:#555;font-size:13px;">
          To retry this run manually:<br>
          <code style="background:#eee;padding:4px 8px;border-radius:3px;">
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
    console.warn(`  Warning: could not send failure alert email: ${emailErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Single proposition run
// ---------------------------------------------------------------------------

/**
 * Executes the full report pipeline for one proposition.
 * Errors are caught and isolated — other due propositions continue.
 *
 * @param {Object}  proposition - Proposition row.
 * @param {boolean} force       - True if triggered on demand.
 */
async function runProposition(proposition, force) {
  const propStart = Date.now(); // track elapsed time for this proposition
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Proposition: ${proposition.title}`);
  console.log(`ID:          ${proposition.id}`);
  console.log(`Type:        ${proposition.proposition_type}`);
  console.log(`Plan:        ${proposition.plan_tier}`);

  let report = null;

  try {
    // 1. Fetch report recipients — falls back to primary contact if none configured
    let recipients = await getPropositionRecipients(proposition.id);
    if (!recipients.length) {
      const fallback = await getClientById(proposition.client_id);
      recipients = [fallback];
    }
    // Primary contact is used for the assembler prompt and report content
    const client = recipients[0];
    console.log(`Recipients:  ${recipients.map(r => `${r.name} <${r.email}>`).join(', ')}`);

    // 2. Create the report record
    report = await createReportRecord(proposition);

    // 3. Mark as running
    await updateReportStatus(report.id, 'running');
    console.log('✓ Report status → running');

    // 4. Run Perplexity pre-briefings — both are non-fatal; null means agents
    //    fall back to their generic workflow SOPs. Run sequentially (single API).
    const ventureIntelligence   = runVentureIntelligence(proposition);
    const landscapeBriefing     = runCurrentLandscapeBriefing(proposition);

    // 5. Build the shared run context (briefings passed to every research agent)
    const context = {
      reportId:           report.id,
      proposition,
      client,             // primary contact — used for assembler prompt and report content
      recipients,         // all contacts who receive the report email
      runNumber:          report.run_number,
      previousReportId:   report.previous_report_id,
      ventureIntelligence,   // Perplexity: venture type, critical factors, relevant agencies
      landscapeBriefing,     // Perplexity: current market events, regulatory changes, news
    };

    // 6. Run all 10 research sub-agents
    const agentOutputs = await runResearchAgents(context);

    // 6. Quality gate — validates outputs before assembly.
    // Returns list of soft-failed (non-critical) agents so we can retry them.
    const softFailed = checkQuality(agentOutputs);

    // 6b. Retry soft-failed agents once before proceeding to assembly.
    // A single agent failure (e.g. max_tokens on a large output) is often transient.
    // Retrying avoids running the full pipeline again just for one missing section.
    if (softFailed.length > 0) {
      // Map of agent name → runner function (preserves sonnetOnly flags)
      const AGENT_RUNNERS = {
        market_overview: runMarketOverviewAgent,
        competitors:     runCompetitorsAgent,
        regulatory:      runRegulatoryAgent,
        production:      runProductionAgent,
        packaging:       runPackagingAgent,
        distribution:    runDistributionAgent,
        marketing:       runMarketingAgent,
        financials:      runFinancialsAgent,
        origin_ops:      runOriginOpsAgent,
        legal:           runLegalAgent,
      };

      console.log(`\n  Retrying soft-failed agents: ${softFailed.join(', ')}...`);
      // Wait 60 seconds so the rate limit window partially resets before retry
      await new Promise(r => setTimeout(r, 60_000));

      for (const agentName of softFailed) {
        const runner = AGENT_RUNNERS[agentName];
        if (!runner) continue; // safety guard — should never happen
        console.log(`  → retrying ${agentName}...`);
        agentOutputs[agentName] = await runner(context);

        if (agentOutputs[agentName]) {
          console.log(`  ✓ ${agentName} retry succeeded`);
        } else {
          console.log(`  ✗ ${agentName} retry also failed — gap will be noted in report`);
        }
      }

      // Re-run quality gate with updated outputs to confirm we're still good to proceed
      checkQuality(agentOutputs);
    }

    // 7. Pre-assembler cooldown — research agents drain the 50k TPM budget.
    // Wait 2 minutes so the rate limit window resets before the assembler's
    // large single-shot Sonnet call. Assembler has 5 retry attempts if needed.
    console.log('\n  Cooling down 2 minutes before assembler (rate limit recovery)...');
    await new Promise(r => setTimeout(r, 120_000));

    // 8. Run assembler — synthesizes, builds PDF, uploads, emails, marks complete
    await runAssemblerAgent(context, agentOutputs);

    // NOTE: updateReportStatus('complete') is called inside runAssemblerAgent()
    // after successful email delivery. Do not duplicate it here.

    // 8. Advance schedule so this proposition isn't picked up again immediately
    if (proposition.schedule_type && proposition.schedule_type !== 'on_demand') {
      await advancePropositionSchedule(
        proposition.id,
        proposition.schedule_type,
        proposition.schedule_day,
      );
      console.log('✓ Proposition schedule advanced');
    }

    const elapsedMin = ((Date.now() - propStart) / 60_000).toFixed(1);
    console.log(`\n✓ Run complete — Report ID: ${report.id} | Elapsed: ${elapsedMin} min`);
    return { status: 'complete', title: proposition.title, reportId: report?.id, elapsedMin };

  } catch (err) {
    const elapsedMin = ((Date.now() - propStart) / 60_000).toFixed(1);
    console.error(`\n✗ Run failed: ${err.message} | Elapsed: ${elapsedMin} min`);

    if (report) {
      try {
        await updateReportError(report.id, err.message);
        console.error(`  Report ${report.id} marked as failed.`);
      } catch (dbErr) {
        console.error(`  Warning: could not mark report as failed in DB: ${dbErr.message}`);
      }

      // Clean up agent_outputs immediately — they are mid-run scratch data and have
      // no value after a failure. The error is already captured in error_message and
      // emailed via the failure alert below.
      try {
        await deleteAgentOutputsByReportId(report.id);
        console.error(`  Agent outputs for report ${report.id} deleted.`);
      } catch (cleanErr) {
        console.error(`  Warning: could not delete agent outputs: ${cleanErr.message}`);
      }
    }

    await sendFailureAlert(proposition, report, err);
    return { status: 'failed', title: proposition.title, reportId: report?.id, elapsedMin, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// PDF regeneration (--regen-pdf)
// ---------------------------------------------------------------------------

/**
 * Rebuilds the PDF for an existing completed report without re-running any agents.
 * Downloads the content JSON from Supabase Storage, runs generate_report_pdf.py,
 * and saves the result to outputs/ for local review.
 * Does NOT re-email — call is for formatting review / formatting fixes only.
 *
 * @param {string} reportId - UUID of the completed report to regenerate.
 */
async function regenPdfFromStorage(reportId) {
  console.log(`\nRegenerating PDF for report: ${reportId}`);

  // 1. Fetch the report row to get proposition_id and the slug/date for the filename
  const report = await getReportById(reportId);
  if (!report) throw new Error(`Report ${reportId} not found in database`);

  const proposition = await getPropositionById(report.proposition_id);
  if (!proposition) throw new Error(`Proposition ${report.proposition_id} not found`);

  // 2. Download the content JSON from Supabase Storage
  const contentStoragePath = `${proposition.id}/${reportId}_content.json`;
  const { data: fileData, error: downloadError } = await supabase.storage
    .from('reports')
    .download(contentStoragePath);

  if (downloadError) {
    throw new Error(
      `Could not download content JSON from Storage (${contentStoragePath}): ${downloadError.message}\n` +
      `Note: content JSON is only stored for reports run after this feature was added.`
    );
  }

  // 3. Write content JSON to .tmp/ so the PDF script can read it
  const tmpDir      = path.join(__dirname, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const contentFile = path.join(tmpDir, `${reportId}_content.json`);
  const contentText = await fileData.text();
  fs.writeFileSync(contentFile, contentText);
  console.log(`  ✓ Content JSON downloaded`);

  // 4. Determine output filename — mirror the normal naming convention
  const slug         = proposition.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const reportMonth  = new Date(report.created_at).toISOString().slice(0, 7); // YYYY-MM
  const outputsDir   = path.join(__dirname, 'outputs');
  fs.mkdirSync(outputsDir, { recursive: true });
  const pdfFilename  = `${slug}_${reportMonth}_regen.pdf`;
  const pdfPath      = path.join(outputsDir, pdfFilename);
  const pdfScript    = path.join(__dirname, 'tools', 'generate_report_pdf.py');

  // 5. Run the PDF builder against the downloaded content JSON
  console.log('  Building PDF...');
  try {
    execSync(
      `${PYTHON} "${pdfScript}" --report-id "${reportId}" --content "${contentFile}" --output "${pdfPath}"`,
      { stdio: 'inherit', cwd: __dirname, timeout: 120_000 }
    );
  } catch (err) {
    throw new Error(`PDF generation failed: ${err.message}`);
  }
  console.log(`  ✓ PDF saved → ${pdfPath}`);

  // 6. Clean up the local content JSON (already stored in Supabase)
  try { fs.unlinkSync(contentFile); } catch (_) { /* Non-fatal */ }

  console.log('\nReview the PDF at the path above.');
  console.log('To re-upload and re-email, run the full pipeline with --force.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Parses args, finds propositions to run, runs each one.
 */
async function main() {
  const startTime = Date.now(); // capture for elapsed time at end
  console.log('McKeever Consulting — Report Orchestrator');
  console.log(`Started: ${new Date().toISOString()}`);

  const args = parseArgs();

  // --regen-pdf: rebuild a PDF from stored content JSON, skip all agents and email
  if (args.regenPdf) {
    await regenPdfFromStorage(args.reportId);
    return;
  }

  let propositions;
  try {
    propositions = await getPropositionsToRun(args);
  } catch (err) {
    console.error(`\nFatal: could not load propositions — ${err.message}`);
    process.exit(1);
  }

  if (propositions.length === 0) {
    process.exit(0);
  }

  const results = [];
  for (const proposition of propositions) {
    const result = await runProposition(proposition, args.force);
    results.push(result);
  }

  const elapsedMin = ((Date.now() - startTime) / 60_000).toFixed(1);
  const completed = results.filter(r => r.status === 'complete').length;
  const failed    = results.filter(r => r.status === 'failed').length;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Finished:  ${new Date().toISOString()}`);
  console.log(`Elapsed:   ${elapsedMin} minutes`);
  console.log(`Processed: ${propositions.length} proposition(s) — ${completed} completed, ${failed} failed`);

  // Per-proposition outcome summary
  for (const r of results) {
    const icon  = r.status === 'complete' ? '✓' : '✗';
    const label = r.status === 'complete' ? 'COMPLETE' : 'FAILED';
    console.log(`  ${icon} [${label}] ${r.title} (${r.elapsedMin} min)${r.error ? ` — ${r.error.slice(0, 100)}` : ''}`);
  }
}

main().catch(err => {
  console.error('\nFatal unhandled error:', err.message);
  process.exit(1);
});
