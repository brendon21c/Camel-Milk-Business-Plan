"""
tools/generate_proposal_pdf.py

Generates a branded McKeever Consulting proposal PDF for a prospect.
Reads a JSON data file written by generate_proposal.js and renders it
into a clean, professional proposal document using ReportLab.

Fonts and brand colours match the main report (generate_report_pdf.py).

Usage:
    python tools/generate_proposal_pdf.py \\
        --data   .tmp/<proposition_id>_proposal.json \\
        --output .tmp/<proposition_id>_proposal.pdf
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import httpx
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

# ---------------------------------------------------------------------------
# Brand colours
# ---------------------------------------------------------------------------

NAVY   = HexColor('#1C3557')
GOLD   = HexColor('#C8A94A')
SILVER = HexColor('#8A9BB0')
NEAR_BLACK = HexColor('#1E1E2E')
OFF_WHITE  = HexColor('#F7F8FA')
LIGHT_BLUE = HexColor('#EEF2F7')

# ---------------------------------------------------------------------------
# Font setup — download Montserrat from GitHub if not already cached
# ---------------------------------------------------------------------------

FONT_DIR   = Path(__file__).parent.parent / 'assets' / 'fonts'
FONT_BASE  = 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/'
FONT_FILES = {
    'Montserrat-Regular':    'Montserrat-Regular.ttf',
    'Montserrat-Medium':     'Montserrat-Medium.ttf',
    'Montserrat-SemiBold':   'Montserrat-SemiBold.ttf',
    'Montserrat-Bold':       'Montserrat-Bold.ttf',
    'Montserrat-ExtraBold':  'Montserrat-ExtraBold.ttf',
}


def ensure_fonts():
    """Download Montserrat TTFs from Google Fonts GitHub if they aren't cached locally."""
    FONT_DIR.mkdir(parents=True, exist_ok=True)

    for name, filename in FONT_FILES.items():
        dest = FONT_DIR / filename
        if not dest.exists():
            url = FONT_BASE + filename
            print(f'Downloading font: {filename}')
            try:
                response = httpx.get(url, follow_redirects=True, timeout=30)
                response.raise_for_status()
                dest.write_bytes(response.content)
            except Exception as e:
                print(f'Warning: could not download {filename}: {e}')
                print('Falling back to Helvetica.')
                return False  # signal to caller to use fallback fonts

        pdfmetrics.registerFont(TTFont(name, str(dest)))

    return True  # all fonts available


# ---------------------------------------------------------------------------
# Page templates — cover page vs. interior pages
# ---------------------------------------------------------------------------

PAGE_W, PAGE_H = letter  # 8.5 × 11 inches

MARGIN_OUTER = 0.65 * inch
MARGIN_INNER = 0.75 * inch
CONTENT_W    = PAGE_W - MARGIN_OUTER - MARGIN_INNER


def draw_interior_page(canvas, doc):
    """
    Draws the header bar and footer on every interior (non-cover) page.
    Called automatically by ReportLab on each page render.
    """
    canvas.saveState()

    # ── Header bar ────────────────────────────────────────────────────────
    bar_h = 30
    canvas.setFillColor(NAVY)
    canvas.rect(0, PAGE_H - bar_h, PAGE_W, bar_h, fill=1, stroke=0)

    # Wordmark left — "McKeever" ExtraBold + "CONSULTING" tracked
    canvas.setFillColor(white)
    canvas.setFont('Montserrat-ExtraBold', 10)
    canvas.drawString(MARGIN_OUTER, PAGE_H - bar_h + 10, 'McKeever')
    canvas.setFont('Montserrat-Medium', 7)
    canvas.setFillColor(GOLD)
    canvas.drawString(MARGIN_OUTER + 60, PAGE_H - bar_h + 11.5, 'C O N S U L T I N G')

    # Page number right
    canvas.setFillColor(SILVER)
    canvas.setFont('Montserrat-Regular', 8)
    page_label = f'Page {doc.page}'
    canvas.drawRightString(PAGE_W - MARGIN_OUTER, PAGE_H - bar_h + 10, page_label)

    # ── Footer ────────────────────────────────────────────────────────────
    canvas.setStrokeColor(SILVER)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN_OUTER, 0.45 * inch, PAGE_W - MARGIN_OUTER, 0.45 * inch)
    canvas.setFillColor(SILVER)
    canvas.setFont('Montserrat-Regular', 7)
    canvas.drawCentredString(
        PAGE_W / 2, 0.28 * inch,
        'Confidential — Prepared by McKeever Consulting'
    )

    canvas.restoreState()


