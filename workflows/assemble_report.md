# Workflow: Assemble Report

**Agent tier:** Sonnet by default. Escalate to Opus if viability scoring requires complex
multi-factor reasoning or if research outputs contain significant conflicts that require
deep synthesis. Do not use Haiku — this agent makes judgement calls.
**Cache TTL:** N/A — runs once per report, no caching
**Report sections:** All 14 — this agent builds the complete PDF
**Output:** PDF uploaded to Supabase Storage `reports` bucket. URL saved to `reports.pdf_url`.
Email sent via Resend.

---

## Objective

Collect all research sub-agent outputs for a given report, synthesise them into a coherent
and professional PDF report, compute the viability score, generate the "What Changed" section
(run 2 onwards), upload the PDF to Supabase Storage, and deliver it by email via Resend.

This is the final step in every report run. It runs after all research agents have completed.

---

## Inputs

You will receive a JSON object from the orchestrator:

```json
{
  "report_id": "<uuid>",
  "proposition_id": "<uuid>",
  "client_id": "<uuid>",
  "proposition": {
    "title": "<e.g. Camel Milk Export — US Market>",
    "product_type": "<e.g. dehydrated camel milk powder>",
    "industry": "<e.g. specialty dairy / health food>",
    "origin_country": "<e.g. Somalia>",
    "target_country": "<e.g. United States>",
    "target_demographic": "<e.g. health-conscious consumers>",
    "factor_weights": {
      "market_demand": 0.25,
      "regulatory": 0.20,
      "competitive": 0.15,
      "financial": 0.20,
      "supply_chain": 0.10,
      "risk": 0.10
    }
  },
  "client": {
    "name": "<client full name>",
    "email": "<client email address>"
  },
  "run_number": "<integer — 1 for first run, increments each run>",
  "previous_report_id": "<uuid of prior report or null if run_number == 1>"
}
```

---

## Steps

### 1. Fetch All Agent Outputs

Call `db.js → getAgentOutputsByReportId(report_id)`.

Expected agents: `research_market_overview`, `research_competitors`, `research_regulatory`,
`research_production`, `research_packaging`, `research_distribution`, `research_marketing`,
`research_financials`, `research_origin_ops`, `research_legal`.

**Quality gate — hard fail if:**
- Fewer than 9 of the 10 agents completed with `status: "complete"`
- Any of these 4 critical agents failed: `research_market_overview`, `research_regulatory`,
  `research_financials`, `research_origin_ops`
- Any of the 6 viability score factors cannot be populated (see Step 3)

If hard fail: update `reports.status` to `"failed"`, write error to `reports.error_message`,
send failure alert email to Brendon (not the client), and stop.

**Soft failures** (non-critical agent failed): continue, note the gap in the report,
flag in the Executive Summary.

### 2. Fetch Previous Report Data (run 2+)

If `run_number > 1` and `previous_report_id` is not null:
- Call `db.js → getAgentOutputsByReportId(previous_report_id)`
- Store as `previous_outputs` — used in Step 7 (What Changed)

Skip this step on run 1.

### 3. Compute Viability Score and Data Confidence Score

#### 3a. Compute Viability Score

Calculate a weighted viability score using the 6 factors below. Each factor scores 1–5.
Apply the weights from `proposition.factor_weights`.

**Scoring guide per factor:**

| Factor | Agent source | What to assess | Score 1 | Score 5 |
|---|---|---|---|---|
| `market_demand` | market_overview | Market size, growth rate, demand drivers | Tiny/declining market | Large, fast-growing market |
| `regulatory` | regulatory | Complexity, restrictions, origin country flags | Many barriers, sanctions risk | Clear path, low compliance burden |
| `competitive` | competitors | Number of competitors, differentiation opportunity | Saturated, no differentiation room | Blue ocean or clear niche |
| `financial` | financials | Margins, startup capital vs. budget, unit economics | Unviable margins, high capex | Strong margins, accessible capital |
| `supply_chain` | origin_ops | Supply reliability, logistics risk, country risk | Unreliable supply, high risk | Stable supply, low risk |
| `risk` | legal + regulatory + origin_ops | Legal exposure, sanctions, currency risk | High exposure across factors | Low exposure, manageable risks |

**Calculation:**
```
weighted_score = sum(factor_score * factor_weight for each factor)
```

**Interpretation:**
- 4.0–5.0 → **Strong** — compelling case to proceed
- 2.5–3.9 → **Moderate** — viable with caveats; key risks must be addressed
- 1.0–2.4 → **Weak** — significant barriers; reconsider or pivot

