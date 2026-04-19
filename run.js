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
  getPropositionContext,
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
  {
    name:        'fetch_bls_data',
    description: 'Fetch employment and wage benchmarks from the Bureau of Labor Statistics (BLS). Use for production labor cost modeling, workforce availability analysis, and comparing wage assumptions against industry norms. No API key required.',
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['wages', 'employment', 'series'],
                    description: 'wages = avg hourly/weekly earnings benchmarks; employment = employment level trends; series = fetch specific BLS series by ID' },
        sector:   { type: 'string', enum: ['all', 'durable', 'nondurable'], default: 'all',
                    description: 'Manufacturing sector (employment command only). Durable includes furniture (NAICS 337) and wood products (NAICS 321).' },
        ids:      { type: 'string',
                    description: 'Comma-separated BLS series IDs (series command only — e.g. "CES3000000008,CES3200000001")' },
        start:    { type: 'integer', description: 'Start year (default: 2021)', default: 2021 },
        end:      { type: 'integer', description: 'End year (default: 2024)', default: 2024 },
      },
      required: ['command'],
    },
  },
  {
    name:        'fetch_epa_data',
    description: 'Fetch EPA regulatory and enforcement data. ECHO facility search shows compliance burden by NAICS/state. TRI shows toxic chemical releases by industry. Use for regulatory risk assessment in manufacturing propositions.',
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['facilities', 'tri'],
                    description: 'facilities = ECHO compliance search by NAICS and state; tri = Toxic Release Inventory data' },
        naics:    { type: 'string', description: 'NAICS code prefix (e.g. "337" for furniture, "321" for wood products)' },
        state:    { type: 'string', description: '2-letter US state abbreviation (optional — omit for national)' },
        chemical: { type: 'string', description: 'Chemical name to filter TRI results (tri command only — e.g. "formaldehyde")' },
        year:     { type: 'integer', description: 'TRI reporting year (tri command only, default: 2022)', default: 2022 },
        limit:    { type: 'integer', description: 'Max results (default 20)', default: 20 },
      },
      required: ['command'],
    },
  },
  {
    name:        'fetch_itc_data',
    description: 'Fetch ITC trade remedy case notices and US import statistics. Use to identify anti-dumping/CVD actions affecting an industry, assess tariff risk, and size import competition by country of origin.',
    input_schema: {
      type: 'object',
      properties: {
        command:      { type: 'string', enum: ['cases', 'imports'],
                        description: 'cases = Federal Register trade remedy case search (AD/CVD/safeguards); imports = Census Bureau annual import statistics by NAICS' },
        term:         { type: 'string',
                        description: 'Search term for trade remedy cases (cases command — e.g. "furniture anti-dumping", "wood products 301")' },
        naics:        { type: 'string',
                        description: 'NAICS code for import statistics (imports command — e.g. "337" for furniture)' },
        year:         { type: 'integer', description: 'Data year for import stats (imports command, default: 2022)', default: 2022 },
        country_code: { type: 'string',
                        description: 'Census country code filter for imports (optional — e.g. "5700" = China, "5030" = Canada)' },
        limit:        { type: 'integer', description: 'Max results for cases command (default 15)', default: 15 },
      },
      required: ['command'],
    },
  },

  // ---------------------------------------------------------------------------
  // International economic data tools (no API key required)
  // ---------------------------------------------------------------------------
  {
    name: 'fetch_world_bank',
    description: (
      'Fetch World Bank development indicators for any country. No API key required. ' +
      'Use for international propositions to get GDP, GDP per capita, population, inflation, trade openness, ' +
      'FDI inflows, internet penetration, and poverty rate. ' +
      'Use "indicators" for a full country profile. Use "compare" to contrast two countries side-by-side. ' +
      'Call this whenever the proposition involves a non-US origin or target country.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:   { type: 'string', enum: ['indicators', 'compare'], default: 'indicators',
                     description: 'indicators = full country profile; compare = side-by-side two countries' },
        country:   { type: 'string', description: 'ISO-2 country code (e.g. US, SO, DE, CN, AE, IN)' },
        country2:  { type: 'string', description: 'Second country for compare command (ISO-2)' },
        indicator: { type: 'string', description: 'World Bank indicator code for compare command (default: NY.GDP.PCAP.CD)' },
        year:      { type: 'integer', description: 'Specific year (default: most recent available)' },
      },
      required: ['country'],
    },
  },
  {
    name: 'fetch_imf_data',
    description: (
      'Fetch IMF macroeconomic indicators for any country. No API key required. ' +
      'Use for international propositions to assess economic stability, inflation trajectory, ' +
      'current account balance, unemployment, and government debt. ' +
      'Use "indicators" for current snapshot; "outlook" for growth and inflation trajectory (forecast included). ' +
      'Call for origin country risk assessment and target market economic context. ' +
      'Complements World Bank data — IMF focuses on macroeconomic stability and forecasts.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['indicators', 'outlook'], default: 'indicators',
                   description: 'indicators = current macroeconomic snapshot; outlook = GDP growth and inflation trajectory with IMF forecasts' },
        country: { type: 'string', description: 'IMF 3-letter country code (e.g. USA, SOM, DEU, CHN, ARE, IND)' },
      },
      required: ['country'],
    },
  },
  {
    name: 'fetch_oecd_data',
    description: (
      'Fetch OECD economic and trade statistics. No API key required. Covers 38 OECD member economies only ' +
      '(US, EU countries, Japan, Canada, Australia, South Korea, Mexico, etc.). ' +
      'Use when target market is an OECD country — national accounts, trade flows, labour market data. ' +
      'Do NOT use for non-OECD countries (Somalia, most of Africa/Middle East) — use World Bank instead.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['indicators', 'trade'], default: 'indicators',
                   description: 'indicators = key economic indicators; trade = bilateral trade flows' },
        country: { type: 'string', description: 'ISO-3 country code — OECD members only (e.g. USA, DEU, GBR, JPN, AUS)' },
        partner: { type: 'string', description: 'Partner country ISO-3 for bilateral trade filter (trade command only)' },
      },
      required: ['country'],
    },
  },
  {
    name: 'fetch_eurostat_data',
    description: (
      'Fetch Eurostat EU market and trade statistics. No API key required. ' +
      'Use when the target market is the EU or a specific EU country. ' +
      '"trade" command fetches EU import/export flows by CN product code — critical for EU market sizing. ' +
      '"industry" command fetches EU industrial production index by NACE sector. ' +
      '"market" command fetches GDP, population, and household income for an EU country. ' +
      'Call this for any proposition targeting EU or European markets.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:      { type: 'string', enum: ['trade', 'industry', 'market'],
                        description: 'trade = EU imports/exports by CN product code; industry = production index by NACE sector; market = country GDP/population/income profile' },
        product_code: { type: 'string', description: 'CN (8-digit) or HS (6-digit) code for trade command (e.g. "04039090" for specialty dairy)' },
        nace_code:    { type: 'string', description: 'NACE Rev.2 code for industry command (e.g. C10=food, C31=furniture, C26=electronics)' },
        country:      { type: 'string', description: 'EU country ISO-2 or "EU" for aggregate. Examples: DE, FR, NL, IT, EU' },
        reporter:     { type: 'string', description: 'EU reporter country for trade command (optional — defaults to EU27 aggregate)' },
        year:         { type: 'integer', description: 'Data year (default: 2022)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_fao_data',
    description: (
      'Fetch FAO (UN Food and Agriculture Organization) global food and agricultural data. No API key required. ' +
      'Use for any food, beverage, or agricultural proposition regardless of country. ' +
      '"production" = crop/livestock production volumes by country and year. ' +
      '"trade" = global agricultural export/import flows. ' +
      '"prices" = producer prices at farm gate. ' +
      'Critical for: supply availability assessment, competitor country production volumes, ' +
      'global trade flow sizing, and price benchmarking for food/ag commodities.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['production', 'trade', 'prices'],
                    description: 'production = volumes by country; trade = export/import flows; prices = producer price at farm gate' },
        item:     { type: 'string', description: 'FAO commodity name (e.g. "Camel milk", "Milk", "Wheat", "Cattle", "Sugar cane")' },
        country:  { type: 'string', description: 'Country name or ISO-2 code for production/prices (default: World aggregate)' },
        reporter: { type: 'string', description: 'Reporting/exporting country for trade command' },
        partner:  { type: 'string', description: 'Partner/importing country for trade command (optional filter)' },
        year:     { type: 'string', description: 'Year or comma-separated years (e.g. "2022" or "2020,2021,2022")' },
      },
      required: ['command', 'item'],
    },
  },
  {
    name: 'fetch_wto_data',
    description: (
      'Fetch US tariff schedule (HTS) rates and import trade statistics. No API key required. ' +
      '"hts" = look up the MFN tariff rate for a product by HTS code — use for any import proposition. ' +
      '"imports" = US import volume/value for an HTS code from Census data. ' +
      '"tariff" = tariff corridor context for a specific country→US trade route, including FTA status and AGOA eligibility. ' +
      'Call "hts" and "tariff" for all import/export propositions to establish landed cost baseline.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['hts', 'imports', 'tariff'],
                    description: 'hts = US tariff rate lookup; imports = US import volume stats; tariff = corridor context with FTA/AGOA status' },
        hts_code: { type: 'string', description: 'HTS code (e.g. "0403.90" for specialty dairy, "9403.30" for furniture)' },
        country:  { type: 'string', description: 'Origin country for tariff command (e.g. "Somalia", "Germany", "China")' },
        year:     { type: 'integer', description: 'Data year for imports command (default: 2022)' },
      },
      required: ['command'],
    },
  },

  // ---------------------------------------------------------------------------
  // International trade flows
  // ---------------------------------------------------------------------------
  {
    name: 'fetch_un_comtrade',
    description: (
      'Fetch bilateral trade flow data from UN Comtrade — official trade statistics for all countries, by HS commodity code. ' +
      'Requires UN_COMTRADE_API_KEY. Free tier: 500 req/hr. Data typically lags 1–2 years (2023 is current). ' +
      '"bilateral" returns export and import values between two specific countries for a product. ' +
      '"top_partners" returns the top trading partners for a country/product combination — use to find who a country actually trades with. ' +
      'Always requires an HS code — use 6-digit HS codes for specificity (e.g. 040210 = milk powder, 940360 = wooden furniture). ' +
      'IMPORTANT LIMITATION: HS codes aggregate all sub-types within a category — species, material, grade, and origin are not separated at the 6-digit level. ' +
      'A country appearing as a top supplier means they supply that commodity class broadly, not necessarily the specific product in this proposition. ' +
      'Always cross-reference Comtrade volume data with web_search or search_exa to verify what actually comprises the reported trade flow. ' +
      'Use Comtrade for: verifying a trade route exists, sizing the total commodity category, identifying the import landscape. ' +
      'Treat results as a market-sizing proxy — not as direct proof of competitor activity in the specific product.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['bilateral', 'top_partners'],
                    description: 'bilateral = flows between two specific countries; top_partners = ranked list of trading partners' },
        reporter: { type: 'string', description: 'Reporting country ISO-3 code (e.g. SOM, USA, ARE, DEU, KEN)' },
        partner:  { type: 'string', description: 'Partner country ISO-3 code — bilateral command only (e.g. USA, CHN, GBR)' },
        hs_code:  { type: 'string', description: '6-digit HS commodity code (e.g. 040210 = milk powder, 940360 = wooden furniture, 620342 = cotton trousers)' },
        flow:     { type: 'string', enum: ['X', 'M'], description: 'X = exports, M = imports — top_partners command only (default: X)' },
        year:     { type: 'integer', description: 'Trade year (default: 2023 — most recent reliable data)' },
        count:    { type: 'integer', description: 'Number of partners to return for top_partners command (default 10, max 20)' },
      },
      required: ['command', 'reporter', 'hs_code'],
    },
  },

  // ---------------------------------------------------------------------------
  // Global news
  // ---------------------------------------------------------------------------
  {
    name: 'fetch_gdelt_news',
    description: (
      'Search global news via GDELT Project — 170+ countries, 65+ languages, updated every 15 minutes. No API key required. ' +
      '"search" returns recent news articles matching a keyword, optionally filtered by country. ' +
      '"timeline" returns normalised volume trend — shows if coverage is growing or shrinking. ' +
      'Use for: international market news, competitor mentions in non-English media, country stability signals, ' +
      'regulatory change news, and trend detection. ' +
      'Call this for any proposition with an international component or when US web search returns thin results.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['search', 'timeline'], default: 'search',
                   description: 'search = recent articles list; timeline = normalised volume trend over time' },
        query:   { type: 'string', description: 'Search query (e.g. "camel milk export", "furniture tariff", "solar panel regulation")' },
        country: { type: 'string', description: 'Filter by country (e.g. "Somalia", "Germany", "US"). Omit for global results.' },
        limit:   { type: 'integer', default: 10, description: 'Max articles for search command (default 10, max 25)' },
      },
      required: ['query'],
    },
  },

  // ---------------------------------------------------------------------------
  // US government industry-specific tools
  // ---------------------------------------------------------------------------
  {
    name: 'fetch_doe_data',
    description: (
      'Fetch DOE EIA energy price benchmarks and NREL renewable resource data. No API key required for reference data; ' +
      'add EIA_API_KEY to .env for live state-level data. ' +
      '"electricity" = retail electricity prices by state — use for production facility cost modeling. ' +
      '"natural_gas" = industrial gas prices. ' +
      '"renewables" = NREL solar/wind resource quality by state — use for energy/solar propositions. ' +
      '"fuel_costs" = cross-fuel benchmark table for production planning. ' +
      'Call this for any proposition involving manufacturing, energy, food processing, or solar/renewable products.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['electricity', 'natural_gas', 'renewables', 'fuel_costs'],
                   description: 'electricity = retail electricity by state; natural_gas = industrial gas prices; renewables = solar/wind resource; fuel_costs = cross-fuel benchmark table' },
        state:   { type: 'string', description: '2-letter US state code (e.g. TX, CA, MN). Omit for national average.' },
        sector:  { type: 'string', description: 'Industry sector for fuel_costs context (e.g. food_processing, furniture, electronics)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_fda_device_data',
    description: (
      'Fetch FDA medical device clearances, approvals, and safety data via openFDA. No API key required (40 req/min keyless). ' +
      '"clearances" = 510(k) premarket notifications — use to find predicate devices and understand clearance precedents. ' +
      '"pma" = PMA approvals for Class III (high-risk) devices. ' +
      '"recalls" = device recall history — use for product safety risk assessment. ' +
      '"events" = MAUDE adverse event reports. ' +
      'Call this for any medical device or diagnostic equipment proposition.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['clearances', 'pma', 'recalls', 'events'],
                   description: 'clearances = 510(k) notifications; pma = Class III approvals; recalls = enforcement actions; events = MAUDE adverse events' },
        query:   { type: 'string', description: 'Device name or type (e.g. "glucose monitor", "orthopedic implant", "diagnostic imaging")' },
        limit:   { type: 'integer', default: 15, description: 'Max results (default 15)' },
      },
      required: ['command', 'query'],
    },
  },
  {
    name: 'fetch_bis_data',
    description: (
      'Fetch BIS (Bureau of Industry and Security) export control classifications and notices. No API key required. ' +
      '"eccn" = Export Control Classification Number guidance for a product type — use for electronics, chemicals, software. ' +
      '"search" = BIS Federal Register notices for recent export control updates. ' +
      '"screening" = restricted party and embargo destination context. ' +
      'Call this for any proposition involving electronics, software, chemicals, or export to China/Russia/Middle East.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:      { type: 'string', enum: ['search', 'eccn', 'screening'],
                        description: 'search = Federal Register notices; eccn = export classification guidance; screening = embargoed destinations and party check context' },
        keyword:      { type: 'string', description: 'Keyword for search command (e.g. "semiconductors", "Entity List", "Russia")' },
        product_type: { type: 'string', description: 'Product type for eccn command: electronics, food, industrial_machinery, software, chemicals, medical_devices' },
        party_name:   { type: 'string', description: 'Country or party name for screening command (e.g. "China", "Iran", "Somalia")' },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_cbp_data',
    description: (
      'Fetch CBP (US Customs and Border Protection) import requirements and tariff rulings. No API key required. ' +
      '"requirements" = import compliance checklist for a product category (agencies, documents, certifications) — use for ALL import propositions. ' +
      '"rulings" = CBP binding tariff classification decisions — use to verify HTS code and precedent rulings. ' +
      '"hts_lookup" = find the right HTS code for a product by keyword. ' +
      'Call "requirements" for every physical import proposition to surface the full compliance checklist.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:  { type: 'string', enum: ['rulings', 'requirements', 'hts_lookup'],
                    description: 'rulings = binding CBP classification decisions; requirements = full import compliance checklist; hts_lookup = find HTS code by product keyword' },
        hts_code: { type: 'string', description: 'HTS code for rulings command (e.g. "0403.90")' },
        product:  { type: 'string', description: 'Product category for requirements command: food, furniture, electronics, apparel, medical_device, cosmetics' },
        origin:   { type: 'string', description: 'Country of origin for country-specific notes in requirements command' },
        keyword:  { type: 'string', description: 'Product keyword for hts_lookup command' },
        query:    { type: 'string', description: 'Additional keyword to filter rulings results' },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_ftc_data',
    description: (
      'Fetch FTC (Federal Trade Commission) labelling rules, marketing claim guidance, and enforcement actions. No API key required. ' +
      '"guidance" = pre-loaded rules for: health_claims, food_labelling, green_environmental, made_in_usa, textile_labelling, endorsements, pricing. ' +
      '"rules" = FTC regulations via Federal Register search. ' +
      '"cases" = FTC enforcement actions. ' +
      'Call "guidance health_claims" for any food/supplement proposition, "guidance textile_labelling" for apparel, ' +
      '"guidance endorsements" for influencer/marketing strategy, "guidance made_in_usa" for domestic manufacturing claims.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['rules', 'cases', 'guidance'],
                   description: 'rules = Federal Register FTC regulations; cases = enforcement actions; guidance = pre-loaded claim rules by topic' },
        query:   { type: 'string', description: 'Keyword for rules/cases search (e.g. "health claims", "textile labeling")' },
        topic:   { type: 'string', description: 'Topic for guidance command: health_claims, food_labelling, green_environmental, made_in_usa, textile_labelling, endorsements, pricing' },
        limit:   { type: 'integer', default: 15, description: 'Max results for cases command' },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_cpsc_data',
    description: (
      'Fetch CPSC (Consumer Product Safety Commission) product recalls and safety standards. No API key required. ' +
      '"recalls" = CPSC recall database — search by product keyword or category. Use for any consumer product proposition. ' +
      '"standards" = pre-loaded safety standard list for: furniture, electronics, food, toys, apparel, kitchen, medical. ' +
      '"incidents" = consumer injury/incident reports from SaferProducts.gov. ' +
      'Call "recalls" and "standards" for all physical consumer product propositions. ' +
      'A clean recall record is a positive signal; a pattern of recalls is a material regulatory risk.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:      { type: 'string', enum: ['recalls', 'incidents', 'standards'],
                        description: 'recalls = CPSC recall database; incidents = consumer injury reports; standards = safety standard list by product type' },
        query:        { type: 'string', description: 'Product keyword for recalls/incidents search (e.g. "furniture", "kitchen tools", "modular")' },
        category:     { type: 'string', description: 'Product category shorthand for recalls: furniture, electronics, food, toys, apparel, kitchen, medical' },
        product_type: { type: 'string', description: 'Product type for standards command: furniture, electronics, food, toys, apparel, kitchen, medical' },
        limit:        { type: 'integer', default: 15, description: 'Max results (default 15)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_sba_data',
    description: (
      'Fetch SBA (Small Business Administration) size standards, loan programs, and small business statistics. No API key required. ' +
      '"standards" = SBA small business size threshold for a NAICS code — use for eligibility context. ' +
      '"loans" = SBA loan program overview (7a, 504, Microloan) — use in financials section for funding options. ' +
      '"stats" = national small business formation and survival statistics. ' +
      'Call "loans" for every proposition to give the client financing pathway context. ' +
      'Call "standards" when industry classification affects funding or contract eligibility.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:    { type: 'string', enum: ['standards', 'loans', 'stats'],
                      description: 'standards = size standard by NAICS; loans = SBA loan program overview; stats = US small business formation/survival statistics' },
        naics_code: { type: 'string', description: 'NAICS code for standards command (e.g. "311511" dairy, "337" furniture, "315" apparel)' },
        industry:   { type: 'string', description: 'NAICS code for industry-specific loan recommendation (loans command)' },
        state:      { type: 'string', description: '2-letter US state code for stats command (optional — omit for national)' },
      },
      required: ['command'],
    },
  },

  // ---------------------------------------------------------------------------
  // Search quality enhancement tools
  {
    name: 'search_tavily',
    description: (
      'Full-content AI search purpose-built for research agents. ' +
      'Unlike Brave (which returns 150-word snippets), Tavily returns complete article text with ads and noise filtered out. ' +
      'Use when Brave results are thin or when a topic needs thorough coverage with full article text. ' +
      'The research command returns an AI-synthesized answer across all results — use for complex questions that need cross-referenced evidence. ' +
      'Use after Brave when snippets are insufficient, not instead of Brave.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['search', 'research'], default: 'search',
          description: 'search=full-content results; research=advanced depth + synthesized answer' },
        query:  { type: 'string', description: 'Search query or research question' },
        count:  { type: 'integer', description: 'Number of results (max 10, default 5)' },
        answer: { type: 'boolean', description: 'Include AI-synthesized answer across results (search command)' },
        depth:  { type: 'string', enum: ['basic', 'advanced'], description: 'basic=standard; advanced=more thorough, costs 2x credits' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Restrict results to specific domains' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_exa',
    description: (
      'Semantic neural search that finds conceptually related content even when exact keywords are absent. ' +
      'Brave is keyword-based — Exa understands meaning and surfaces relevant pages that keyword search misses. ' +
      'Use alongside Brave for competitor discovery, market trends, and research angles keywords would not find. ' +
      'The similar command finds pages semantically similar to a known good source — excellent for discovering competitors when you have one example. ' +
      'neural type for conceptual discovery; keyword for exact terms; auto lets Exa decide.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['search', 'similar'], default: 'search',
          description: 'search=query-based; similar=find pages like a given URL' },
        query:  { type: 'string', description: 'Search query (search command)' },
        url:    { type: 'string', description: 'Reference URL to find similar pages for (similar command)' },
        count:  { type: 'integer', description: 'Number of results (max 10, default 5)' },
        type:   { type: 'string', enum: ['neural', 'keyword', 'auto'], description: 'neural=conceptual, keyword=exact, auto=Exa decides (default: auto)' },
        since:  { type: 'string', description: 'Only results published after this date (YYYY-MM-DD)' },
      },
      required: [],
    },
  },
  {
    name: 'fetch_jina_reader',
    description: (
      'Fetches the full clean text of any web page — free, no key required. ' +
      'Use when a Brave or Exa search returns a promising URL and you need to read the complete article rather than relying on the snippet. ' +
      'Returns the full page as clean markdown, stripped of ads and navigation. ' +
      'Use read for a single URL; batch for up to 5 URLs at once. ' +
      'Best applied to the 2-3 highest-value results from a search — not every result.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['read', 'batch'], default: 'read',
          description: 'read=single URL; batch=multiple URLs (max 5)' },
        url:  { type: 'string', description: 'Single URL to fetch full content for (read command)' },
        urls: { type: 'array', items: { type: 'string' }, description: 'List of URLs to fetch (batch command, max 5)' },
      },
      required: [],
    },
  },

  // Global IP and product safety tools
  // ---------------------------------------------------------------------------
  {
    name: 'fetch_patents_data',
    description: (
      'Fetch USPTO patents (PatentsView) and trademark registrations. No API key required. ' +
      '"patents" = search US patent filings by keyword — use to assess IP landscape and technology crowding. ' +
      '"trademarks" = search US trademark registrations — use to check brand name conflicts before launch. ' +
      '"landscape" = combined IP overview: total patents, top assignees (companies), and trademark sample. ' +
      'Call "trademarks" for brand name validation. Call "landscape" for any proposition in a technology-intensive industry. ' +
      'High patent count = crowded IP space. Few patents = open innovation opportunity.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['patents', 'trademarks', 'landscape'],
                   description: 'patents = US patent search; trademarks = US trademark search; landscape = combined IP overview with top patent holders' },
        query:   { type: 'string', description: 'Technology, product, or brand name to search (e.g. "camel milk processing", "modular kitchen", "solar panel mounting")' },
        limit:   { type: 'integer', default: 10, description: 'Max results for patents/trademarks commands (default 10)' },
      },
      required: ['command', 'query'],
    },
  },
  {
    name: 'fetch_rapex_data',
    description: (
      'Fetch EU Safety Gate (formerly RAPEX) product safety alerts. No API key required. ' +
      '"summary" = pre-loaded EU safety risk profile for a product category: furniture, electronics, clothing_apparel, food, toys, cosmetics. ' +
      '"alerts" = search live EU Safety Gate notifications. ' +
      'Use for any proposition targeting EU or European markets. ' +
      'Call "summary" to quickly understand EU safety alert patterns and key hazards for a product category. ' +
      'A high EU alert volume means stronger market surveillance and higher compliance scrutiny at EU customs.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        command:          { type: 'string', enum: ['alerts', 'summary'],
                            description: 'alerts = search live EU Safety Gate notifications; summary = pre-loaded risk profile by product category' },
        product_category: { type: 'string', description: 'Category for summary command: furniture, electronics, clothing_apparel, food, toys, cosmetics' },
        query:            { type: 'string', description: 'Product keyword for alerts search (e.g. "furniture", "kitchen tools")' },
        category:         { type: 'string', description: 'Category filter for alerts search' },
        year:             { type: 'integer', description: 'Alert year filter (e.g. 2023)' },
        limit:            { type: 'integer', default: 15, description: 'Max alerts to return (default 15)' },
      },
      required: ['command'],
    },
  },
];