# ---------------------------------------------------------------------------
# Style helpers
# ---------------------------------------------------------------------------

def styles(fonts_ok):
    """
    Returns a dict of named ParagraphStyles using Montserrat if available,
    falling back to Helvetica if fonts couldn't be downloaded.
    """
    regular   = 'Montserrat-Regular'   if fonts_ok else 'Helvetica'
    medium    = 'Montserrat-Medium'    if fonts_ok else 'Helvetica'
    semibold  = 'Montserrat-SemiBold'  if fonts_ok else 'Helvetica-Bold'
    bold      = 'Montserrat-Bold'      if fonts_ok else 'Helvetica-Bold'
    extrabold = 'Montserrat-ExtraBold' if fonts_ok else 'Helvetica-Bold'

    return {
        'h1': ParagraphStyle('h1',
            fontName=extrabold, fontSize=22, leading=28,
            textColor=NAVY, spaceAfter=6),

        'h2': ParagraphStyle('h2',
            fontName=bold, fontSize=14, leading=18,
            textColor=NAVY, spaceBefore=18, spaceAfter=6),

        'h3': ParagraphStyle('h3',
            fontName=semibold, fontSize=11, leading=15,
            textColor=NAVY, spaceBefore=10, spaceAfter=4),

        'body': ParagraphStyle('body',
            fontName=regular, fontSize=10, leading=15,
            textColor=NEAR_BLACK, spaceAfter=8),

        'body_gold': ParagraphStyle('body_gold',
            fontName=semibold, fontSize=10, leading=15,
            textColor=GOLD, spaceAfter=6),

        'label': ParagraphStyle('label',
            fontName=semibold, fontSize=9, leading=13,
            textColor=SILVER),

        'callout_label': ParagraphStyle('callout_label',
            fontName=bold, fontSize=10, leading=14,
            textColor=NAVY, spaceAfter=3),

        'callout_body': ParagraphStyle('callout_body',
            fontName=regular, fontSize=10, leading=14,
            textColor=NEAR_BLACK),

        'small': ParagraphStyle('small',
            fontName=regular, fontSize=8, leading=12,
            textColor=SILVER),

        'signature_label': ParagraphStyle('sig_label',
            fontName=medium, fontSize=9, leading=13,
            textColor=SILVER),

        'signature_name': ParagraphStyle('sig_name',
            fontName=bold, fontSize=11, leading=15,
            textColor=NEAR_BLACK),
    }


# ---------------------------------------------------------------------------
# Reusable block renderers
# ---------------------------------------------------------------------------

def section_rule(s):
    """Gold horizontal rule used under section headings."""
    return HRFlowable(
        width='100%', thickness=1.5, color=GOLD,
        spaceAfter=8, spaceBefore=0
    )