Store the score object:
```json
{
  "overall": <weighted_score rounded to 1 decimal>,
  "verdict": "Strong | Moderate | Weak",
  "factors": {
    "market_demand":  { "score": <1-5>, "weight": <weight>, "rationale": "<1 sentence>" },
    "regulatory":     { "score": <1-5>, "weight": <weight>, "rationale": "<1 sentence>" },
    "competitive":    { "score": <1-5>, "weight": <weight>, "rationale": "<1 sentence>" },
    "financial":      { "score": <1-5>, "weight": <weight>, "rationale": "<1 sentence>" },
    "supply_chain":   { "score": <1-5>, "weight": <weight>, "rationale": "<1 sentence>" },
    "risk":           { "score": <1-5>, "weight": <weight>, "rationale": "<1 sentence>" }
  }
}
```

#### 3b. Compute Data Confidence Score

After computing the viability score, run the confidence tool against all agent outputs:

```
python tools/compute_data_confidence.py --report-id <report_id>
```

This produces a `data_confidence` object with:
- **Score (0–100):** Aggregate of four signals — per-field confidence ratings (45%), agent
  completion rate (25%), source citation coverage (20%), and flagged data gaps (10%).
- **Interpretation:** High (85–100), Moderate (65–84), Low (40–64), Very Low (0–39).

Store the full output and use the top-level fields in the report:

```json
{
  "data_confidence_score": <0-100>,
  "interpretation": "High | Moderate | Low | Very Low",
  "description": "<one sentence explanation>"
}
```

**How to use the confidence score in the report:**
- Display it on the Cover Page beside the viability score badge (same visual weight)
- Reference it in the Executive Summary: "This report carries a [interpretation] data
  confidence rating of [score]/100, reflecting [brief reason — e.g. strong government
  source coverage / gaps in origin country data]."
- If confidence is Low or Very Low, add a callout box in the Executive Summary explaining
  which sections are most affected and recommending the client treat the viability verdict
  as directional rather than definitive.

**Hard fail rule:** If the confidence tool itself fails (Supabase error, no outputs found),
do NOT block PDF generation. Log the error, set `data_confidence_score` to `null`,
`interpretation` to `"Unavailable"`, and note it in the Executive Summary.

### 4. Draft All Report Sections

Write each section in plain, professional English. No bullet-point walls. Paragraphs.
Aimed at an intelligent business reader who is not a specialist in this industry.

**Brand voice:** Direct, evidence-based, honest. Do not oversell or undersell.
Flag risks clearly. Cite figures. Every claim should be traceable to a source.

**Sections to write:**

| # | Section | Source agents | Notes |
|---|---|---|---|
| 1 | Cover Page | — | Title, date, viability score badge, logo |
| 2 | Table of Contents | — | Auto-generated from sections |
| 3 | Executive Summary | All | 1 page max. Lead with viability verdict. Key findings. Top 3 risks. Top 3 opportunities. |
| 4 | Market Overview | market_overview | Use narrative_summary + key figures |
| 5 | Competitor Analysis | competitors | Use narrative_summary + competitors table |
| 6 | Regulatory Landscape | regulatory | Use narrative_summary. Flag any hard blockers prominently. |
| 7 | Production & Equipment | production | Use narrative_summary + equipment table |
| 8 | Packaging | packaging | Use narrative_summary + packaging options table |
| 9 | Distribution Strategy | distribution | Use narrative_summary + channels table |
| 10 | Marketing & Influencers | marketing | Use narrative_summary + influencer list + health claims |
| 11 | Financial Projections | financials | Use narrative_summary + unit economics table + startup capital |
| 12 | Risk Assessment | legal + regulatory + origin_ops | Consolidate all risks. Rate each: likelihood × impact. |
| 13 | Recommendations | All | 5–7 prioritised, actionable recommendations. Most important first. |
| 14 | What Changed This Month | previous_outputs vs current | Run 2+ only. Bullet-point deltas per section. Skip on run 1. |
| 15 | Sources | report_sources table | Full URL list, grouped by section |

### 5. Generate PDF

Use `tools/generate_report_pdf.py` with the following call:

```
python tools/generate_report_pdf.py \
  --report-id <report_id> \
  --content <path to JSON content file in .tmp/> \
  --output outputs/<proposition_slug>_<YYYY-MM>.pdf
```