// ---------------------------------------------------------------------------
// Fact-check agent tools — web verification only, no data-collection tools.
// The fact-checker reads what research agents found and verifies it via search.
// ---------------------------------------------------------------------------
const FACT_CHECK_TOOLS = RESEARCH_TOOLS.filter(t =>
  ['web_search', 'search_tavily', 'search_exa', 'fetch_jina_reader'].includes(t.name)
);

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

    case 'fetch_bls_data': {
      if (input.command === 'wages') {
        const blsArgs = ['wages'];
        if (input.start) blsArgs.push('--start', String(input.start));
        if (input.end)   blsArgs.push('--end',   String(input.end));
        return execPython('tools/fetch_bls_data.py', blsArgs);
      } else if (input.command === 'employment') {
        const empArgs = ['employment', '--sector', input.sector || 'all'];
        if (input.start) empArgs.push('--start', String(input.start));
        if (input.end)   empArgs.push('--end',   String(input.end));
        return execPython('tools/fetch_bls_data.py', empArgs);
      } else {
        // series subcommand — requires explicit series IDs from the agent
        if (!input.ids) return { error: 'ids is required for the series command (comma-separated BLS series IDs)' };
        const serArgs = ['series', '--ids', input.ids];
        if (input.start) serArgs.push('--start', String(input.start));
        if (input.end)   serArgs.push('--end',   String(input.end));
        return execPython('tools/fetch_bls_data.py', serArgs);
      }
    }

    case 'fetch_epa_data': {
      if (input.command === 'facilities') {
        if (!input.naics) return { error: 'naics is required for the facilities command' };
        const facArgs = ['facilities', '--naics', input.naics,
                         '--limit', String(input.limit || 20)];
        if (input.state) facArgs.push('--state', input.state);
        return execPython('tools/fetch_epa_data.py', facArgs);
      } else {
        // tri subcommand
        const triArgs = ['tri', '--limit', String(input.limit || 20)];
        if (input.naics)    triArgs.push('--naics',    input.naics);
        if (input.state)    triArgs.push('--state',    input.state);
        if (input.chemical) triArgs.push('--chemical', input.chemical);
        if (input.year)     triArgs.push('--year',     String(input.year));
        return execPython('tools/fetch_epa_data.py', triArgs);
      }
    }

    case 'fetch_itc_data': {
      if (input.command === 'cases') {
        if (!input.term) return { error: 'term is required for the cases command' };
        return execPython('tools/fetch_itc_data.py', [
          'cases',
          '--term',  input.term,
          '--limit', String(input.limit || 15),
        ]);
      } else {
        // imports subcommand
        if (!input.naics) return { error: 'naics is required for the imports command' };
        const impArgs = ['imports', '--naics', input.naics,
                         '--year', String(input.year || 2022)];
        if (input.country_code) impArgs.push('--country', input.country_code);
        return execPython('tools/fetch_itc_data.py', impArgs);
      }
    }

    // ---------------------------------------------------------------------------
    // International economic data tools (no API key required)
    // ---------------------------------------------------------------------------

    case 'fetch_world_bank': {
      if (input.command === 'indicators') {
        const wbArgs = ['indicators', input.country];
        if (input.year) wbArgs.push('--year', String(input.year));
        return execPython('tools/fetch_world_bank.py', wbArgs);
      } else {
        // compare command
        if (!input.country2) return { error: 'country2 is required for the compare command' };
        const cmpArgs = ['compare', input.country, input.country2];
        if (input.indicator) cmpArgs.push('--indicator', input.indicator);
        return execPython('tools/fetch_world_bank.py', cmpArgs);
      }
    }

    case 'fetch_imf_data': {
      if (input.command === 'outlook') {
        return execPython('tools/fetch_imf_data.py', ['outlook', input.country]);
      } else {
        return execPython('tools/fetch_imf_data.py', ['indicators', input.country]);
      }
    }

    case 'fetch_oecd_data': {
      if (input.command === 'trade') {
        const oecdArgs = ['trade', input.country];
        if (input.partner) oecdArgs.push('--partner', input.partner);
        return execPython('tools/fetch_oecd_data.py', oecdArgs);
      } else {
        return execPython('tools/fetch_oecd_data.py', ['indicators', input.country]);
      }
    }

    case 'fetch_eurostat_data': {
      if (input.command === 'trade') {
        const euArgs = ['trade', input.product_code];
        if (input.reporter) euArgs.push('--reporter', input.reporter);
        if (input.year) euArgs.push('--year', String(input.year));
        return execPython('tools/fetch_eurostat_data.py', euArgs);
      } else if (input.command === 'industry') {
        const euIndArgs = ['industry', input.nace_code];
        if (input.country) euIndArgs.push('--country', input.country);
        if (input.year) euIndArgs.push('--year', String(input.year));
        return execPython('tools/fetch_eurostat_data.py', euIndArgs);
      } else {
        // market command
        return execPython('tools/fetch_eurostat_data.py', ['market', input.country || 'EU']);
      }
    }

    case 'fetch_fao_data': {
      if (input.command === 'trade') {
        const faoArgs = ['trade', input.item];
        if (input.reporter) faoArgs.push('--reporter', input.reporter);
        if (input.partner)  faoArgs.push('--partner',  input.partner);
        if (input.year)     faoArgs.push('--year',     String(input.year));
        return execPython('tools/fetch_fao_data.py', faoArgs);
      } else if (input.command === 'prices') {
        const priceArgs = ['prices', input.item];
        if (input.country) priceArgs.push('--country', input.country);
        if (input.year)    priceArgs.push('--year',    String(input.year));
        return execPython('tools/fetch_fao_data.py', priceArgs);
      } else {
        // production command
        const prodArgs = ['production', input.item];
        if (input.country) prodArgs.push('--country', input.country);
        if (input.year)    prodArgs.push('--year',    String(input.year));
        return execPython('tools/fetch_fao_data.py', prodArgs);
      }
    }

    case 'fetch_wto_data': {
      if (input.command === 'imports') {
        const impArgs = ['imports', input.hts_code];
        if (input.year) impArgs.push('--year', String(input.year));
        return execPython('tools/fetch_wto_data.py', impArgs);
      } else if (input.command === 'tariff') {
        if (!input.country) return { error: 'country is required for the tariff command' };
        return execPython('tools/fetch_wto_data.py', ['tariff', input.country, input.hts_code || '']);
      } else {
        // hts command
        if (!input.hts_code) return { error: 'hts_code is required for the hts command' };
        return execPython('tools/fetch_wto_data.py', ['hts', input.hts_code]);
      }
    }

    // ---------------------------------------------------------------------------
    // International trade flows
    // ---------------------------------------------------------------------------

    case 'fetch_un_comtrade': {
      if (!input.reporter || !input.hs_code) return { error: 'reporter and hs_code are required' };
      if (input.command === 'bilateral') {
        if (!input.partner) return { error: 'partner is required for the bilateral command' };
        const bilArgs = ['bilateral', input.reporter, input.partner, input.hs_code];
        if (input.year) bilArgs.push('--year', String(input.year));
        return execPython('tools/fetch_un_comtrade.py', bilArgs);
      } else {
        // top_partners
        const tpArgs = ['top_partners', input.reporter, input.hs_code];
        if (input.flow)  tpArgs.push('--flow',  input.flow);
        if (input.year)  tpArgs.push('--year',  String(input.year));
        if (input.count) tpArgs.push('--count', String(input.count));
        return execPython('tools/fetch_un_comtrade.py', tpArgs);
      }
    }

    // ---------------------------------------------------------------------------
    // Global news tool
    // ---------------------------------------------------------------------------

    case 'fetch_gdelt_news': {
      if (input.command === 'timeline') {
        const tlArgs = ['timeline', input.query];
        if (input.country) tlArgs.push('--country', input.country);
        return execPython('tools/fetch_gdelt_news.py', tlArgs);
      } else {
        // search command
        const gdArgs = ['search', input.query];
        if (input.country) gdArgs.push('--country', input.country);
        if (input.limit)   gdArgs.push('--limit',   String(input.limit));
        return execPython('tools/fetch_gdelt_news.py', gdArgs);
      }
    }

    // ---------------------------------------------------------------------------
    // US government industry-specific tools
    // ---------------------------------------------------------------------------

    case 'fetch_doe_data': {
      if (input.command === 'natural_gas') {
        const ngArgs = ['natural_gas'];
        if (input.state) ngArgs.push('--state', input.state);
        return execPython('tools/fetch_doe_data.py', ngArgs);
      } else if (input.command === 'renewables') {
        const renArgs = ['renewables'];
        if (input.state) renArgs.push('--state', input.state);
        return execPython('tools/fetch_doe_data.py', renArgs);
      } else if (input.command === 'fuel_costs') {
        const fuelArgs = ['fuel_costs'];
        if (input.sector) fuelArgs.push('--sector', input.sector);
        return execPython('tools/fetch_doe_data.py', fuelArgs);
      } else {
        // electricity command
        const elecArgs = ['electricity'];
        if (input.state) elecArgs.push('--state', input.state);
        return execPython('tools/fetch_doe_data.py', elecArgs);
      }
    }

    case 'fetch_fda_device_data': {
      if (input.command === 'pma') {
        return execPython('tools/fetch_fda_device_data.py', [
          'pma', input.query, '--limit', String(input.limit || 10)
        ]);
      } else if (input.command === 'recalls') {
        return execPython('tools/fetch_fda_device_data.py', [
          'recalls', input.query, '--limit', String(input.limit || 15)
        ]);
      } else if (input.command === 'events') {
        return execPython('tools/fetch_fda_device_data.py', [
          'events', input.query, '--limit', String(input.limit || 10)
        ]);
      } else {
        // clearances command
        if (!input.query) return { error: 'query is required for the clearances command' };
        return execPython('tools/fetch_fda_device_data.py', [
          'clearances', input.query, '--limit', String(input.limit || 15)
        ]);
      }
    }

    case 'fetch_bis_data': {
      if (input.command === 'eccn') {
        if (!input.product_type) return { error: 'product_type is required for the eccn command' };
        return execPython('tools/fetch_bis_data.py', ['eccn', input.product_type]);
      } else if (input.command === 'screening') {
        if (!input.party_name) return { error: 'party_name is required for the screening command' };
        return execPython('tools/fetch_bis_data.py', ['screening', input.party_name]);
      } else {
        // search command
        if (!input.keyword) return { error: 'keyword is required for the search command' };
        return execPython('tools/fetch_bis_data.py', ['search', input.keyword]);
      }
    }

    case 'fetch_cbp_data': {
      if (input.command === 'requirements') {
        if (!input.product) return { error: 'product is required for the requirements command' };
        const reqArgs = ['requirements', input.product];
        if (input.origin) reqArgs.push('--origin', input.origin);
        return execPython('tools/fetch_cbp_data.py', reqArgs);
      } else if (input.command === 'hts_lookup') {
        if (!input.keyword) return { error: 'keyword is required for the hts_lookup command' };
        return execPython('tools/fetch_cbp_data.py', ['hts_lookup', input.keyword]);
      } else {
        // rulings command
        if (!input.hts_code) return { error: 'hts_code is required for the rulings command' };
        const rulArgs = ['rulings', input.hts_code];
        if (input.query) rulArgs.push('--query', input.query);
        return execPython('tools/fetch_cbp_data.py', rulArgs);
      }
    }

    case 'fetch_ftc_data': {
      if (input.command === 'rules') {
        const ftcArgs = ['rules'];
        if (input.query) ftcArgs.push('--query', input.query);
        return execPython('tools/fetch_ftc_data.py', ftcArgs);
      } else if (input.command === 'cases') {
        const caseArgs = ['cases'];
        if (input.query) caseArgs.push('--query', input.query);
        if (input.limit) caseArgs.push('--limit', String(input.limit));
        return execPython('tools/fetch_ftc_data.py', caseArgs);
      } else {
        // guidance command
        if (!input.topic) return { error: 'topic is required for the guidance command' };
        return execPython('tools/fetch_ftc_data.py', ['guidance', input.topic]);
      }
    }

    case 'fetch_cpsc_data': {
      if (input.command === 'incidents') {
        const incArgs = ['incidents'];
        if (input.query) incArgs.push('--query', input.query);
        if (input.limit) incArgs.push('--limit', String(input.limit));
        return execPython('tools/fetch_cpsc_data.py', incArgs);
      } else if (input.command === 'standards') {
        if (!input.product_type) return { error: 'product_type is required for the standards command' };
        return execPython('tools/fetch_cpsc_data.py', ['standards', input.product_type]);
      } else {
        // recalls command
        const recArgs = ['recalls'];
        if (input.query)    recArgs.push('--query',    input.query);
        if (input.category) recArgs.push('--category', input.category);
        if (input.limit)    recArgs.push('--limit',    String(input.limit));
        return execPython('tools/fetch_cpsc_data.py', recArgs);
      }
    }

    case 'fetch_sba_data': {
      if (input.command === 'loans') {
        const loanArgs = ['loans'];
        if (input.industry) loanArgs.push('--industry', input.industry);
        return execPython('tools/fetch_sba_data.py', loanArgs);
      } else if (input.command === 'stats') {
        const statsArgs = ['stats'];
        if (input.state) statsArgs.push('--state', input.state);
        return execPython('tools/fetch_sba_data.py', statsArgs);
      } else {
        // standards command
        if (!input.naics_code) return { error: 'naics_code is required for the standards command' };
        return execPython('tools/fetch_sba_data.py', ['standards', input.naics_code]);
      }
    }

    // ---------------------------------------------------------------------------
    // Global IP / product safety tools
    // ---------------------------------------------------------------------------

    case 'fetch_patents_data': {
      if (input.command === 'trademarks') {
        return execPython('tools/fetch_patents_data.py', [
          'trademarks', input.query, '--limit', String(input.limit || 10)
        ]);
      } else if (input.command === 'landscape') {
        return execPython('tools/fetch_patents_data.py', ['landscape', input.query]);
      } else {
        // patents command
        if (!input.query) return { error: 'query is required for the patents command' };
        return execPython('tools/fetch_patents_data.py', [
          'patents', input.query, '--limit', String(input.limit || 10)
        ]);
      }
    }

    case 'fetch_rapex_data': {
      if (input.command === 'summary') {
        if (!input.product_category) return { error: 'product_category is required for the summary command' };
        return execPython('tools/fetch_rapex_data.py', ['summary', input.product_category]);
      } else {
        // alerts command
        const rapexArgs = ['alerts'];
        if (input.query)    rapexArgs.push('--query',    input.query);
        if (input.category) rapexArgs.push('--category', input.category);
        if (input.year)     rapexArgs.push('--year',     String(input.year));
        if (input.limit)    rapexArgs.push('--limit',    String(input.limit));
        return execPython('tools/fetch_rapex_data.py', rapexArgs);
      }
    }

    // Search quality enhancement tools
    case 'search_tavily': {
      if (!input.query) return { error: 'query is required' };
      const tavArgs = [input.command || 'search', input.query];
      if (input.count)  tavArgs.push('--count', String(input.count));
      if (input.depth)  tavArgs.push('--depth', input.depth);
      if (input.answer) tavArgs.push('--answer');
      if (input.domains && input.domains.length) tavArgs.push('--domains', ...input.domains);
      return execPython('tools/search_tavily.py', tavArgs);
    }

    case 'search_exa': {
      if (input.command === 'similar') {
        if (!input.url) return { error: 'url is required for the similar command' };
        const exaSimilarArgs = ['similar', input.url];
        if (input.count) exaSimilarArgs.push('--count', String(input.count));
        return execPython('tools/search_exa.py', exaSimilarArgs);
      } else {
        if (!input.query) return { error: 'query is required for the search command' };
        const exaArgs = ['search', input.query];
        if (input.count) exaArgs.push('--count', String(input.count));
        if (input.type)  exaArgs.push('--type',  input.type);
        if (input.since) exaArgs.push('--since', input.since);
        return execPython('tools/search_exa.py', exaArgs);
      }
    }

    case 'fetch_jina_reader': {
      if (input.command === 'batch') {
        const urls = (input.urls || []).slice(0, 5);
        if (!urls.length) return { error: 'urls array is required for the batch command' };
        return execPython('tools/fetch_jina_reader.py', ['batch', ...urls]);
      } else {
        if (!input.url) return { error: 'url is required for the read command' };
        return execPython('tools/fetch_jina_reader.py', ['read', input.url]);
      }
    }

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
  const result = { propositionId: undefined, force: false, regenPdf: false, reportId: undefined, upload: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proposition-id' && args[i + 1]) {
      result.propositionId = args[++i];
    } else if (args[i] === '--force') {
      result.force = true;
    } else if (args[i] === '--regen-pdf') {
      result.regenPdf = true;
    } else if (args[i] === '--report-id' && args[i + 1]) {
      result.reportId = args[++i];
    } else if (args[i] === '--upload') {
      result.upload = true;
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
  // Count runs that reached admin review or were sent — failed/crashed don't count
  const runNumber = history.filter(r => r.status === 'complete' || r.status === 'pending_review').length + 1;

  // The most recent finished report is the baseline for "What Changed"
  const previousCompleted = history.find(r => r.status === 'complete' || r.status === 'pending_review');
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

  // Build the proposition context object the workflow expects.
  // client_context is a JSONB blob from the expanded intake form (migration 012) —
  // it holds product scope, development stage, price point, revenue model,
  // customer type, ideal customer description, sales channel, comparable brands,
  // and key differentiator. Omit it if null so agents don't see an empty field.
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
    ...(context.proposition.client_context
      ? { client_context: context.proposition.client_context }
      : {}),
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

  // Build admin context notes block — injected only when notes exist that apply
  // to this agent's categories. The mapping reflects which research dimensions
  // each category of note is relevant to:
  //   sourcing    → production, origin_ops (supply chain + logistics)
  //   market      → market_overview, competitors (sizing + competitive landscape)
  //   regulatory  → regulatory, legal (compliance + legal risk)
  //   financial   → financials (unit economics, cost structure)
  //   competitor  → competitors (competitive analysis)
  //   other       → all agents (general scope adjustments)
  const CATEGORY_TO_AGENTS = {
    sourcing:   ['production', 'origin_ops'],
    market:     ['market_overview', 'competitors'],
    regulatory: ['regulatory', 'legal'],
    financial:  ['financials'],
    competitor: ['competitors'],
    other:      null, // null = inject into every agent
  };

  const relevantNotes = [];
  if (context.adminContextNotes && Object.keys(context.adminContextNotes).length > 0) {
    for (const [category, agentList] of Object.entries(CATEGORY_TO_AGENTS)) {
      const notes = context.adminContextNotes[category];
      if (!notes || notes.length === 0) continue;
      // Include if this category applies to all agents (other) or to this specific agent
      if (agentList === null || agentList.includes(agentName)) {
        for (const note of notes) {
          relevantNotes.push(`[${category}] ${note}`);
        }
      }
    }
  }

  const contextNotesBlock = relevantNotes.length > 0
    ? `\n## ADMIN CONTEXT NOTES\nThe following scope adjustments have been provided for this ` +
      `proposition. Treat these as authoritative — they describe how this business will actually ` +
      `operate and must be factored directly into your research and analysis:\n` +
      relevantNotes.map(n => `- ${n}`).join('\n') + '\n'
    : '';

  // Build the client context block — injected when the intake form captured enrichment
  // data (product scope, development stage, price point, revenue model, customer type,
  // ideal customer, sales channel, comparable brands, key differentiator).
  // These are direct signals from the client about how they see their business.
  // Agents should use them to sharpen focus: right price tier for TAM sizing,
  // right sales channel for distribution research, right competitors for benchmarking.
  const cc = context.proposition.client_context;
  const clientContextBlock = cc && Object.keys(cc).length > 0
    ? `\n## CLIENT CONTEXT\nThe following enrichment data was provided by the client during intake. ` +
      `Use it to sharpen your research — target the right price tier, sales channel, ` +
      `customer segment, and competitive set:\n` +
      Object.entries(cc)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => {
          const label = k.replace(/_/g, ' ');
          const val   = Array.isArray(v) ? v.join(', ') : String(v);
          return `- ${label}: ${val}`;
        })
        .join('\n') + '\n'
    : '';

  const userPrompt = `Execute this research workflow and produce the JSON output.

## WORKFLOW INSTRUCTIONS
${workflow}

## PROPOSITION CONTEXT
\`\`\`json
${JSON.stringify(propositionContext, null, 2)}
\`\`\`
${ventureBlock}${landscapeBlock}${clientContextBlock}${contextNotesBlock}
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
        maxTokens:  32000, // Raised from 16000 — financials JSON can be large on complex propositions
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
     with label "Regulatory Blocker". Cover all applicable import requirements, labeling rules,
     country-of-origin restrictions, and any trade sanctions or embargo flags relevant to the
     proposition's origin and target countries.`,

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
     Cover any claim or advertising compliance requirements relevant to this product category
     (e.g. health claims for food/supplements, safety claims for regulated products).`,

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
async function streamSonnetCall(systemPrompt, messages, maxTokens, useCache = false) {
  let attempts = 0;
  // Cache the system prompt when enabled — saves the repeated fixed context across all 15 assembler calls
  const systemBlock = useCache
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  while (true) {
    attempts++;
    try {
      const stream = anthropic.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system:     systemBlock,
        messages,
      });
      const msg = await stream.finalMessage();

      // Log cache usage so we can verify caching is working and measure savings
      if (useCache) {
        const u = msg.usage;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const cacheRead  = u.cache_read_input_tokens     ?? 0;
        const regular    = u.input_tokens                ?? 0;
        if (cacheWrite > 0 || cacheRead > 0) {
          console.log(`      💾 Cache: write=${cacheWrite.toLocaleString()} read=${cacheRead.toLocaleString()} uncached=${regular.toLocaleString()} out=${u.output_tokens.toLocaleString()}`);
        }
      }

      return msg.content.map(b => b.type === 'text' ? b.text : '').join('');
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
async function callWithRepair(systemPrompt, userPrompt, maxTokens, maxRepairs = 2, hardFail = false, cacheablePrefix = null) {
  // When cacheablePrefix is provided (the shared research context), split the first user message
  // into two content blocks: a cacheable prefix and the section-specific task.
  // This lets Anthropic cache the ~150k-token research context across all 15 assembler calls.
  const useCache = !!cacheablePrefix;
  const firstMessage = cacheablePrefix
    ? {
        role: 'user',
        content: [
          { type: 'text', text: cacheablePrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: userPrompt },
        ],
      }
    : { role: 'user', content: userPrompt };

  const messages = [firstMessage];
  let rawContent;

  // Initial generation attempt
  try {
    rawContent = await streamSonnetCall(systemPrompt, messages, maxTokens, useCache);
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
        rawContent = await streamSonnetCall(systemPrompt, messages, maxTokens, useCache);
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
// Fact-check agent
// ---------------------------------------------------------------------------

/**
 * Runs a targeted verification pass over all research agent outputs.
 *
 * Uses web search (Brave, Tavily, Exa, Jina) to check that specific claims —
 * especially those derived from category-level data tools — are genuinely
 * applicable to the proposition's specific product, not just to the broader
 * commodity class or industry sector.
 *
 * Non-fatal: if this agent fails for any reason, the pipeline continues.
 * The assembler receives a failure notice and applies extra caution in its
 * own synthesis pass.
 *
 * @param {Object} context      - Run context (proposition, product type, etc.)
 * @param {Object} agentOutputs - Map of agent_name → parsed research output.
 * @returns {Object} Structured fact-check result, or a failure stub.
 */
async function runFactCheckAgent(context, agentOutputs) {
  console.log('\n  Running fact-check agent...');

  const { proposition } = context;
  const factCheckWorkflow = loadWorkflow('fact_check_research.md');

  // Extract claim-dense fields from each agent output rather than blindly
  // truncating. Naive truncation would cut off most of a large agent like
  // financials and create false confidence — the fact-checker would see
  // only the first few fields and mark the rest as "not checked".
  //
  // Instead, pull the fields most likely to contain verifiable claims:
  // specific numbers, regulatory statements, named competitors, trade volumes.
  // This gives the fact-checker full fidelity on the claims that matter
  // while keeping total context manageable.
  const CLAIM_DENSE_KEYS = new Set([
    // Market sizing and growth — most likely to use category-level data
    'market_size', 'market_size_usd', 'market_growth', 'market_growth_rate',
    'tam', 'sam', 'market_value', 'cagr', 'total_market',
    // Trade and volume figures — Comtrade / Census sourced
    'trade_volume', 'import_volume', 'export_volume', 'trade_value',
    'import_value', 'export_value', 'bilateral_trade',
    // Financials — numbers most likely to be unverified or category-level
    'unit_economics', 'cost_structure', 'margins', 'gross_margin',
    'price_point', 'pricing', 'landed_cost', 'production_cost',
    'revenue_projection', 'break_even', 'roi', 'payback_period',
    // Regulatory — high-stakes claims
    'regulatory_requirements', 'compliance_requirements', 'restrictions',
    'approval_status', 'permits_required', 'banned', 'prohibited',
    'legal_status', 'certification', 'labeling_requirements',
    // Named competitors — identity claims
    'competitors', 'key_players', 'market_leaders', 'competitor_list',
    'companies', 'brands', 'market_share',
    // Data sources — lets fact-checker know what tools backed each claim
    'data_sources', 'sources', 'citations',
    // Data gaps — honest gaps are not claims; include so fact-checker skips them
    'data_gaps', 'limitations',
  ]);

  const extractClaims = (output) => {
    if (!output || typeof output !== 'object') return output;
    const extracted = {};
    for (const [key, value] of Object.entries(output)) {
      if (CLAIM_DENSE_KEYS.has(key.toLowerCase())) {
        extracted[key] = value;
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // One level of nesting — capture claim-dense keys inside sub-objects
        const nested = extractClaims(value);
        if (nested && Object.keys(nested).length > 0) extracted[key] = nested;
      }
    }
    // If nothing matched, fall back to the full output capped at 6000 chars
    // so no agent is completely invisible to the fact-checker
    if (Object.keys(extracted).length === 0) {
      return { _full_fallback: JSON.stringify(output).slice(0, 6000) };
    }
    return extracted;
  };

  const agentSummaries = Object.entries(agentOutputs)
    .filter(([, output]) => output !== null)
    .map(([name, output]) => {
      const claims = extractClaims(output);
      return `### Agent: ${name}\n${JSON.stringify(claims, null, 2)}`;
    })
    .join('\n\n');

  const systemPrompt = `You are the fact-check agent for McKeever Consulting's Business Viability Intelligence System.

Your job is to verify that specific claims made by research agents are accurate and genuinely applicable to the proposition's specific product — not just to the broader commodity category, industry sector, or country.

The proposition being verified:
- Title: ${proposition.title}
- Product type: ${proposition.product_type}
- Industry: ${proposition.industry || 'not specified'}
- Origin country: ${proposition.origin_country || 'not specified'}
- Target country: ${proposition.target_country}

CRITICAL RULES:
1. Your final response must be ONLY the JSON object defined in the workflow — no markdown fences, no preamble
2. Use tools to verify claims — do not guess or rely on training knowledge for specific statistics
3. If you cannot verify a claim after 2-3 targeted searches, mark it as unverifiable and move on
4. Focus on quantitative claims, regulatory claims, and named competitors — not narrative analysis
5. Do not re-run data tool queries (Comtrade, Census, etc.) — verify via web search only`;

  const userPrompt = `## FACT-CHECK WORKFLOW\n${factCheckWorkflow}\n\n## RESEARCH AGENT OUTPUTS TO VERIFY\n\n${agentSummaries}`;

  try {
    const raw = await callClaude({
      model:      SONNET,
      system:     systemPrompt,
      userPrompt,
      tools:      FACT_CHECK_TOOLS,
      maxTokens:  8000,
      maxIter:    30,
    });

    const result = parseJSON(raw);
    const issueCount = result.issues_found ?? result.corrections?.length ?? 0;
    const checkCount = result.checks_performed ?? 0;
    console.log(`  ✓ Fact check complete — ${checkCount} claims checked, ${issueCount} issue(s) found`);
    return result;

  } catch (err) {
    console.warn(`  ⚠ Fact check agent failed: ${err.message.slice(0, 120)}`);
    // Return a stub so the assembler knows to apply extra caution
    return {
      checks_performed: 0,
      issues_found: 0,
      corrections: [],
      verified_claims: [],
      unverifiable_claims: [],
      summary: `Fact check agent failed to complete: ${err.message.slice(0, 200)}. Assembler should treat all quantitative claims from data tools as category-level estimates and apply appropriate qualification.`,
      agent_error: true,
    };
  }
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
 * @param {Object} context          - Run context.
 * @param {Object} agentOutputs     - Map of agent_name → parsed research output.
 * @param {Object} [factCheckResults] - Structured output from runFactCheckAgent (optional).
 */
