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
  getAgentOutputsByReportId,
  createReport,
  updateReportStatus,
  updateReportPdfUrl,
  updateReportError,
  saveAgentOutput,
  saveReportSource,
  advancePropositionSchedule,
} = require('./db');

// ---------------------------------------------------------------------------
// Clients & constants
// ---------------------------------------------------------------------------

// Anthropic client — long timeout for the assembler's large Sonnet call
const anthropic = new Anthropic({
  apiKey:  process.env.ANTHROPIC_API_KEY,
  timeout: 600_000, // 10 minutes — assembler can produce ~30k tokens
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

    const response = await anthropic.messages.create(createParams);

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

  if (result.force && !result.propositionId) {
    console.error('Error: --force requires --proposition-id <uuid>');
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
  const runNumber = history.length + 1;

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
async function runResearchAgent(agentName, context) {
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

  const userPrompt = `Execute this research workflow and produce the JSON output.

## WORKFLOW INSTRUCTIONS
${workflow}

## PROPOSITION CONTEXT
\`\`\`json
${JSON.stringify(propositionContext, null, 2)}
\`\`\`

Follow all steps in the workflow. Use the tools to run the required searches and data pulls.
Synthesize the results and respond with ONLY the JSON object from the Output Format section.`;

  let rawOutput;
  try {
    rawOutput = await callClaude({
      model:      'claude-haiku-4-5-20251001',
      system:     systemPrompt,
      userPrompt,
      tools:      RESEARCH_TOOLS,
      maxTokens:  8096,
      maxIter:    50, // Research agents make many tool calls (6+ searches + gov data)
    });
  } catch (err) {
    // Log and save failure to DB — non-critical agents continue, critical ones rethrow
    console.error(`      ✗ ${agentName} failed: ${err.message.slice(0, 200)}`);
    await saveAgentOutput({
      report_id:  context.reportId,
      agent_name: `research_${agentName}`,
      status:     'failed',
      output:     { error: err.message },
    });
    return null;
  }

  // Parse the JSON output
  let parsed;
  try {
    parsed = parseJSON(rawOutput);
  } catch (parseErr) {
    console.error(`      ✗ ${agentName} output parse failed: ${parseErr.message.slice(0, 200)}`);
    await saveAgentOutput({
      report_id:  context.reportId,
      agent_name: `research_${agentName}`,
      status:     'failed',
      output:     { error: `JSON parse failed: ${parseErr.message}`, raw: rawOutput.slice(0, 500) },
    });
    return null;
  }

  // Save the structured output to the DB
  await saveAgentOutput({
    report_id:  context.reportId,
    agent_name: `research_${agentName}`,
    status:     'complete',
    output:     parsed,
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
  return runResearchAgent('financials', context);
}
async function runOriginOpsAgent(context) {
  return runResearchAgent('origin_ops', context);
}
async function runLegalAgent(context) {
  return runResearchAgent('legal', context);
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
        previousOutputs[row.agent_name] = row.output;
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

  // 7. Call Claude Sonnet — pure synthesis, no tools needed
  console.log('    Calling Claude Sonnet for report synthesis...');
  const rawContent = await callClaude({
    model:      'claude-sonnet-4-6',
    system:     systemPrompt,
    userPrompt,
    tools:      [],        // No tools — assembler only synthesizes, does not search
    maxTokens:  32_000,    // Full report JSON can be ~15-25k tokens
    maxIter:    1,         // Single turn — no tool loops
  });

  // 8. Parse the content JSON
  let contentJson;
  try {
    contentJson = parseJSON(rawContent);
  } catch (parseErr) {
    throw new Error(`Assembler output parse failed: ${parseErr.message}. First 400 chars: ${rawContent.slice(0, 400)}`);
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

  // 12. Email the report to the client
  const viabilityScore = contentJson.viability_score || {};
  await sendReportEmail(client, proposition, pdfPath, reportMonth, viabilityScore, confidence);
  console.log(`    ✓ Report emailed to ${client.email}`);

  // 13. Mark report complete — assembler owns this transition
  await updateReportStatus(reportId, 'complete');
  console.log('  ✓ Report status → complete');

  // 14. Clean up content JSON (PDF stays in outputs/ for local reference)
  try { fs.unlinkSync(contentFile); } catch (_) { /* Non-fatal */ }
}

// ---------------------------------------------------------------------------
// Report email delivery
// ---------------------------------------------------------------------------

/**
 * Sends the completed report PDF to the client via Resend.
 * Attaches the PDF as base64 so the client receives it directly.
 * Also sends an admin copy to Brendon.
 *
 * @param {Object} client         - Client row.
 * @param {Object} proposition    - Proposition row.
 * @param {string} pdfPath        - Local path to the generated PDF.
 * @param {string} reportMonth    - Human-readable month string (e.g. "April 2026").
 * @param {Object} viabilityScore - Score object { overall, verdict, factors }.
 * @param {Object|null} confidence - Confidence score object or null.
 */
async function sendReportEmail(client, proposition, pdfPath, reportMonth, viabilityScore, confidence) {
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

  // ── Admin copy to Brendon ─────────────────────────────────────────────────

  const adminHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1C3557;padding:24px 32px;">
        <h1 style="color:#C8A94A;font-size:22px;margin:0;">McKeever Consulting</h1>
        <p style="color:#8A9BB0;font-size:13px;margin:4px 0 0;">Admin Copy — Report Delivered</p>
      </div>

      <div style="padding:32px;background:#F7F8FA;border:1px solid #e0e0e0;">
        <h2 style="color:#1C3557;margin-top:0;">Report delivered to ${client.name}</h2>

        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#555;width:160px;"><strong>Client</strong></td>
              <td>${client.name} &lt;${client.email}&gt;</td></tr>
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

  const attachment = { filename, content: pdfBase64 };

  // Send to client
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

  // Send admin copy to Brendon
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
      attachments: [attachment],
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
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Proposition: ${proposition.title}`);
  console.log(`ID:          ${proposition.id}`);
  console.log(`Type:        ${proposition.proposition_type}`);
  console.log(`Plan:        ${proposition.plan_tier}`);

  let report = null;

  try {
    // 1. Fetch the client for email delivery
    const client = await getClientById(proposition.client_id);
    console.log(`Client:      ${client.name} <${client.email}>`);

    // 2. Create the report record
    report = await createReportRecord(proposition);

    // 3. Mark as running
    await updateReportStatus(report.id, 'running');
    console.log('✓ Report status → running');

    // 4. Build the shared run context
    const context = {
      reportId:         report.id,
      proposition,
      client,
      runNumber:        report.run_number,
      previousReportId: report.previous_report_id,
    };

    // 5. Run all 10 research sub-agents
    const agentOutputs = await runResearchAgents(context);

    // 6. Quality gate — validates outputs before assembly
    checkQuality(agentOutputs);

    // 7. Run assembler — synthesizes, builds PDF, uploads, emails, marks complete
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

    console.log(`\n✓ Run complete — Report ID: ${report.id}`);

  } catch (err) {
    console.error(`\n✗ Run failed: ${err.message}`);

    if (report) {
      try {
        await updateReportError(report.id, err.message);
        console.error(`  Report ${report.id} marked as failed.`);
      } catch (dbErr) {
        console.error(`  Warning: could not mark report as failed in DB: ${dbErr.message}`);
      }
    }

    await sendFailureAlert(proposition, report, err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Parses args, finds propositions to run, runs each one.
 */
async function main() {
  console.log('McKeever Consulting — Report Orchestrator');
  console.log(`Started: ${new Date().toISOString()}`);

  const args = parseArgs();

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

  for (const proposition of propositions) {
    await runProposition(proposition, args.force);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Finished: ${new Date().toISOString()}`);
  console.log(`Processed: ${propositions.length} proposition(s)`);
}

main().catch(err => {
  console.error('\nFatal unhandled error:', err.message);
  process.exit(1);
});