**Brand spec for the PDF tool:**
- Primary colour: deep forest green `#1E4D3B`
- Accent colour: warm gold `#C9A84C`
- Background: white
- Logo: `assets/logo.png` — appears on cover page and in every page header
- Font: Helvetica (reportlab built-in)
- Cover page: full-page, green background, white title, gold viability score badge
- Headers/footers: green bar, white text, logo left, page number right
- Section headings: green, bold
- Tables: alternating white/light-green rows, gold header row
- Page numbers: bottom right

Write section content to `.tmp/<report_id>_content.json` before calling the PDF tool,
so the tool has a stable input file.

### 6. Upload to Supabase Storage

Upload the generated PDF to the `reports` Supabase Storage bucket:
- Path: `<proposition_id>/<report_id>.pdf`
- Bucket: `reports` (private)

Use the Supabase Python client:
```python
with open(pdf_path, "rb") as f:
    supabase.storage.from_("reports").upload(
        path=f"{proposition_id}/{report_id}.pdf",
        file=f,
        file_options={"content-type": "application/pdf"}
    )
```

Get a signed URL (valid 7 days) for the email attachment:
```python
signed = supabase.storage.from_("reports").create_signed_url(
    path=f"{proposition_id}/{report_id}.pdf",
    expires_in=604800  # 7 days
)
pdf_url = signed["signedURL"]
```

Update the report record: `db.js → updateReportPdfUrl(report_id, pdf_url)`.

### 7. Send Email via Resend

Send the report email to the client using Resend. Use the Python `httpx` library — there
is no Resend Python SDK dependency needed.

```python
import httpx

resend_api_key = os.getenv("RESEND_API_KEY")

payload = {
    "from":    "reports@yourdomain.com",  # must be a verified Resend sender
    "to":      [client_email],
    "subject": f"{proposition_title} — Viability Report {report_month}",
    "html":    email_body_html,           # see email body spec below
    "attachments": [
        {
            "filename": f"{proposition_slug}_{report_month}.pdf",
            "path":     pdf_url            # signed Supabase URL
        }
    ]
}

response = httpx.post(
    "https://api.resend.com/emails",
    headers={"Authorization": f"Bearer {resend_api_key}"},
    json=payload,
    timeout=30
)
```

**Email body spec:**
- Subject: `[Proposition Title] — Viability Report [Month YYYY]`
- Body (HTML): 3–4 sentences. State the viability verdict and score. Name the top finding.
  Tell them the full report is attached. Keep it under 150 words.
- Attach the PDF directly (do not just link to it)

### 8. Finalise Report Record

Call `db.js → updateReportStatus(report_id, "complete")`.

Clean up: delete `.tmp/<report_id>_content.json`.

---

## Failure Alerting

If any step fails after the quality gate (PDF generation, upload, email):
1. Log the error to `reports.error_message`
2. Set `reports.status` to `"failed"`
3. Send a failure alert email to Brendon only (not the client):
   - To: `brennon.mckeever@gmail.com`
   - Subject: `FAILED: [Proposition Title] report run [report_id]`
   - Body: which step failed, the error message, the report ID

The client is never notified of failures — Brendon handles recovery manually.

---

## Edge Cases

| Situation | How to handle |
|---|---|
| Critical agent output missing | Hard fail — alert Brendon, do not send partial report to client |
| Non-critical agent output missing | Soft fail — note gap in section, continue building report |
| Viability score factor cannot be computed | Hard fail — score integrity must be maintained |
| PDF generation fails | Log error, alert Brendon, do not attempt email |
| Storage upload fails | Log error, alert Brendon — PDF exists locally in `outputs/` |
| Email delivery fails | Log error, alert Brendon — PDF is in Storage, can be resent manually |
| run_number > 1 but previous_report_id is null | Skip "What Changed" section, log warning |
| factor_weights do not sum to 1.0 | Normalise before computing — log the normalisation as a warning |

---

## Quality Bar

Before generating the PDF, verify:
- [ ] All 6 viability score factors are populated with a score and rationale
- [ ] Overall viability score is between 1.0 and 5.0
- [ ] Data confidence score is present (0–100) or explicitly set to null with reason noted
- [ ] If confidence is Low or Very Low, a callout is present in the Executive Summary
- [ ] Executive Summary is present and leads with the verdict
- [ ] All 13 sections (or 14 on run 2+) have content — no empty sections
- [ ] Risk Assessment contains at least 3 risks
- [ ] Recommendations contains at least 5 actionable items
- [ ] Sources section has at least 10 URLs
- [ ] No section contains raw JSON — everything is prose or formatted tables
- [ ] "What Changed" section is present on run 2+ and absent on run 1