async function runAssemblerAgent(context, agentOutputs, factCheckResults = null) {
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

  // 6. System prompt — shared across all section calls.
  // Fact-check results are injected here so the assembler applies corrections
  // and qualifications before writing each section.
  const factCheckBlock = factCheckResults
    ? `\n\n## FACT-CHECK RESULTS\nA verification agent reviewed the research outputs before assembly. Apply the corrections and qualifications below when writing sections.\n\n${JSON.stringify(factCheckResults, null, 2)}\n\nRULES FOR USING FACT-CHECK RESULTS:\n- For any claim listed in "corrections": use the corrected_claim, not the original\n- For any claim listed in "unverifiable_claims": include the claim but qualify it (e.g. "industry estimates suggest..." rather than stating it as fact)\n- For corrections with severity "high": these must be applied — do not use the original claim\n- Category-level data: always note the broader scope (e.g. "for this commodity class" not "for this product")`
    : '\n\n## FACT-CHECK\nNo fact-check results available. Treat all quantitative claims from data tools (Comtrade, Census, BLS, etc.) as category-level estimates. Qualify any statistic that may cover a broader product class than the specific proposition product.';

  const systemPrompt = `You are the report assembler for McKeever Consulting's Business Viability Intelligence System.
Your role is to write ONE specific section of a professional business viability report.

CRITICAL RULES:
1. Your response must be ONLY the JSON object specified — no markdown code fences, no text before or after
2. Write all prose in plain, professional English — paragraphs, not bullet-point walls
3. Every claim must be traceable to the research data provided — do not invent figures
4. Every block must have non-empty content — no empty strings, no placeholder text${factCheckBlock}`;

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
  // 17s between section calls — balances two constraints:
  //   1. TPM rate limit: keeps us within the 50k TPM window
  //   2. Prompt cache TTL: 15 sections × 17s = 255s, safely under the 300s (5-min) cache TTL.
  //      At 20s, a single repair cycle or rate-limit backoff could push a section past TTL.
  const INTER_SECTION_DELAY_MS = 17_000;

  // ── Call 1: Meta + Viability Score ────────────────────────────────────────
  // Hard fail — viability verdict is the core deliverable. No placeholder possible.
  console.log('    [1/15] Computing viability score...');
  const metaViabilityTask = `## YOUR TASK
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

  const metaViability = await callWithRepair(systemPrompt, metaViabilityTask, 3000, 2, true, researchContext);
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

    const sectionTask = `${viabilityContext}

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

    const result = await callWithRepair(systemPrompt, sectionTask, spec.maxTokens, 2, false, researchContext);

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
    const whatChangedTask = `${viabilityContext}

## YOUR TASK
Compare the previous report outputs with the current report outputs and produce a list of
meaningful delta bullets for the "What Changed This Month" section.

Focus on: new findings, changed figures, resolved or new risks, regulatory updates, market shifts.
Ignore minor wording differences — only include substantive changes.

## OUTPUT SCHEMA
Return ONLY a JSON array of strings (not an object):
["<change bullet 1>", "<change bullet 2>", ...]`;

    whatChanged = await callWithRepair(systemPrompt, whatChangedTask, 3000, 2, false, researchContext);
    if (whatChanged) {
      console.log('    ✓ What Changed complete');
    } else {
      whatChanged = ['What Changed data could not be generated for this run.'];
      console.warn('    ⚠ What Changed failed — placeholder inserted');
    }
    await sleep(INTER_SECTION_DELAY_MS);
  }

  // ── Call 15: Sources ──────────────────────────────────────────────────────
  // Extract sources deterministically from agentOutputs — no LLM needed.
  // Relying on an LLM to copy URLs from a large JSON blob is unreliable and
  // expensive. Each agent already structures its sources array consistently.
  console.log('    [15/15] Compiling sources...');
  const now15         = new Date().toISOString();
  const seenUrls      = new Set();
  const sources       = [];

  for (const [agentName, output] of Object.entries(agentOutputs)) {
    if (!output || !Array.isArray(output.sources)) continue;
    for (const src of output.sources) {
      if (!src?.url || seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      sources.push({
        url:          src.url,
        title:        src.title        || null,
        agent_name:   `research_${agentName}`,
        retrieved_at: src.retrieved_at || now15,
      });
    }
  }

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

        const repairTask = `${viabilityContext}

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

        const repaired = await callWithRepair(systemPrompt, repairTask, spec.maxTokens, 2, false, researchContext);

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

  // ── Notify admin — client delivery happens manually from the admin panel ─────
  // Recipients are NOT emailed here. Brendon reviews the report first, then clicks
  // "Send to Client" on the website to trigger delivery.
  const viabilityScoreObj = contentJson.viability_score || {};
  await sendAdminReportCopy(context.recipients, proposition, pdfPath, reportMonth, viabilityScoreObj, confidence);
  console.log(`    ✓ Admin review copy sent`);

  // ── Mark pending_review — admin approves before client delivery ──────────
  await updateReportStatus(reportId, 'pending_review');
  console.log('  ✓ Report status → pending_review');

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
        <p style="color:#8A9BB0;font-size:13px;margin:4px 0 0;">Admin Copy — Pending Your Review</p>
      </div>

      <div style="padding:32px;background:#F7F8FA;border:1px solid #e0e0e0;">
        <h2 style="color:#1C3557;margin-top:0;">Report ready for your review — not yet sent to client</h2>

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

    // 2. Check for a prior failed run with content already in Storage — if found,
    //    skip all research agents and go straight to PDF + email. This recovers
    //    from post-assembly failures (PDF crash, upload error) without re-spending
    //    ~$8 in API costs and 40 minutes of research agent time.
    const resumeContext = { recipients, proposition, client };
    const resumeResult = await tryResumeFromContent(proposition, resumeContext);
    if (resumeResult) {
      // Advance the schedule so this proposition isn't picked up again immediately
      if (proposition.schedule_type && proposition.schedule_type !== 'on_demand') {
        await advancePropositionSchedule(proposition.id, proposition.schedule_type, proposition.schedule_day);
        console.log('✓ Proposition schedule advanced');
      }
      const elapsedMin = ((Date.now() - propStart) / 60_000).toFixed(1);
      console.log(`\n✓ Resumed from saved content — Report delivered | Elapsed: ${elapsedMin} min`);
      return { status: 'complete', title: proposition.title, reportId: resumeResult.reportId, elapsedMin };
    }

    // 3. No resumable content — create a fresh report record and run the full pipeline
    report = await createReportRecord(proposition);

    // 4. Mark as running
    await updateReportStatus(report.id, 'running');
    console.log('✓ Report status → running');

    // 5. Run Perplexity pre-briefings — both are non-fatal; null means agents
    //    fall back to their generic workflow SOPs. Run sequentially (single API).
    const ventureIntelligence   = runVentureIntelligence(proposition);
    const landscapeBriefing     = runCurrentLandscapeBriefing(proposition);

    // 4b. Fetch admin context notes from proposition_context table.
    // These are scope adjustments entered via the admin panel's Context Panel —
    // e.g. "Camels milked in Somalia but milk processed in Kenya/UAE before US export".
    // Non-fatal: if the query fails, agents proceed without enrichment.
    let adminContextNotes = {};
    try {
      adminContextNotes = await getPropositionContext(proposition.id);
      const totalNotes = Object.values(adminContextNotes).reduce((sum, arr) => sum + arr.length, 0);
      if (totalNotes > 0) {
        const categories = Object.keys(adminContextNotes).join(', ');
        console.log(`✓ Admin context notes loaded: ${totalNotes} note(s) [${categories}]`);
      }
    } catch (err) {
      console.warn(`  ⚠ Could not load admin context notes (non-fatal): ${err.message.slice(0, 120)}`);
    }

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
      adminContextNotes,     // Admin panel: scope adjustments grouped by category
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

    // 7.5. Fact-check agent — verifies that specific claims from data tools
    // are genuinely applicable to the proposition's product (not just the
    // broader commodity category). Non-fatal: pipeline continues regardless.
    const factCheckResults = await runFactCheckAgent(context, agentOutputs);

    // 8. Run assembler — synthesizes, builds PDF, uploads, emails, marks complete
    await runAssemblerAgent(context, agentOutputs, factCheckResults);

    // NOTE: updateReportStatus('complete') is called inside runAssemblerAgent()
    // after successful email delivery. Do not duplicate it here.

    // 9. Advance schedule so this proposition isn't picked up again immediately
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

      // Intentionally NOT deleting agent_outputs on failure.
      // If this run later becomes resumable (content JSON was saved before the failure),
      // tryResumeFromContent needs these rows to re-compute the data confidence score.
      // They will be deleted by tryResumeFromContent after confidence is re-computed.
    }

    await sendFailureAlert(proposition, report, err);
    return { status: 'failed', title: proposition.title, reportId: report?.id, elapsedMin, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Resume from failed run
// ---------------------------------------------------------------------------

/**
 * Checks if this proposition has a prior failed run with content JSON already
 * saved to Storage. If so, downloads the content and skips straight to PDF
 * generation + email — no research agents are re-run.
 *
 * This handles the case where the run failed AFTER the assembler uploaded the
 * content JSON (e.g. PDF generation crash, storage upload error, email failure).
 * Research agents are expensive (~$8 in API spend + 40 minutes) — never re-run
 * them when the content already exists.
 *
 * @param {Object} proposition - Proposition row from DB.
 * @param {Object} context     - Run context (client, recipients, etc.).
 * @returns {Promise<{resumed: true, reportId: string}|null>} Resume result, or null if nothing to resume.
 */
async function tryResumeFromContent(proposition, context) {
  const history = await getReportsByPropositionId(proposition.id);
  const failedReports = history.filter(r => r.status === 'failed');

  for (const failedReport of failedReports) {
    const contentPath = `${proposition.id}/${failedReport.id}_content.json`;

    // Try to download the content JSON — if it doesn't exist this will error
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('reports')
      .download(contentPath);

    if (downloadError || !fileData) {
      // No content JSON — run failed before assembly. Clean up any orphaned agent_outputs.
      try { await deleteAgentOutputsByReportId(failedReport.id); } catch (_) { /* non-fatal */ }
      continue;
    }

    // Parse content JSON — if corrupted, skip this report and try the next one
    let contentText, contentJson;
    try {
      contentText = await fileData.text();
      contentJson = JSON.parse(contentText);
    } catch (parseErr) {
      console.warn(`  ⚠ Resume: content JSON for report ${failedReport.id} is malformed — skipping (${parseErr.message})`);
      continue;
    }

    console.log(`\n  ↩ Resuming from failed run ${failedReport.id} — content JSON found in Storage`);
    console.log('    Skipping research agents. Proceeding directly to PDF generation.');

    // Create a fresh report record so the admin panel's createdAt-based polling can detect
    // this run completing. Reusing the old failedReport record would keep its original
    // createdAt, causing the RunPanel to filter it out as "predates this trigger."
    const report = await createReportRecord(proposition);
    await updateReportStatus(report.id, 'running');

    const slug         = proposition.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const reportDate   = new Date(report.created_at);
    const reportYYYYMM = reportDate.toISOString().slice(0, 7);
    const reportMonth  = reportDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Re-compute confidence using the original failed report's agent_outputs (still in DB
    // under failedReport.id). This recovers a valid score even if the original run's
    // confidence tool failed, since agent_outputs persist across runs.
    const recomputedConf = computeDataConfidence(failedReport.id);
    const confidence     = recomputedConf || contentJson?.meta?.data_confidence || null;

    // If we got a fresh score, patch the content JSON so the PDF reflects it rather
    // than the stale/null value that was embedded when the original run failed.
    if (recomputedConf && contentJson?.meta) {
      contentJson.meta.data_confidence = recomputedConf;
      contentText = JSON.stringify(contentJson);
    }

    // Wrap all delivery steps so we can mark the report failed if anything goes wrong
    let contentFile, pdfPath;
    try {
      // Write content JSON to .tmp/ for the PDF script
      const tmpDir  = path.join(__dirname, '.tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      contentFile   = path.join(tmpDir, `${report.id}_content.json`);
      fs.writeFileSync(contentFile, contentText);

      // Upload content JSON under the new report ID for Storage consistency
      const newContentPath = `${proposition.id}/${report.id}_content.json`;
      const { error: reuploadError } = await supabase.storage.from('reports').upload(newContentPath, contentText, {
        contentType: 'application/json',
        upsert:      true,
      });
      if (reuploadError) console.warn(`    ⚠ Content JSON upload failed (non-fatal): ${reuploadError.message}`);

      // Build PDF
      const outputsDir = path.join(__dirname, 'outputs');
      fs.mkdirSync(outputsDir, { recursive: true });
      const pdfFilename = `${slug}_${reportYYYYMM}.pdf`;
      pdfPath           = path.join(outputsDir, pdfFilename);
      const pdfScript   = path.join(__dirname, 'tools', 'generate_report_pdf.py');

      console.log('    Building PDF...');
      execSync(
        `${PYTHON} "${pdfScript}" --report-id "${report.id}" --content "${contentFile}" --output "${pdfPath}"`,
        { stdio: 'inherit', cwd: __dirname, timeout: 120_000 }
      );
      console.log(`    ✓ PDF generated: ${pdfFilename}`);

      // Upload PDF to Storage under the new report ID
      const storagePath = `${proposition.id}/${report.id}.pdf`;
      const pdfBuffer   = fs.readFileSync(pdfPath);
      const { error: uploadError } = await supabase.storage
        .from('reports')
        .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
      if (uploadError) throw new Error(`PDF Storage upload failed: ${uploadError.message}`);
      await updateReportPdfUrl(report.id, storagePath);
      console.log('    ✓ PDF uploaded to Storage');

      // Email recipients
      const viabilityScoreObj = contentJson.viability_score || {};
      for (const recipient of context.recipients) {
        await sendReportEmail(recipient, proposition, pdfPath, reportMonth, viabilityScoreObj, confidence);
        console.log(`    ✓ Report emailed to ${recipient.email}`);
      }
      await sendAdminReportCopy(context.recipients, proposition, pdfPath, reportMonth, viabilityScoreObj, confidence);
      console.log(`    ✓ Admin copy sent`);

    } catch (deliveryErr) {
      // Delivery failed — record the error and re-throw so runProposition handles alerting
      await updateReportError(report.id, deliveryErr.message).catch(() => {});
      throw deliveryErr;
    } finally {
      // Clean up local files regardless of success or failure
      try { if (contentFile) fs.unlinkSync(contentFile); } catch (_) { /* non-fatal */ }
      try { if (pdfPath)     fs.unlinkSync(pdfPath);     } catch (_) { /* non-fatal */ }
    }

    // Mark complete — old failedReport stays as 'failed' (historical record, untouched)
    await updateReportStatus(report.id, 'complete');
    console.log('  ✓ Report status → complete');

    // Clean up new report's agent_outputs (none were created, but defensive)
    try { await deleteAgentOutputsByReportId(report.id); } catch (_) { /* non-fatal */ }

    // Clean up the original failed report's agent_outputs now that confidence has been
    // re-computed and the resume is complete. These were preserved from the failure handler
    // specifically for this re-computation step.
    try { await deleteAgentOutputsByReportId(failedReport.id); } catch (_) { /* non-fatal */ }

    // Delete the old failed report's content JSON from Storage so the next trigger
    // doesn't resume from stale data and runs the full pipeline fresh instead.
    const oldContentPath = `${proposition.id}/${failedReport.id}_content.json`;
    try {
      await supabase.storage.from('reports').remove([oldContentPath]);
      console.log('  ✓ Old content JSON removed from Storage');
    } catch (_) { /* non-fatal — worst case the next run resumes again */ }

    return { resumed: true, reportId: report.id };
  }

  return null; // no resumable content found — run full pipeline
}

// ---------------------------------------------------------------------------
// PDF regeneration (--regen-pdf)
// ---------------------------------------------------------------------------

/**
 * Rebuilds the PDF for an existing report without re-running any agents.
 * Downloads the content JSON from Supabase Storage, runs generate_report_pdf.py,
 * and either saves locally (default) or uploads back to Supabase (--upload).
 *
 * --upload mode: overwrites the PDF in Storage, report stays pending_review
 * so the admin can review the new version and then click Send to Client.
 *
 * @param {string}  reportId - UUID of the report to regenerate.
 * @param {boolean} upload   - If true, overwrite PDF in Supabase Storage and update report.
 */
async function regenPdfFromStorage(reportId, upload = false) {
  console.log(`\nRegenerating PDF for report: ${reportId}${upload ? ' (will upload to Supabase)' : ''}`);

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

  // 4. Determine output path
  const slug        = proposition.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const reportMonth = new Date(report.created_at).toISOString().slice(0, 7); // YYYY-MM
  const tmpPdfName  = `${reportId}_regen.pdf`;
  const pdfPath     = path.join(tmpDir, tmpPdfName);
  const pdfScript   = path.join(__dirname, 'tools', 'generate_report_pdf.py');

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
  console.log(`  ✓ PDF built`);

  // 6. Clean up the local content JSON (already stored in Supabase)
  try { fs.unlinkSync(contentFile); } catch (_) { /* Non-fatal */ }

  if (upload) {
    // 7a. Overwrite the existing PDF in Supabase Storage
    const pdfBuffer      = fs.readFileSync(pdfPath);
    const storagePath    = `${proposition.id}/${reportId}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from('reports')
      .update(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (uploadError) throw new Error(`PDF upload failed: ${uploadError.message}`);
    console.log(`  ✓ PDF uploaded → Storage: ${storagePath}`);

    // 8. Update the PDF URL in the DB and ensure status stays pending_review
    await updateReportPdfUrl(reportId, storagePath);
    await updateReportStatus(reportId, 'pending_review');
    console.log(`  ✓ Report updated — status: pending_review (ready for admin review)`);

    // 9. Clean up local PDF (it's now in Supabase)
    try { fs.unlinkSync(pdfPath); } catch (_) { /* Non-fatal */ }

    console.log('\n✓ PDF regenerated and uploaded. Review it on the admin panel, then click Send to Client when ready.');
  } else {
    // 7b. Save locally for review only
    const outputsDir  = path.join(__dirname, 'outputs');
    fs.mkdirSync(outputsDir, { recursive: true });
    const localPath   = path.join(outputsDir, `${slug}_${reportMonth}_regen.pdf`);
    fs.renameSync(pdfPath, localPath);
    console.log(`  ✓ PDF saved → ${localPath}`);
    console.log('\nReview the PDF at the path above.');
    console.log('To upload and update Supabase, re-run with --upload.');
  }
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
  // --upload flag: overwrite PDF in Supabase Storage and keep report as pending_review
  if (args.regenPdf) {
    await regenPdfFromStorage(args.reportId, args.upload);
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
