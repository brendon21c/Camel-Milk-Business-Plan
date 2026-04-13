/**
 * tools/intake.js
 *
 * Registers a new prospect in the system.
 * Accepts prospect data via CLI flags or a JSON string (--json flag),
 * making it compatible with both manual entry and future web form payloads.
 *
 * What it does:
 *   1. Validates required fields
 *   2. Validates factor weight rules (1–5 scale, max three 5s)
 *   3. Writes a new row to `clients` (status: 'prospect')
 *   4. Writes a new row to `propositions` (status: 'prospect')
 *   5. Sends a notification email to Brendon via Resend
 *
 * Usage (CLI):
 *   node tools/intake.js \
 *     --name "Jane Smith" \
 *     --email "jane@example.com" \
 *     --phone "+1 555 123 4567" \
 *     --company "Smith Ventures" \
 *     --description "Export dehydrated camel milk from Kenya to Canada" \
 *     --type "physical_import_export" \
 *     --origin "Kenya" \
 *     --market "Canada" \
 *     --segment "health food consumers" \
 *     --plan "starter" \
 *     --industry-category "food_beverage" \
 *     --weights '{"market_demand":5,"regulatory":3,"competitive":3,"financial":5,"supply_chain":3,"risk":3}' \
 *     --how-heard "Fiverr" \
 *     --notes "Focused on prairie provinces"
 *
 * Usage (JSON payload — for web form integration):
 *   node tools/intake.js --json '{ "name": "Jane Smith", "email": "...", ... }'
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createClient, createProposition } = require('../db');

// Optional: pass --org-id to link this client to an existing organization

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Brendon's email — all prospect notifications go here
const ADMIN_EMAIL = 'brennon.mckeever@gmail.com';
const FROM_EMAIL  = 'McKeever Consulting <onboarding@resend.dev>';

// Valid proposition types (must match the DB enum / column values)
const VALID_TYPES = [
  'physical_import_export',
  'physical_domestic',
  'saas_software',
  'service_business',
  'digital_product',
];

// Valid plan tiers
const VALID_PLANS = ['starter', 'pro', 'retainer'];

// Valid industry categories (must match migration 009 CHECK constraint)
const VALID_INDUSTRY_CATEGORIES = [
  'food_beverage',
  'energy_clean_tech',
  'medical_devices',
  'chemicals_materials',
  'electronics',
  'apparel_textiles',
  'cosmetics',
  'general_manufacturing',
];

// Pricing per plan — kept here so proposal generation and intake stay in sync
const PLAN_PRICING = {
  starter:  { label: 'Starter',  price: '$100',       description: 'One-time report' },
  pro:      { label: 'Pro',      price: '$250',        description: 'One-time report + 1 monthly refresh' },
  retainer: { label: 'Retainer', price: '$150/month',  description: 'Ongoing monthly reports' },
};

// The 6 viability score factors and their default weights
const DEFAULT_WEIGHTS = {
  market_demand: 3,
  regulatory:    3,
  competitive:   3,
  financial:     3,
  supply_chain:  3,
  risk:          3,
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses process.argv into a flat key→value object.
 * Supports --key value and --key=value styles.
 * If --json is present, parses its value as the base object and merges CLI flags on top.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      parsed[key] = value;
    }
  }

  // If --json provided, parse it as the base and let any CLI flags override
  if (parsed.json) {
    try {
      const base = JSON.parse(parsed.json);
      return { ...base, ...parsed };
    } catch {
      console.error('Error: --json value is not valid JSON.');
      process.exit(1);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates the parsed intake data.
 * Returns an array of error strings (empty = valid).
 */
