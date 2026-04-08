/**
 * tools/generate_proposal.js
 *
 * Generates a branded proposal PDF for a prospect and emails it to both
 * the client and Brendon for review.
 *
 * What it does:
 *   1. Fetches client + proposition data from Supabase
 *   2. Writes a data JSON file to .tmp/ for the Python PDF builder
 *   3. Calls generate_proposal_pdf.py to produce the PDF
 *   4. Sends the PDF to both the client and Brendon via Resend
 *   5. Updates proposition status to 'proposal_sent'
 *
 * Usage:
 *   node tools/generate_proposal.js --proposition-id <uuid>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const { getPropositionById, getClientById, activateProposition } = require('../db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = 'brennon.mckeever@gmail.com';
const FROM_EMAIL  = 'McKeever Consulting <onboarding@resend.dev>';

// Pricing labels for the email subject line
const PLAN_LABELS = {
  starter:  'Starter — $100',
  pro:      'Pro — $250',
  retainer: 'Retainer — $150/month',
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Extracts --proposition-id from process.argv.
 * Exits with a helpful message if it's missing.
 */
function getPropositionId() {
  const args = process.argv.slice(2);
  const idx  = args.indexOf('--proposition-id');

  if (idx === -1 || !args[idx + 1]) {
    console.error('Usage: node tools/generate_proposal.js --proposition-id <uuid>');
    process.exit(1);
  }

  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

/**
 * Sends the proposal PDF via Resend to both the client and Brendon.
 * The PDF is attached as a base64-encoded attachment.
 *
 * @param {Object} client      - Client row from Supabase.
 * @param {Object} proposition - Proposition row from Supabase.
 * @param {string} pdfPath     - Absolute path to the generated PDF.
 */
async function sendProposalEmails(client, proposition, pdfPath) {
  // Read PDF and encode as base64 for the Resend attachment
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');
  const filename  = `McKeever_Consulting_Proposal_${client.name.replace(/\s+/g, '_')}.pdf`;

  const planLabel = PLAN_LABELS[proposition.plan_tier] || proposition.plan_tier;

  // ── Client email ──────────────────────────────────────────────────────
  const clientHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1C3557; padding: 24px 32px;">
        <h1 style="color: #C8A94A; font-size: 22px; margin: 0;">McKeever Consulting</h1>
        <p style="color: #8A9BB0; font-size: 13px; margin: 4px 0 0;">Business Viability Intelligence</p>
      </div>

      <div style="padding: 32px; background: #F7F8FA; border: 1px solid #e0e0e0;">
        <h2 style="color: #1C3557; margin-top: 0;">Your Proposal is Ready</h2>

        <p style="color: #1E1E2E;">Dear ${client.name},</p>

        <p style="color: #1E1E2E;">
          Thank you for your interest in McKeever Consulting. Please find your personalised
          service proposal attached to this email.
        </p>

        <div style="background: #fff; border-left: 4px solid #C8A94A; padding: 16px 20px; margin: 24px 0;">
          <p style="margin: 0 0 4px; color: #1C3557; font-weight: bold;">Your Selected Plan</p>
          <p style="margin: 0; color: #C8A94A; font-size: 18px; font-weight: bold;">${planLabel}</p>
        </div>

        <p style="color: #1E1E2E;">
          The proposal covers exactly what we'll research, what you'll receive, and
          the terms of our engagement. To move forward:
        </p>

        <ol style="color: #1E1E2E; line-height: 1.8;">
          <li>Review the attached proposal</li>
          <li>Sign the acceptance block (digital signature accepted)</li>
          <li>Reply to this email with your signed copy</li>
          <li>We'll send payment instructions and begin within 24 hours of confirmation</li>
        </ol>

        <p style="color: #1E1E2E;">
          If you have any questions, please don't hesitate to reply to this email.
        </p>

        <p style="color: #1E1E2E;">
          Best regards,<br>
          <strong>Brendon McKeever</strong><br>
          McKeever Consulting<br>
          <a href="mailto:${ADMIN_EMAIL}" style="color: #C8A94A;">${ADMIN_EMAIL}</a>
        </p>
      </div>

      <div style="padding: 16px 32px; background: #1C3557; text-align: center;">
        <p style="color: #8A9BB0; font-size: 12px; margin: 0;">
          Confidential — Prepared exclusively for ${client.name}
        </p>
      </div>
    </div>
  `;

  // ── Brendon's copy email ──────────────────────────────────────────────
  const adminHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1C3557; padding: 24px 32px;">
        <h1 style="color: #C8A94A; font-size: 22px; margin: 0;">McKeever Consulting</h1>
        <p style="color: #8A9BB0; font-size: 13px; margin: 4px 0 0;">Admin Copy — Proposal Sent</p>
      </div>

      <div style="padding: 32px; background: #F7F8FA; border: 1px solid #e0e0e0;">
        <h2 style="color: #1C3557; margin-top: 0;">Proposal sent to ${client.name}</h2>

        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; color: #555; width: 140px;"><strong>Client</strong></td>
              <td>${client.name}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Email</strong></td>
              <td><a href="mailto:${client.email}">${client.email}</a></td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Plan</strong></td>
              <td><strong style="color: #C8A94A;">${planLabel}</strong></td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Proposition</strong></td>
              <td>${proposition.title}</td></tr>
          <tr><td style="padding: 8px 0; color: #555;"><strong>Proposition ID</strong></td>
              <td style="font-size: 12px; color: #888;">${proposition.id}</td></tr>
        </table>

        <p style="color: #555; font-size: 13px; margin-top: 24px;">
          When the client confirms and pays, run:<br>
          <code style="background: #eee; padding: 4px 8px; border-radius: 3px;">
            node tools/activate.js --proposition-id ${proposition.id}
          </code>
        </p>
      </div>
    </div>
  `;

  // ── Send both emails via Resend ───────────────────────────────────────

  const attachment = {
    filename,
    content: pdfBase64,
  };

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
      subject:     `Your McKeever Consulting Proposal — ${planLabel}`,
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
      subject:     `[Admin Copy] Proposal sent to ${client.name} — ${planLabel}`,
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const propositionId = getPropositionId();

  console.log(`\nGenerating proposal for proposition: ${propositionId}`);

  // 1. Fetch proposition and client from Supabase
  const proposition = await getPropositionById(propositionId);
  const client      = await getClientById(proposition.client_id);

  console.log(`  Client:      ${client.name} <${client.email}>`);
  console.log(`  Plan:        ${PLAN_LABELS[proposition.plan_tier] || proposition.plan_tier}`);
  console.log(`  Proposition: ${proposition.title}`);

  // 2. Write proposal data JSON for the Python PDF builder
  const tmpDir  = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const dataFile = path.join(tmpDir, `${propositionId}_proposal.json`);
  const pdfFile  = path.join(tmpDir, `${propositionId}_proposal.pdf`);

  const proposalData = {
    proposition_id:          proposition.id,
    proposition_title:       proposition.title,
    proposition_description: proposition.description,
    proposition_type:        proposition.proposition_type,
    origin_country:          proposition.origin_country || null,
    target_country:          proposition.target_country,
    target_demographic:      proposition.target_demographic || null,
    plan_tier:               proposition.plan_tier,
    client_name:             client.name,
    client_email:            client.email,
    client_phone:            client.phone || null,
    client_company:          client.company || null,
    proposal_date:           new Date().toLocaleDateString('en-US', {
                               month: 'long', day: 'numeric', year: 'numeric'
                             }),
  };

  fs.writeFileSync(dataFile, JSON.stringify(proposalData, null, 2));
  console.log(`✓ Proposal data written to ${dataFile}`);

  // 3. Run the Python PDF builder
  // Determine python executable — prefer venv if present
  const venvPython = path.join(__dirname, '..', 'venv', 'Scripts', 'python.exe');
  const python     = fs.existsSync(venvPython) ? `"${venvPython}"` : 'python';
  const script     = path.join(__dirname, 'generate_proposal_pdf.py');

  console.log('  Building PDF...');
  try {
    execSync(
      `${python} "${script}" --data "${dataFile}" --output "${pdfFile}"`,
      { stdio: 'inherit', cwd: path.join(__dirname, '..') }
    );
  } catch (err) {
    throw new Error(`PDF generation failed: ${err.message}`);
  }
  console.log(`✓ PDF generated: ${pdfFile}`);

  // 4. Send proposal emails to client and Brendon
  console.log('  Sending emails...');
  await sendProposalEmails(client, proposition, pdfFile);
  console.log(`✓ Proposal emailed to ${client.email} and ${ADMIN_EMAIL}`);

  // 5. Update proposition status to proposal_sent
  await activateProposition(propositionId, { status: 'proposal_sent' });
  console.log('✓ Proposition status → proposal_sent');

  // 6. Clean up the temporary data JSON (keep the PDF in .tmp for reference)
  fs.unlinkSync(dataFile);

  console.log('\n── Proposal complete ────────────────────────────────');
  console.log(`  PDF saved to: ${pdfFile}`);
  console.log(`  Emails sent to: ${client.email} + ${ADMIN_EMAIL}`);
  console.log('\nWhen the client confirms and pays, run:');
  console.log(`  node tools/activate.js --proposition-id ${propositionId}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