def callout_box(label, text, s):
    """
    Highlighted callout box with a navy left bar.
    Used for key terms, important notes, and next-steps blocks.
    """
    content = [
        Paragraph(label, s['callout_label']),
        Paragraph(text,  s['callout_body']),
    ]
    t = Table([[content]], colWidths=[CONTENT_W - 0.5 * inch])
    t.setStyle(TableStyle([
        ('BACKGROUND',   (0, 0), (-1, -1), LIGHT_BLUE),
        ('LEFTPADDING',  (0, 0), (-1, -1), 14),
        ('RIGHTPADDING', (0, 0), (-1, -1), 14),
        ('TOPPADDING',   (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 10),
        ('LINEBEFORE',   (0, 0), (0, -1), 4, NAVY),
    ]))
    return t


def detail_table(rows, s, col_widths=None):
    """
    Two-column label/value table for proposal details (e.g. client info, plan info).
    rows: list of (label, value) tuples.
    """
    col_widths = col_widths or [1.6 * inch, CONTENT_W - 1.6 * inch]
    data = [
        [Paragraph(label, s['label']), Paragraph(str(value), s['body'])]
        for label, value in rows
    ]
    t = Table(data, colWidths=col_widths)
    t.setStyle(TableStyle([
        ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING',    (0, 0), (-1, -1), 2),
        ('LINEBELOW',     (0, 0), (-1, -1), 0.3, HexColor('#e0e0e0')),
    ]))
    return t


def pricing_table(plan_tier, s):
    """
    Three-tier pricing table with the client's chosen plan highlighted in gold.
    """
    plans = [
        ('Starter',  '$100',       'One-time viability report',            'starter'),
        ('Pro',      '$250',       'One-time report + 1 monthly refresh',  'pro'),
        ('Retainer', '$150/month', 'Ongoing monthly reports & monitoring', 'retainer'),
    ]

    header = [
        Paragraph('Plan',        s['label']),
        Paragraph('Investment',  s['label']),
        Paragraph('What\'s Included', s['label']),
    ]
    rows = [header]

    for name, price, desc, key in plans:
        is_selected = (key == plan_tier)
        name_style  = ParagraphStyle('pn', parent=s['body'],
                                     fontName='Montserrat-Bold' if is_selected else 'Montserrat-Regular',
                                     textColor=NAVY if is_selected else NEAR_BLACK)
        price_style = ParagraphStyle('pp', parent=s['body'],
                                     fontName='Montserrat-Bold',
                                     textColor=GOLD if is_selected else SILVER)
        rows.append([
            Paragraph(('★ ' if is_selected else '') + name, name_style),
            Paragraph(price, price_style),
            Paragraph(desc,  s['body']),
        ])

    col_widths = [1.2 * inch, 1.4 * inch, CONTENT_W - 2.6 * inch]
    t = Table(rows, colWidths=col_widths)

    style_cmds = [
        ('BACKGROUND',   (0, 0), (-1, 0),  NAVY),
        ('TEXTCOLOR',    (0, 0), (-1, 0),  white),
        ('FONTNAME',     (0, 0), (-1, 0),  'Montserrat-SemiBold'),
        ('FONTSIZE',     (0, 0), (-1, 0),  9),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, OFF_WHITE]),
        ('GRID',         (0, 0), (-1, -1), 0.5, SILVER),
        ('VALIGN',       (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING',   (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 8),
        ('LEFTPADDING',  (0, 0), (-1, -1), 10),
    ]

    # Highlight the selected plan row
    selected_idx = next((i + 1 for i, (_, _, _, k) in enumerate(plans) if k == plan_tier), None)
    if selected_idx:
        style_cmds.append(('BACKGROUND', (0, selected_idx), (-1, selected_idx), LIGHT_BLUE))
        style_cmds.append(('LINEABOVE',  (0, selected_idx), (-1, selected_idx), 1.5, GOLD))
        style_cmds.append(('LINEBELOW',  (0, selected_idx), (-1, selected_idx), 1.5, GOLD))

    t.setStyle(TableStyle(style_cmds))
    return t


def signature_block(s):
    """
    Signature area for client acceptance at the bottom of the final page.
    Two columns: Client and McKeever Consulting.
    """
    line = '_' * 38

    left = [
        Paragraph('Client Acceptance', s['h3']),
        Spacer(1, 32),
        Paragraph(line, s['signature_label']),
        Paragraph('Signature', s['signature_label']),
        Spacer(1, 16),
        Paragraph(line, s['signature_label']),
        Paragraph('Printed Name', s['signature_label']),
        Spacer(1, 16),
        Paragraph(line, s['signature_label']),
        Paragraph('Date', s['signature_label']),
    ]

    right = [
        Paragraph('McKeever Consulting', s['h3']),
        Spacer(1, 32),
        Paragraph(line, s['signature_label']),
        Paragraph('Signature', s['signature_label']),
        Spacer(1, 16),
        Paragraph('Brendon McKeever', s['signature_name']),
        Paragraph('Principal Consultant', s['signature_label']),
        Spacer(1, 16),
        Paragraph(line, s['signature_label']),
        Paragraph('Date', s['signature_label']),
    ]

    col_w = (CONTENT_W - 0.4 * inch) / 2
    t = Table([[left, right]], colWidths=[col_w, col_w])
    t.setStyle(TableStyle([
        ('VALIGN',       (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING',  (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING',   (0, 0), (-1, -1), 0),
    ]))
    return t


# ---------------------------------------------------------------------------
# Cover page — drawn directly on the canvas (not Platypus)
# ---------------------------------------------------------------------------

def draw_cover(canvas, data, fonts_ok):
    """
    Renders the full-navy cover page directly on the canvas.
    Called once before the Platypus doc is built.
    """
    canvas.saveState()

    # Full navy background
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # Gold accent bar at top
    canvas.setFillColor(GOLD)
    canvas.rect(0, PAGE_H - 6, PAGE_W, 6, fill=1, stroke=0)

    # Report label (small caps above title)
    canvas.setFillColor(GOLD)
    canvas.setFont('Montserrat-Medium' if fonts_ok else 'Helvetica', 10)
    canvas.drawCentredString(PAGE_W / 2, PAGE_H - 1.5 * inch, 'S E R V I C E   P R O P O S A L')

    # Horizontal rule below label
    canvas.setStrokeColor(GOLD)
    canvas.setLineWidth(1)
    canvas.line(1.5 * inch, PAGE_H - 1.7 * inch, PAGE_W - 1.5 * inch, PAGE_H - 1.7 * inch)

    # Title
    canvas.setFillColor(white)
    canvas.setFont('Montserrat-ExtraBold' if fonts_ok else 'Helvetica-Bold', 26)
    canvas.drawCentredString(PAGE_W / 2, PAGE_H - 2.6 * inch, 'Business Viability')
    canvas.drawCentredString(PAGE_W / 2, PAGE_H - 3.0 * inch, 'Intelligence Report')

    # Subtitle — client name
    canvas.setFillColor(SILVER)
    canvas.setFont('Montserrat-Regular' if fonts_ok else 'Helvetica', 13)
    canvas.drawCentredString(PAGE_W / 2, PAGE_H - 3.6 * inch, f"Prepared for {data['client_name']}")

    # Proposition title
    canvas.setFillColor(GOLD)
    canvas.setFont('Montserrat-SemiBold' if fonts_ok else 'Helvetica-Bold', 12)
    # Wrap long proposition titles at ~50 chars per line
    prop_title = data.get('proposition_title', '')
    if len(prop_title) > 50:
        mid = prop_title[:50].rfind(' ')
        canvas.drawCentredString(PAGE_W / 2, PAGE_H - 4.1 * inch, prop_title[:mid])
        canvas.drawCentredString(PAGE_W / 2, PAGE_H - 4.35 * inch, prop_title[mid + 1:])
    else:
        canvas.drawCentredString(PAGE_W / 2, PAGE_H - 4.1 * inch, prop_title)

    # Date
    canvas.setFillColor(SILVER)
    canvas.setFont('Montserrat-Regular' if fonts_ok else 'Helvetica', 10)
    canvas.drawCentredString(PAGE_W / 2, PAGE_H - 4.9 * inch, data.get('proposal_date', ''))

    # Gold rule above wordmark
    canvas.setStrokeColor(GOLD)
    canvas.setLineWidth(0.8)
    canvas.line(1.5 * inch, 1.4 * inch, PAGE_W - 1.5 * inch, 1.4 * inch)

    # Wordmark at bottom
    canvas.setFillColor(white)
    canvas.setFont('Montserrat-ExtraBold' if fonts_ok else 'Helvetica-Bold', 14)
    canvas.drawCentredString(PAGE_W / 2, 0.95 * inch, 'McKeever')
    canvas.setFillColor(GOLD)
    canvas.setFont('Montserrat-Medium' if fonts_ok else 'Helvetica', 9)
    canvas.drawCentredString(PAGE_W / 2, 0.72 * inch, 'C O N S U L T I N G')

    canvas.restoreState()
    canvas.showPage()


# ---------------------------------------------------------------------------
# Main document builder
# ---------------------------------------------------------------------------

def build_proposal(data, output_path, fonts_ok):
    """
    Assembles the full proposal PDF using ReportLab Platypus.
    Starts with a manually drawn cover page, then flows interior content.
    """
    s = styles(fonts_ok)

    # ── Document setup ────────────────────────────────────────────────────
    doc = BaseDocTemplate(
        output_path,
        pagesize=letter,
        leftMargin=MARGIN_OUTER,
        rightMargin=MARGIN_INNER,
        topMargin=0.9 * inch,   # space below the 30pt header bar
        bottomMargin=0.7 * inch,
    )

    # Single frame for interior pages
    interior_frame = Frame(
        MARGIN_OUTER, 0.7 * inch,
        CONTENT_W, PAGE_H - 1.6 * inch,
        id='interior'
    )
    doc.addPageTemplates([
        PageTemplate(id='interior', frames=[interior_frame], onPage=draw_interior_page)
    ])

    # ── Build the cover page on a fresh canvas before Platypus takes over
    from reportlab.pdfgen import canvas as pdfgen_canvas
    import io

    # We can't easily inject a raw canvas page into Platypus, so we use an
    # onFirstPage hook to draw the cover then showPage immediately.
    story = []

    # ── Section 1: Introduction ───────────────────────────────────────────
    story.append(Paragraph('Thank You for Your Interest', s['h2']))
    story.append(section_rule(s))
    story.append(Paragraph(
        f"Dear {data['client_name']},", s['body']
    ))
    story.append(Paragraph(
        'Thank you for reaching out to McKeever Consulting. We specialise in delivering '
        'in-depth business viability intelligence — combining live market research, '
        'competitive analysis, regulatory review, and financial modelling into a single '
        'comprehensive report. This proposal outlines the scope of work, deliverables, '
        'and investment for your project.',
        s['body']
    ))

    # ── Section 2: Your Project ───────────────────────────────────────────
    story.append(Paragraph('Your Project', s['h2']))
    story.append(section_rule(s))
    story.append(detail_table([
        ('Client',       data['client_name']),
        ('Email',        data['client_email']),
        ('Phone',        data.get('client_phone') or '—'),
        ('Company',      data.get('client_company') or '—'),
        ('Proposition',  data['proposition_title']),
        ('Type',         data.get('proposition_type', '').replace('_', ' ').title()),
        ('Origin',       data.get('origin_country') or '—'),
        ('Target Market', data['target_country'] + (f" — {data['target_demographic']}" if data.get('target_demographic') else '')),
    ], s))
    story.append(Spacer(1, 12))
    story.append(callout_box('Scope of Research', data['proposition_description'], s))

    # ── Section 3: What We Deliver ────────────────────────────────────────
    story.append(Paragraph('What We Deliver', s['h2']))
    story.append(section_rule(s))
    story.append(Paragraph(
        'Every McKeever Consulting report covers the following areas:', s['body']
    ))

    deliverables = [
        'Market Overview — size, growth trends, consumer demand',
        'Competitor Analysis — who is in the space and how you stack up',
        'Regulatory Landscape — permits, compliance requirements, import/export rules',
        'Production & Equipment — sourcing, manufacturing, logistics',
        'Packaging — materials, labelling, compliance',
        'Distribution Strategy — channels, partners, route to market',
        'Marketing & Influencers — brand positioning, audience, digital strategy',
        'Financial Projections — startup costs, revenue model, break-even analysis',
        'Risk Assessment — key threats and mitigation strategies',
        'Recommendations — prioritised action plan',
        'Viability Score — weighted 1–5 score across 6 key factors',
    ]

    for item in deliverables:
        story.append(Paragraph(f'• {item}', s['body']))

    if data.get('plan_tier') in ('pro', 'retainer'):
        story.append(Spacer(1, 8))
        story.append(callout_box(
            'Ongoing Monitoring',
            'Your plan includes monthly report refreshes. Each update highlights what has '
            'changed since the previous run — new competitors, regulatory shifts, market '
            'movements — so you always have a current picture of your opportunity.',
            s
        ))

    # ── Section 4: Investment ─────────────────────────────────────────────
    story.append(Paragraph('Investment', s['h2']))
    story.append(section_rule(s))
    story.append(pricing_table(data.get('plan_tier', 'starter'), s))
    story.append(Spacer(1, 10))

    plan_labels = {
        'starter':  'Starter — $100',
        'pro':      'Pro — $250',
        'retainer': 'Retainer — $150/month',
    }
    story.append(Paragraph(
        f"Your selected plan: <b>{plan_labels.get(data.get('plan_tier'), '—')}</b>",
        s['body']
    ))

    # ── Section 5: Terms ──────────────────────────────────────────────────
    story.append(Paragraph('Terms', s['h2']))
    story.append(section_rule(s))

    terms = {
        'starter': (
            'This is a one-time engagement. Payment is due prior to the report commencing. '
            'The completed report will be delivered by email as a branded PDF within 24–48 hours '
            'of payment confirmation.'
        ),
        'pro': (
            'This engagement covers one initial report plus one monthly refresh. '
            'Payment for the full $250 is due prior to the first report commencing. '
            'The monthly refresh will be delivered approximately 30 days after the initial report. '
            'No automatic renewal — you may upgrade to a Retainer plan at any time.'
        ),
        'retainer': (
            'This is an ongoing monthly engagement billed at $150/month. '
            'The first payment is due prior to the initial report commencing. '
            'Subsequent payments are due on the same day each month. '
            'You may cancel at any time with 7 days notice before your next billing date. '
            'Reports are delivered on the same day each month.'
        ),
    }

    story.append(Paragraph(terms.get(data.get('plan_tier'), ''), s['body']))
    story.append(Spacer(1, 8))
    story.append(callout_box(
        'Confidentiality',
        'All research, findings, and deliverables produced under this agreement are '
        'strictly confidential and prepared exclusively for your use. McKeever Consulting '
        'will not share or publish your project details without your written consent.',
        s
    ))

    # ── Section 6: Next Steps ─────────────────────────────────────────────
    story.append(Paragraph('Next Steps', s['h2']))
    story.append(section_rule(s))
    story.append(Paragraph(
        'To accept this proposal and begin your engagement:', s['body']
    ))
    for step in [
        'Review this proposal and confirm your plan selection.',
        'Sign the acceptance block below (digital signature accepted).',
        'Return a signed copy to brennon.mckeever@gmail.com.',
        'Complete payment — payment instructions will be provided by email.',
        'Your first report will begin within 24 hours of payment confirmation.',
    ]:
        story.append(Paragraph(f'  {step}', s['body']))

    story.append(Spacer(1, 24))

    # ── Signature block ───────────────────────────────────────────────────
    story.append(HRFlowable(width='100%', thickness=0.5, color=SILVER, spaceAfter=16))
    story.append(signature_block(s))
    story.append(Spacer(1, 16))
    story.append(Paragraph(
        f'Proposal date: {data.get("proposal_date", "")}  |  '
        f'Proposition ID: {data.get("proposition_id", "")}',
        s['small']
    ))

    # ── Build PDF ─────────────────────────────────────────────────────────
    # We draw the cover manually, then hand off to Platypus for interior pages.
    # ReportLab doesn't support mixed templates easily, so we build the cover
    # on the canvas in onFirstPage and push the story to subsequent pages.

    # Custom onFirstPage: draw cover, then let Platypus continue on page 2
    def on_first_page(canvas, doc):
        draw_cover(canvas, data, fonts_ok)
        # After showPage() in draw_cover, Platypus will draw the interior template
        # on the next page automatically. We still need to draw the interior header
        # on page 2 (which is actually the first Platypus page).
        draw_interior_page(canvas, doc)

    # Replace the page template's onPage for the first page
    doc.pageTemplates[0].onPage = draw_interior_page
    doc.pageTemplates[0].onPageEnd = None

    # Build with a custom first-page handler injected via beforePage
    # Simplest approach: prepend a PageBreak-equivalent by building cover separately
    # then appending the story. We use multiBuild for the cover pass.

    doc.build(
        story,
        onFirstPage=on_first_page,
        onLaterPages=draw_interior_page,
    )

    print(f'Proposal PDF written to: {output_path}')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Generate McKeever Consulting proposal PDF')
    parser.add_argument('--data',   required=True, help='Path to proposal data JSON file')
    parser.add_argument('--output', required=True, help='Output PDF path')
    args = parser.parse_args()

    # Load proposal data
    data_path = Path(args.data)
    if not data_path.exists():
        print(f'Error: data file not found: {data_path}', file=sys.stderr)
        sys.exit(1)

    with open(data_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Ensure output directory exists
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)

    # Download fonts if needed and register them
    fonts_ok = ensure_fonts()

    # Build the PDF
    build_proposal(data, args.output, fonts_ok)


if __name__ == '__main__':
    main()