function validate(data) {
  const errors = [];

  if (!data.name)        errors.push('--name is required');
  if (!data.email)       errors.push('--email is required');
  if (!data.phone)       errors.push('--phone is required');
  if (!data.description) errors.push('--description is required');
  if (!data.type)        errors.push('--type is required');
  if (!data.market)      errors.push('--market (primary market) is required');
  if (!data.plan)        errors.push('--plan is required');

  if (data.type && !VALID_TYPES.includes(data.type)) {
    errors.push(`--type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (data.plan && !VALID_PLANS.includes(data.plan)) {
    errors.push(`--plan must be one of: ${VALID_PLANS.join(', ')}`);
  }

  // industry_category is optional but must be a known value if provided
  if (data.industry_category && !VALID_INDUSTRY_CATEGORIES.includes(data.industry_category)) {
    errors.push(`--industry-category must be one of: ${VALID_INDUSTRY_CATEGORIES.join(', ')}`);
  }

  // Origin country required only for physical propositions
  if (data.type && (data.type === 'physical_import_export') && !data.origin) {
    errors.push('--origin (origin country) is required for physical_import_export propositions');
  }

  // Validate factor weights if provided
  if (data.weights) {
    const weightErrors = validateWeights(data.weights);
    errors.push(...weightErrors);
  }

  return errors;
}

/**
 * Validates factor weights object.
 * Rules: all keys present, all values 1–5, maximum three 5s.
 * @param {Object|string} weights - The weights object or a JSON string of it.
 * @returns {string[]} Array of error messages.
 */
function validateWeights(weights) {
  const errors = [];
  let parsed = weights;

  if (typeof weights === 'string') {
    try {
      parsed = JSON.parse(weights);
    } catch {
      return ['--weights must be valid JSON (e.g. \'{"market_demand":3,...}\')'];
    }
  }

  const required = Object.keys(DEFAULT_WEIGHTS);
  for (const key of required) {
    if (!(key in parsed)) {
      errors.push(`Factor weight missing: ${key}`);
    } else {
      const val = Number(parsed[key]);
      if (!Number.isInteger(val) || val < 1 || val > 5) {
        errors.push(`Factor weight "${key}" must be an integer 1–5 (got ${parsed[key]})`);
      }
    }
  }

  // Count how many 5s the client assigned
  const fiveCount = required.filter(k => Number(parsed[k]) === 5).length;
  if (fiveCount > 3) {
    errors.push(`Factor weights: maximum 3 factors can be rated 5 (you have ${fiveCount})`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Sends a prospect notification email to Brendon via the Resend REST API.
 * Uses fetch (Node 18+) so no extra SDK dependency is needed.
 * @param {Object} client      - The saved client row from Supabase.
 * @param {Object} proposition - The saved proposition row from Supabase.
 */
async function sendNotificationEmail(client, proposition) {
  const plan = PLAN_PRICING[proposition.plan_tier] || {};

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1C3557; padding: 24px 32px;">
        <h1 style="color: #C8A94A; font-size: 22px; margin: 0;">McKeever Consulting</h1>
        <p style="color: #8A9BB0; font-size: 13px; margin: 4px 0 0;">New Prospect Notification</p>
      </div>

      <div style="padding: 32px; background: #F7F8FA; border: 1px solid #e0e0e0;">
        <h2 style="color: #1C3557; margin-top: 0;">New prospect submitted</h2>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <tr><td style="padding: 8px 0; color: #555; width: 140px;"><strong>Name</strong></td>
              <td style="padding: 8px 0;">${client.name}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Email</strong></td>
              <td style="padding: 8px 0;"><a href="mailto:${client.email}">${client.email}</a></td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Phone</strong></td>
              <td style="padding: 8px 0;">${client.phone || '—'}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Company</strong></td>
              <td style="padding: 8px 0;">${client.company_name || '—'}</td></tr>
        </table>

        <div style="background: #fff; border-left: 4px solid #C8A94A; padding: 16px 20px; margin-bottom: 24px;">
          <p style="margin: 0 0 8px; color: #1C3557; font-weight: bold;">Proposition</p>
          <p style="margin: 0; color: #1E1E2E;">${proposition.description}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <tr><td style="padding: 8px 0; color: #555; width: 140px;"><strong>Type</strong></td>
              <td style="padding: 8px 0;">${proposition.proposition_type}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Origin</strong></td>
              <td style="padding: 8px 0;">${proposition.origin_country || '—'}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Market</strong></td>
              <td style="padding: 8px 0;">${proposition.target_country}${proposition.target_demographic ? ' — ' + proposition.target_demographic : ''}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Plan</strong></td>
              <td style="padding: 8px 0;"><strong style="color: #C8A94A;">${plan.label}</strong> — ${plan.price} (${plan.description})</td></tr>
        </table>

        <p style="color: #555; font-size: 13px; margin-top: 24px;">
          <strong>Proposition ID:</strong> ${proposition.id}<br>
          <strong>Client ID:</strong> ${client.id}
        </p>

        <p style="color: #555; font-size: 13px;">
          Next step: run <code>node tools/generate_proposal.js --proposition-id ${proposition.id}</code>
          to generate and send the proposal PDF.
        </p>
      </div>

      <div style="padding: 16px 32px; background: #1C3557; text-align: center;">
        <p style="color: #8A9BB0; font-size: 12px; margin: 0;">
          Confidential — McKeever Consulting internal notification
        </p>
      </div>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [ADMIN_EMAIL],
      subject: `New prospect: ${client.name} — ${plan.label} plan`,
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  // Parse weights — use defaults if not provided, merge any provided values on top
  let weights = { ...DEFAULT_WEIGHTS };
  if (args.weights) {
    const provided = typeof args.weights === 'string' ? JSON.parse(args.weights) : args.weights;
    weights = { ...weights, ...provided };
  }

  // Build the full data object from parsed args
  const inputData = {
    name:        args.name,
    email:       args.email,
    phone:       args.phone,
    company:     args.company || null,
    description: args.description,
    type:        args.type,
    origin:      args.origin || null,
    market:      args.market,
    segment:     args.segment || null,
    plan:              args.plan ? args.plan.toLowerCase() : null,
    industry_category: args['industry-category'] || null,
    weights,
    how_heard:         args['how-heard'] || null,
    notes:             args.notes || null,
    org_id:            args['org-id'] || null,
  };

  // Validate
  const errors = validate(inputData);
  if (errors.length > 0) {
    console.error('\nValidation errors:');
    errors.forEach(e => console.error(`  • ${e}`));
    console.error('\nRun with --help for usage examples.');
    process.exit(1);
  }

  console.log('\nRegistering new prospect...');

  // Build additional context string combining how_heard and notes
  const contextParts = [];
  if (inputData.how_heard) contextParts.push(`How heard: ${inputData.how_heard}`);
  if (inputData.notes)     contextParts.push(`Notes: ${inputData.notes}`);

  // 1. Create client record
  // organization_id is optional — pass --org-id to link this contact to an existing org
  const client = await createClient({
    name:            inputData.name,
    email:           inputData.email,
    phone:           inputData.phone,
    company_name:    inputData.company,   // DB column is company_name
    status:          'prospect',
    organization_id: inputData.org_id || null,
  });
  console.log(`✓ Client created: ${client.id}`);

  // 2. Create proposition record
  const proposition = await createProposition({
    client_id:          client.id,
    title:              inputData.description.slice(0, 100), // short title from description
    description:        inputData.description,
    proposition_type:   inputData.type,
    origin_country:     inputData.origin,
    target_country:     inputData.market,
    target_demographic: inputData.segment,
    plan_tier:          inputData.plan,
    industry_category:  inputData.industry_category,
    factor_weights:     inputData.weights,
    additional_context: contextParts.join(' | ') || null,
    status:             'prospect',
    schedule_type:      'on_demand', // set properly on activation
  });
  console.log(`✓ Proposition created: ${proposition.id}`);

  // 3. Send notification email to Brendon
  await sendNotificationEmail(client, proposition);
  console.log(`✓ Notification email sent to ${ADMIN_EMAIL}`);

  console.log('\n── Intake complete ──────────────────────────────────');
  console.log(`  Client ID:      ${client.id}`);
  console.log(`  Proposition ID: ${proposition.id}`);
  console.log(`  Plan:           ${PLAN_PRICING[inputData.plan].label} (${PLAN_PRICING[inputData.plan].price})`);
  console.log('\nNext step:');
  console.log(`  node tools/generate_proposal.js --proposition-id ${proposition.id}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
