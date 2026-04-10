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
const FROM_EMAIL  = 'McKeever Consulting <onboarding@resend.dev>';

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
    if (!sonnetOnly) {
      // --- Haiku attempt ---
      let haikusErr  = null;
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
        maxTokens:  8096,
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
  return runResearchAgent('packaging', context);
}
async function runDistributionAgent(context) {
  return runResearchAgent('distribution', context);
}
async function runMarketingAgent(context) {
  return runResearchAgent('marketing', context);
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
// Assembler agent
// ---------------------------------------------------------------------------

/**
 * Runs the assembler agent (Claude Sonnet).
 * Synthesizes all 10 research outputs into a complete report, computes the
 * viability score, writes the content JSON, generates the PDF, uploads to
 * Supabase Storage, and delivers by email.
 *
 * This function owns the final `updateReportStatus('complete')` transition.
 *
 * @param {Object} context      - Run context.
 * @param {Object} agentOutputs - Map of agent_name → parsed research output.
 */
async function runAssemblerAgent(context, agentOutputs) {
  console.log('\n  Running assembler (Claude Sonnet)...');

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
  const now         = new Date();
  const reportMonth = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const reportYYYYMM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // 5. Build the proposition slug for file naming
  const slug = proposition.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // 6. Build the assembler prompt
  const systemPrompt = `You are the report assembler for McKeever Consulting's Business Viability Intelligence System.

Your role is to synthesise the outputs of 10 research agents into a complete, professional business viability report.

CRITICAL RULES:
1. Compute the viability score from the research outputs using the scoring guide in the workflow
2. Write all report sections in plain, professional English — no bullet-point walls, use paragraphs
3. Every claim must be traceable to the research data provided — do not invent figures
4. Your response must be ONLY the content JSON object following the exact schema provided
5. Do not wrap it in markdown code fences — raw JSON only
6. Do not include any text before or after the JSON
7. Every section must have at least 1 paragraph block — no empty sections`;

  const userPrompt = `Assemble a complete viability report from the research outputs below.

## ASSEMBLER WORKFLOW
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
  client: {
    name:  client.name,
    email: client.email,
  },
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

${previousOutputs ? `## PREVIOUS REPORT OUTPUTS (for "What Changed" section)
\`\`\`json
${JSON.stringify(previousOutputs, null, 2)}
\`\`\`` : '## PREVIOUS REPORT OUTPUTS\nThis is run #1 — no previous outputs. Omit the "What Changed" section.'}

## CONTENT JSON SCHEMA
Produce a JSON object matching this exact structure:

\`\`\`
{
  "meta": {
    "proposition_title": "${proposition.title}",
    "proposition_slug":  "${slug}",
    "client_name":       "${client.name}",
    "report_date":       "${reportMonth}",
    "run_number":        ${runNumber},
    "data_confidence": {
      "score":          <0-100 number or null>,
      "interpretation": "<High|Moderate|Low|Very Low|Unavailable>",
      "description":    "<one sentence>"
    }
  },
  "viability_score": {
    "overall": <weighted score rounded to 1 decimal — range 1.0-5.0>,
    "verdict": "<Strong|Moderate|Weak>",
    "factors": [
      {
        "name":     "<factor_key>",
        "label":    "<Human-readable label>",
        "score":    <1-5>,
        "weight":   <0-1>,
        "rationale": "<one sentence plain English>"
      }
      // 6 factors total: market_demand, regulatory, competitive, financial, supply_chain, risk
    ]
  },
  "sections": [
    {
      "id":     "<snake_case_section_id>",
      "title":  "<Section Title>",
      "number": <section number>,
      "blocks": [
        { "type": "paragraph",   "text": "..." },
        { "type": "bullets",     "label": "Optional heading", "items": ["...", "..."] },
        { "type": "table",       "headers": ["Col1","Col2"], "rows": [["a","b"]] },
        { "type": "callout",     "label": "Key Finding", "text": "..." },
        { "type": "key_figures", "items": [{"label": "...", "value": "..."}] }
      ]
    }
    // Sections 3-13 always present. Section 14 (what_changed) only on run 2+.
    // Section 15 (sources) always present.
  ],
  "sources": [
    { "url": "...", "title": "...", "agent_name": "...", "retrieved_at": "<ISO timestamp>" }
  ],
  "what_changed": ${runNumber > 1 ? '["<bullet 1>", "<bullet 2>"]' : 'null'}
}
\`\`\`

Sections to include (in order):
- 3: Executive Summary — 1 page max, leads with verdict, key findings, top 3 risks, top 3 opportunities. Include data confidence as a key_figures block.
- 4: Market Overview
- 5: Competitor Analysis
- 6: Regulatory Landscape — flag any hard blockers prominently
- 7: Production & Equipment
- 8: Packaging
- 9: Distribution Strategy
- 10: Marketing & Influencers
- 11: Financial Projections — include unit economics table and startup capital table
- 12: Risk Assessment — rate each risk: likelihood × impact
- 13: Recommendations — 5-7 prioritised, actionable items
${runNumber > 1 ? '- 14: What Changed This Month — delta bullets comparing previous and current outputs' : ''}
- ${runNumber > 1 ? '15' : '14'}: Sources — full URL list grouped by section

Now produce the complete content JSON.`;

  // 7. Call Claude Sonnet via streaming — pure synthesis, no tools needed.
  // Streaming is required here because the response is 15-25k tokens; a non-streaming
  // request at that size can exceed the SDK's 10-minute timeout before the full response
  // arrives. Streaming has no total-response timeout — only a between-chunks timeout —
  // so it works regardless of generation time.
  console.log('    Calling Claude Sonnet for report synthesis (streaming)...');
  let rawContent;
  let assemblerAttempts = 0;
  while (true) {
    assemblerAttempts++;
    try {
      rawContent = await anthropic.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens: 32_000,    // Full report JSON can be ~15-25k tokens
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }).finalText();
      break; // success
    } catch (streamErr) {
      const is429 = streamErr.status === 429 ||
        (streamErr.message && streamErr.message.includes('rate_limit_error'));
      if (is429 && assemblerAttempts <= 5) {
        const waitSec = 60 * assemblerAttempts; // 60s, 120s, 180s, 240s, 300s
        console.warn(`      ⚠ Assembler rate limited (429) — waiting ${waitSec}s before retry ${assemblerAttempts}/5...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw new Error(`Assembler Sonnet call failed after ${assemblerAttempts} attempt(s): ${streamErr.message}`);
      }
    }
  }

  // 8. Parse the content JSON — with JSON repair retries.
  // If Sonnet returns malformed JSON (truncated output, mismatched braces, etc.),
  // we send a follow-up message showing the bad output and asking it to fix it.
  // Each repair attempt costs ~$0.50-1 — far cheaper than losing the whole run.
  // Max 3 repair attempts before giving up.
  const MAX_JSON_REPAIRS = 3;
  let contentJson;
  let parseMessages = [{ role: 'user', content: userPrompt }]; // conversation history for repairs

  for (let attempt = 1; attempt <= MAX_JSON_REPAIRS + 1; attempt++) {
    // On attempt 1, rawContent is already set from the streaming call above.
    // On repair attempts, rawContent is set at the end of the previous iteration.
    try {
      contentJson = parseJSON(rawContent);
      if (attempt > 1) {
        console.log(`    ✓ JSON repaired on attempt ${attempt}`);
      }
      break; // valid JSON — exit the repair loop
    } catch (parseErr) {
      if (attempt > MAX_JSON_REPAIRS) {
        // All repair attempts exhausted — surface a useful error
        throw new Error(
          `Assembler JSON parse failed after ${MAX_JSON_REPAIRS} repair attempt(s): ` +
          `${parseErr.message}. First 400 chars: ${rawContent.slice(0, 400)}`
        );
      }

      console.warn(`    ⚠ Assembler JSON parse failed (attempt ${attempt}/${MAX_JSON_REPAIRS}) — requesting repair from Sonnet...`);

      // Build the repair conversation: show Sonnet what it returned and ask it to fix it
      parseMessages.push({ role: 'assistant', content: rawContent });
      parseMessages.push({
        role: 'user',
        content:
          `Your previous response was not valid JSON and could not be parsed.\n\n` +
          `Parse error: ${parseErr.message}\n\n` +
          `Please return ONLY the corrected JSON object — no markdown fences, ` +
          `no explanation, no text before or after. Fix any truncation, unclosed braces, ` +
          `or invalid syntax. The structure must match the schema provided earlier.`,
      });

      // Stream the repair attempt
      try {
        rawContent = await anthropic.messages.stream({
          model:      'claude-sonnet-4-6',
          max_tokens: 32_000,
          system:     systemPrompt,
          messages:   parseMessages,
        }).finalText();
      } catch (repairErr) {
        throw new Error(`Assembler JSON repair attempt ${attempt} failed: ${repairErr.message}`);
      }
    }
  }

  // 9. Write content JSON to .tmp/ for the PDF builder
  const tmpDir      = path.join(__dirname, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const contentFile = path.join(tmpDir, `${reportId}_content.json`);
  fs.writeFileSync(contentFile, JSON.stringify(contentJson, null, 2));
  console.log(`    ✓ Content JSON written: ${contentFile}`);

  // 10. Run the PDF builder
  const outputsDir = path.join(__dirname, 'outputs');
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

  // 11. Upload PDF to Supabase Storage (reports bucket)
  const storagePath = `${proposition.id}/${reportId}.pdf`;
  const pdfBuffer   = fs.readFileSync(pdfPath);

  const { error: uploadError } = await supabase.storage
    .from('reports')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert:      true,   // Overwrite if re-running the same report
    });

  if (uploadError) {
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
  }

  // Create a signed URL valid for 7 days (for email attachment link)
  const { data: signedData, error: signedError } = await supabase.storage
    .from('reports')
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

  if (signedError) {
    throw new Error(`Could not create signed URL: ${signedError.message}`);
  }

  const pdfUrl = signedData.signedUrl;
  await updateReportPdfUrl(reportId, pdfUrl);
  console.log(`    ✓ PDF uploaded to Storage`);

  // 11b. Upload the content JSON to Storage alongside the PDF.
  //      This enables --regen-pdf to rebuild the PDF from stored data without
  //      re-running any agents. Stored at {proposition_id}/{reportId}_content.json.
  const contentStoragePath = `${proposition.id}/${reportId}_content.json`;
  const { error: contentUploadError } = await supabase.storage
    .from('reports')
    .upload(contentStoragePath, JSON.stringify(contentJson, null, 2), {
      contentType: 'application/json',
      upsert:      true,
    });

  if (contentUploadError) {
    // Non-fatal — log a warning but don't abort. The PDF is already delivered.
    console.warn(`    ⚠ Content JSON upload failed (non-fatal): ${contentUploadError.message}`);
  } else {
    console.log(`    ✓ Content JSON uploaded to Storage`);
  }

  // 12. Email the report to all recipients, then send one admin copy listing everyone
  const viabilityScore = contentJson.viability_score || {};
  for (const recipient of context.recipients) {
    await sendReportEmail(recipient, proposition, pdfPath, reportMonth, viabilityScore, confidence);
    console.log(`    ✓ Report emailed to ${recipient.email}`);
  }
  await sendAdminReportCopy(context.recipients, proposition, pdfPath, reportMonth, viabilityScore, confidence);
  console.log(`    ✓ Admin copy sent (${context.recipients.length} recipient(s) notified)`);

  // 13. Mark report complete — assembler owns this transition
  await updateReportStatus(reportId, 'complete');
  console.log('  ✓ Report status → complete');

  // 14. Clean up — local temp files and DB agent_outputs.
  //     agent_outputs are large JSONB blobs only needed during the research→assembly
  //     window. Delete them now that the PDF is built and delivered.
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

    // 6. Quality gate — validates outputs before assembly
    checkQuality(agentOutputs);

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
