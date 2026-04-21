"""
tools/generate_report_pdf.py

Builds the final branded PDF for the Business Viability Intelligence System.
Reads a structured JSON content file written by the assembler agent and renders
it into a multi-page McKeever Consulting report using ReportLab Platypus.

── Content JSON schema (written by assembler to .tmp/<report_id>_content.json) ──

{
  "meta": {
    "proposition_title": "Camel Milk Export — US Market",
    "proposition_slug":  "camel-milk-export-us",
    "client_name":       "Brendon McKeever",
    "report_date":       "April 2026",
    "run_number":        1
  },
  "viability_score": {
    "overall": 3.2,
    "verdict": "Moderate",
    "factors": [
      {
        "name":     "market_demand",
        "label":    "Market Demand",
        "score":    3.5,
        "weight":   0.25,
        "rationale": "One-sentence plain-English rationale."
      }
      // ... 5 more factors: regulatory, competitive, financial, supply_chain, risk
    ]
  },
  "sections": [
    {
      "id":     "executive_summary",
      "title":  "Executive Summary",
      "number": 3,
      "blocks": [
        { "type": "paragraph",   "text": "..." },
        { "type": "bullets",     "label": "Top Risks",          "items": ["...", "..."] },
        { "type": "bullets",     "label": "Top Opportunities",  "items": ["...", "..."] },
        { "type": "key_figures", "items": [{"label": "...", "value": "..."}] },
        { "type": "table",       "headers": ["Col1","Col2"], "rows": [["a","b"]] },
        { "type": "callout",     "label": "Key Finding", "text": "..." }
      ]
    }
    // ... sections 4–13 (14 on run 2+): market_overview, competitors,
    //     regulatory, production, packaging, distribution, marketing,
    //     financials, risk_assessment, recommendations, what_changed
  ],
  "sources": [
    { "url": "...", "title": "...", "agent_name": "...", "retrieved_at": "..." }
  ],
  "what_changed": null   // null on run 1; list of strings on run 2+
}

── Block types ──────────────────────────────────────────────────────────────────
  paragraph   — body text (single string)
  bullets     — bulleted list with optional "label" heading
  table       — data table with "headers" (list) and "rows" (list of lists)
  callout     — highlighted box; "label" (bold) + "text" (body)
  key_figures — stat strip; "items" list of {"label", "value"} pairs

Usage:
    python tools/generate_report_pdf.py \\
        --report-id <uuid> \\
        --content   .tmp/<report_id>_content.json \\
        --output    outputs/<slug>_<YYYY-MM>.pdf
"""

import argparse
import json
import os
import sys
from pathlib import Path

import httpx
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# ── Brand constants ────────────────────────────────────────────────────────────

NAVY          = HexColor('#1C3557')   # primary — cover bg, headers, headings
GOLD          = HexColor('#C8A94A')   # accent  — badges, table headers, dividers
SILVER        = HexColor('#8A9BB0')   # secondary — footer, subheadings
DARK          = HexColor('#1E1E2E')   # body copy
OFFWHITE      = HexColor('#F7F8FA')   # alternating table rows
LIGHT_BG      = HexColor('#EEF2F7')   # callout box background
NAVY_SUBTLE   = HexColor('#2D4A6A')   # cover page divider (barely visible on navy)
MUTED_BLUE    = HexColor('#4A6080')   # cover confidential label
WHITE         = white

PAGE_W, PAGE_H = letter              # 612 × 792 points

# Interior page geometry
MARGIN_L   = 0.60 * inch
MARGIN_R   = 0.60 * inch
HEADER_H   = 30                      # points — navy bar at top
FOOTER_H   = 0.50 * inch
TOP_PAD    = 0.20 * inch             # gap between header bar and content
BOT_PAD    = 0.15 * inch             # gap between content and footer rule

FRAME_X = MARGIN_L
FRAME_Y = FOOTER_H + BOT_PAD
FRAME_W = PAGE_W - MARGIN_L - MARGIN_R
FRAME_H = PAGE_H - HEADER_H - TOP_PAD - FOOTER_H - BOT_PAD - MARGIN_L

# ── Font setup ─────────────────────────────────────────────────────────────────

FONTS_DIR = Path('assets/fonts')

FONT_FILES = {
    'Montserrat-Regular':
        'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Regular.ttf',
    'Montserrat-Medium':
        'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Medium.ttf',
    'Montserrat-SemiBold':
        'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-SemiBold.ttf',
    'Montserrat-Bold':
        'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Bold.ttf',
    'Montserrat-ExtraBold':
        'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-ExtraBold.ttf',
}


def download_fonts():
    """Download Montserrat TTF files from GitHub if not already present locally."""
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in FONT_FILES.items():
        path = FONTS_DIR / f'{name}.ttf'
        if path.exists():
            continue
        print(f'[pdf] Downloading font: {name}', file=sys.stderr)
        resp = httpx.get(url, follow_redirects=True, timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(f'Font download failed ({name}): HTTP {resp.status_code}')
        path.write_bytes(resp.content)


def register_fonts():
    """Register all Montserrat weights with ReportLab's pdfmetrics registry."""
    for name in FONT_FILES:
        path = FONTS_DIR / f'{name}.ttf'
        pdfmetrics.registerFont(TTFont(name, str(path)))


# ── Paragraph style sheet ──────────────────────────────────────────────────────

def build_styles() -> dict:
    """
    Build and return a dict of named ParagraphStyles using Montserrat.
    All text rendered via Platypus Paragraph flowables uses these styles.
    """
    base = dict(
        fontName='Montserrat-Regular',
        fontSize=10,
        leading=16,
        textColor=DARK,
        spaceAfter=6,
    )

    styles = {}

    # Body copy — standard paragraph
    styles['body'] = ParagraphStyle('body', **base)

    # Body with more breathing room — used after headings
    styles['body_first'] = ParagraphStyle('body_first', **base, spaceBefore=4)

    # Bullet item — indented, with bullet character
    styles['bullet'] = ParagraphStyle(
        'bullet',
        fontName='Montserrat-Regular', fontSize=10, leading=15,
        textColor=DARK, leftIndent=16, bulletIndent=4,
        spaceAfter=4,
    )

    # Bullet group label (e.g. "Top Risks") — bold, small, navy
    styles['bullet_label'] = ParagraphStyle(
        'bullet_label',
        fontName='Montserrat-SemiBold', fontSize=9, leading=13,
        textColor=NAVY, spaceBefore=10, spaceAfter=4,
    )

    # Section number label — small gold, above heading (e.g. "SECTION 5")
    styles['section_label'] = ParagraphStyle(
        'section_label',
        fontName='Montserrat-SemiBold', fontSize=8, leading=12,
        textColor=GOLD, spaceBefore=0, spaceAfter=2,
    )

    # Section heading — large navy bold
    styles['section_heading'] = ParagraphStyle(
        'section_heading',
        fontName='Montserrat-Bold', fontSize=20, leading=24,
        textColor=NAVY, spaceBefore=0, spaceAfter=10,
    )

    # Sub-heading within a section
    styles['subheading'] = ParagraphStyle(
        'subheading',
        fontName='Montserrat-SemiBold', fontSize=12, leading=16,
        textColor=NAVY, spaceBefore=14, spaceAfter=6,
    )

    # Table cell — regular weight
    styles['table_body'] = ParagraphStyle(
        'table_body',
        fontName='Montserrat-Regular', fontSize=9, leading=13,
        textColor=DARK,
    )

    # Table header cell — bold
    styles['table_header'] = ParagraphStyle(
        'table_header',
        fontName='Montserrat-Bold', fontSize=9, leading=13,
        textColor=NAVY,
    )

    # Key figure label — small, silver
    styles['kf_label'] = ParagraphStyle(
        'kf_label',
        fontName='Montserrat-Medium', fontSize=7.5, leading=11,
        textColor=SILVER,
    )

    # Key figure value — large, navy bold
    styles['kf_value'] = ParagraphStyle(
        'kf_value',
        fontName='Montserrat-Bold', fontSize=14, leading=18,
        textColor=NAVY,
    )

    # TOC entry
    styles['toc_entry'] = ParagraphStyle(
        'toc_entry',
        fontName='Montserrat-Regular', fontSize=10, leading=18,
        textColor=DARK,
    )

    # TOC section number
    styles['toc_number'] = ParagraphStyle(
        'toc_number',
        fontName='Montserrat-Bold', fontSize=10, leading=18,
        textColor=NAVY,
    )

    # Source URL — small, silver, can wrap
    styles['source_url'] = ParagraphStyle(
        'source_url',
        fontName='Montserrat-Regular', fontSize=8, leading=12,
        textColor=SILVER, spaceAfter=2,
    )

    # Source title — small dark
    styles['source_title'] = ParagraphStyle(
        'source_title',
        fontName='Montserrat-Medium', fontSize=8.5, leading=13,
        textColor=DARK, spaceAfter=1,
    )

    # Source agent group heading
    styles['source_group'] = ParagraphStyle(
        'source_group',
        fontName='Montserrat-SemiBold', fontSize=9, leading=14,
        textColor=NAVY, spaceBefore=12, spaceAfter=4,
    )

    # What Changed item
    styles['changed'] = ParagraphStyle(
        'changed',
        fontName='Montserrat-Regular', fontSize=10, leading=15,
        textColor=DARK, leftIndent=16, bulletIndent=4, spaceAfter=5,
    )

    return styles


# ── Canvas helpers (drawn on every page via PageTemplate onPage) ───────────────

def draw_wordmark(cv, x, y, primary_color=WHITE, accent_color=GOLD, size=30):
    """
    Draw the McKeever Consulting wordmark at canvas position (x, y).
    'McKeever' in ExtraBold at `size`; 'C O N S U L T I N G' below in Medium;
    gold rule underneath. x/y is the baseline of the 'McKeever' line.
    """
    cv.setFont('Montserrat-ExtraBold', size)
    cv.setFillColor(primary_color)
    cv.drawString(x, y, 'McKeever')
    mck_w = cv.stringWidth('McKeever', 'Montserrat-ExtraBold', size)

    sub_size = round(size * 0.38)
    sub_y    = y - (size * 0.56)
    sub_text = 'C O N S U L T I N G'
    cv.setFont('Montserrat-Medium', sub_size)
    cv.setFillColor(accent_color)
    cv.drawString(x, sub_y, sub_text)
    sub_w = cv.stringWidth(sub_text, 'Montserrat-Medium', sub_size)

    # Gold rule beneath "CONSULTING"
    rule_w = max(mck_w, sub_w)
    cv.setStrokeColor(accent_color)
    cv.setLineWidth(1.2)
    cv.line(x, sub_y - 5, x + rule_w, sub_y - 5)


def draw_cover_page(cv, meta: dict, score: dict):
    """
    Draw the full cover page onto the canvas.
    All content is drawn here — the Platypus frame on the cover page is empty.
    """
    # Full navy background
    cv.setFillColor(NAVY)
    cv.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # ── Report type label ──────────────────────────────────────────────────────
    label_y = PAGE_H - 1.1 * inch
    cv.setFont('Montserrat-Medium', 8.5)
    cv.setFillColor(GOLD)
    cv.drawCentredString(PAGE_W / 2, label_y, 'B U S I N E S S   V I A B I L I T Y   R E P O R T')
    cv.setStrokeColor(GOLD)
    cv.setLineWidth(0.8)
    cv.line(1.4 * inch, label_y - 8, PAGE_W - 1.4 * inch, label_y - 8)

    # ── Proposition title ──────────────────────────────────────────────────────
    # Wrap long titles onto multiple lines so text never clips at page edges.
    title_y    = PAGE_H - 2.7 * inch
    title_font = 'Montserrat-ExtraBold'
    title_size = 30
    max_title_w = PAGE_W - 2.0 * inch   # 1 inch margin each side

    cv.setFont(title_font, title_size)
    cv.setFillColor(WHITE)

    raw_title = meta['proposition_title']
    if cv.stringWidth(raw_title, title_font, title_size) <= max_title_w:
        cv.drawCentredString(PAGE_W / 2, title_y, raw_title)
    else:
        # Split at word boundaries to fill lines up to max_title_w
        words = raw_title.split(' ')
        lines, current = [], ''
        for word in words:
            test = (current + ' ' + word).strip()
            if cv.stringWidth(test, title_font, title_size) <= max_title_w:
                current = test
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)

        line_h  = title_size * 1.25
        start_y = title_y + ((len(lines) - 1) * line_h) / 2
        for i, line in enumerate(lines):
            cv.drawCentredString(PAGE_W / 2, start_y - i * line_h, line)

    cv.setFont('Montserrat-Bold', 14)
    cv.setFillColor(SILVER)
    cv.drawCentredString(PAGE_W / 2, title_y - 38, meta.get('proposition_subtitle', ''))

    # ── Viability score badge ──────────────────────────────────────────────────
    # Verdict and score are split across two lines so neither is clipped.
    # Badge is wider (240pt) to give the verdict label breathing room.
    verdict  = score['verdict'].upper()
    overall  = score['overall']
    badge_w, badge_h = 240, 82
    badge_x  = (PAGE_W - badge_w) / 2
    badge_y  = PAGE_H - 4.75 * inch

    cv.setFillColor(GOLD)
    cv.roundRect(badge_x, badge_y, badge_w, badge_h, radius=8, fill=1, stroke=0)

    # "VIABILITY VERDICT" label at top of badge
    cv.setFont('Montserrat-Bold', 10)
    cv.setFillColor(NAVY)
    cv.drawCentredString(PAGE_W / 2, badge_y + badge_h - 22, 'VIABILITY VERDICT')

    # Thin divider below label
    cv.setStrokeColor(NAVY)
    cv.setLineWidth(0.4)
    cv.line(badge_x + 20, badge_y + badge_h - 28, badge_x + badge_w - 20, badge_y + badge_h - 28)

    # Verdict word on its own line (e.g. "MODERATE") — large ExtraBold
    cv.setFont('Montserrat-ExtraBold', 20)
    cv.setFillColor(NAVY)
    cv.drawCentredString(PAGE_W / 2, badge_y + 34, verdict)

    # Score on the line below (e.g. "3.2 / 5.0") — smaller SemiBold
    cv.setFont('Montserrat-SemiBold', 13)
    cv.drawCentredString(PAGE_W / 2, badge_y + 16, f'{overall} / 5.0')

    # ── Report date ────────────────────────────────────────────────────────────
    cv.setFont('Montserrat-Regular', 10)
    cv.setFillColor(SILVER)
    cv.drawCentredString(PAGE_W / 2, PAGE_H - 5.9 * inch, meta['report_date'])

    # ── Divider above wordmark ────────────────────────────────────────────────
    cv.setStrokeColor(NAVY_SUBTLE)
    cv.setLineWidth(0.5)
    cv.line(1.4 * inch, 2.4 * inch, PAGE_W - 1.4 * inch, 2.4 * inch)

    # ── McKeever Consulting wordmark (centred) ─────────────────────────────────
    wm_size = 32
    mck_w   = cv.stringWidth('McKeever', 'Montserrat-ExtraBold', wm_size)
    wm_x    = (PAGE_W - mck_w) / 2
    draw_wordmark(cv, wm_x, 2.0 * inch, primary_color=WHITE, accent_color=GOLD, size=wm_size)

    # ── Confidential label ─────────────────────────────────────────────────────
    cv.setFont('Montserrat-Regular', 7)
    cv.setFillColor(MUTED_BLUE)
    cv.drawCentredString(
        PAGE_W / 2, 0.4 * inch,
        f'CONFIDENTIAL — Prepared exclusively for {meta["client_name"]}'
    )


def draw_interior_chrome(cv, page_num: int):
    """
    Draw the header bar and footer on every interior page.
    Called by the 'report' PageTemplate's onPage hook.
    """
    # ── Header bar ─────────────────────────────────────────────────────────────
    bar_y = PAGE_H - HEADER_H
    cv.setFillColor(NAVY)
    cv.rect(0, bar_y, PAGE_W, HEADER_H, fill=1, stroke=0)

    # Compact wordmark — two stacked lines in the bar
    cv.setFont('Montserrat-Bold', 11)
    cv.setFillColor(WHITE)
    cv.drawString(0.4 * inch, bar_y + 10, 'McKeever')
    cv.setFont('Montserrat-Medium', 6.5)
    cv.setFillColor(GOLD)
    cv.drawString(0.4 * inch, bar_y + 2.5, 'C O N S U L T I N G')

    # Page number — right-aligned in the bar
    cv.setFont('Montserrat-Regular', 9)
    cv.setFillColor(WHITE)
    cv.drawRightString(PAGE_W - 0.4 * inch, bar_y + 10, f'Page {page_num}')

    # ── Footer ─────────────────────────────────────────────────────────────────
    footer_y = 0.38 * inch
    cv.setStrokeColor(SILVER)
    cv.setLineWidth(0.4)
    cv.line(0.5 * inch, footer_y + 9, PAGE_W - 0.5 * inch, footer_y + 9)
    cv.setFont('Montserrat-Regular', 7)
    cv.setFillColor(SILVER)
    cv.drawString(0.5 * inch, footer_y, 'Confidential — Prepared by McKeever Consulting')
    cv.drawRightString(PAGE_W - 0.5 * inch, footer_y, 'mckeeverconsulting.com')


# ── Document class ─────────────────────────────────────────────────────────────

class ReportDocument(BaseDocTemplate):
    """
    Custom BaseDocTemplate that carries report metadata so the cover page
    onPage callback can access proposition title, client name, and score.
    """

    def __init__(self, output_path: str, meta: dict, score: dict, **kwargs):
        # Store report data before calling parent __init__ (which triggers build setup)
        self.report_meta  = meta
        self.report_score = score
        BaseDocTemplate.__init__(self, output_path, **kwargs)

    def build_page_templates(self):
        """
        Create two PageTemplates:
          'cover'  — full-page cover, all content drawn via onPage callback
          'report' — interior pages with branded header + footer
        """
        # Cover: full page frame (empty — content drawn in callback)
        cover_frame = Frame(0, 0, PAGE_W, PAGE_H,
                            leftPadding=0, rightPadding=0,
                            topPadding=0, bottomPadding=0,
                            id='cover_frame')

        # Interior: content frame within header + footer
        interior_frame = Frame(
            FRAME_X, FRAME_Y, FRAME_W, FRAME_H,
            leftPadding=0, rightPadding=0,
            topPadding=0, bottomPadding=0,
            id='interior_frame',
        )

        # onPage callbacks — use default args to capture current self values
        def on_cover(cv, doc, meta=self.report_meta, score=self.report_score):
            draw_cover_page(cv, meta, score)

        def on_interior(cv, doc):
            draw_interior_chrome(cv, doc.page)

        cover_tmpl    = PageTemplate(id='cover',  frames=[cover_frame],    onPage=on_cover)
        interior_tmpl = PageTemplate(id='report', frames=[interior_frame], onPage=on_interior)

        self.addPageTemplates([cover_tmpl, interior_tmpl])


# ── Block renderers ────────────────────────────────────────────────────────────
# Each renderer accepts a block dict and styles dict, returns a list of Flowables.

def render_paragraph(block: dict, styles: dict) -> list:
    """Render a plain paragraph of body text."""
    return [Paragraph(block['text'], styles['body'])]


def render_bullets(block: dict, styles: dict) -> list:
    """
    Render a labelled bulleted list.
    'label' is optional. Each item in 'items' gets a bullet prefix.
    """
    out = []
    if block.get('label'):
        out.append(Paragraph(block['label'], styles['bullet_label']))
    for item in block.get('items', []):
        out.append(Paragraph(f'• {item}', styles['bullet']))
    return out


def estimate_col_widths(headers: list, rows: list, total_width: float) -> list:
    """
    Distribute column widths proportionally to the maximum content length found
    in each column (header + first 6 data rows).

    Why: Even distribution causes problems when columns have very different content —
    e.g. a short "Score" column getting the same space as a wide "Description" column.
    This heuristic narrows short columns and widens long ones, staying within
    a per-column min/max clamp so no column becomes unreadably narrow or wastefully wide.

    Per-column minimum: derived from the longest unbreakable word in the column.
    This prevents short-header columns (e.g. "Competitor") from being squeezed below
    the width needed to render that word on one line — the old fixed 0.6" minimum
    wasn't wide enough for 10-char words at typical table font sizes.
    """
    n = len(headers)
    if n == 0:
        return []

    # ~5.5pt per character in 9pt Helvetica + 8pt horizontal cell padding allowance
    AVG_CHAR_PT = 5.5
    CELL_PAD_PT = 8
    MAX_W       = 3.50 * inch

    weights  = []
    col_mins = []

    for i, h in enumerate(headers):
        all_cells = [str(h)]
        for row in rows[:6]:
            if i < len(row):
                all_cells.append(str(row[i]))

        lengths = [len(c) for c in all_cells]

        # Longest single word across all sampled cells — this token can never break,
        # so the column must be at least wide enough to render it on one line.
        longest_word = max((len(w) for text in all_cells for w in text.split()), default=1)
        col_min = max(0.60 * inch, longest_word * AVG_CHAR_PT + CELL_PAD_PT)

        weights.append(max(lengths))
        col_mins.append(col_min)

    total_weight = sum(weights) or 1
    raw_widths   = [total_width * w / total_weight for w in weights]

    # Guarantee-minimums-first: assign each column its minimum, distribute the
    # remainder proportionally.  Simple rescaling (scale = total / sum(clamped))
    # compresses ALL columns — including those already at minimum — back below
    # minimum when sum(clamped) > total_width.  This approach never violates mins.
    sum_mins = sum(col_mins)
    if sum_mins >= total_width:
        # Not enough space to guarantee minimums; scale minimums down uniformly.
        scale = total_width / sum_mins
        return [m * scale for m in col_mins]

    remainder = total_width - sum_mins
    result = []
    for i in range(n):
        extra = remainder * weights[i] / total_weight
        result.append(min(MAX_W, col_mins[i] + extra))

    # Final normalise: min(MAX_W, ...) clamping may leave total slightly off.
    total = sum(result)
    return [w * total_width / total for w in result]


def render_table(block: dict, styles: dict) -> list:
    """
    Render a branded data table.
    'headers' is a list of column header strings.
    'rows'    is a list of lists (same width as headers).
    Column widths default to a content-length heuristic (estimate_col_widths),
    or can be overridden per-block with a 'col_widths' list.
    """
    headers = block.get('headers', [])
    rows    = block.get('rows', [])
    n_cols  = len(headers)

    if not n_cols:
        return []

    # Content-aware column widths — proportional to max content length per column
    col_widths = block.get('col_widths') or estimate_col_widths(headers, rows, FRAME_W)

    # Wrap all cells as Paragraphs so long text wraps correctly
    def wrap(text, style):
        return Paragraph(str(text), style)

    table_data = [[wrap(h, styles['table_header']) for h in headers]]
    for row in rows:
        table_data.append([wrap(cell, styles['table_body']) for cell in row])

    # Alternate white / off-white for data rows
    row_style = []
    for i, _ in enumerate(rows):
        bg = WHITE if i % 2 == 0 else OFFWHITE
        row_style.append(('BACKGROUND', (0, i + 1), (-1, i + 1), bg))

    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        # Header row
        ('BACKGROUND',    (0, 0), (-1, 0),  GOLD),
        ('TEXTCOLOR',     (0, 0), (-1, 0),  NAVY),
        ('TOPPADDING',    (0, 0), (-1, 0),  7),
        ('BOTTOMPADDING', (0, 0), (-1, 0),  7),
        ('LINEBELOW',     (0, 0), (-1, 0),  1.5, NAVY),

        # Data rows
        ('FONTNAME',      (0, 1), (-1, -1), 'Montserrat-Regular'),
        ('FONTSIZE',      (0, 1), (-1, -1), 9),
        ('TOPPADDING',    (0, 1), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 6),

        # Grid
        ('GRID',          (0, 0), (-1, -1), 0.4, SILVER),
        ('ALIGN',         (0, 0), (-1, -1), 'LEFT'),
        ('LEFTPADDING',   (0, 0), (-1, -1), 8),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 8),

        *row_style,
    ]))

    return [t, Spacer(1, 8)]


def render_callout(block: dict, styles: dict) -> list:
    """
    Render a highlighted callout box with a navy left accent bar.
    Uses a single-cell Table as the container so it flows with the content.
    """
    label   = block.get('label', '')
    text    = block.get('text', '')
    content = f'<b>{label}</b><br/>{text}' if label else text
    inner   = Paragraph(content, styles['body'])

    # Outer container: light-blue-grey background + navy left bar via line below
    t = Table([[inner]], colWidths=[FRAME_W])
    t.setStyle(TableStyle([
        ('BACKGROUND',    (0, 0), (-1, -1), LIGHT_BG),
        ('LEFTPADDING',   (0, 0), (-1, -1), 14),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 12),
        ('TOPPADDING',    (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LINEBEFORE',    (0, 0), (0, -1),  4, NAVY),
        ('ROUNDEDCORNERS', [4]),
    ]))

    return [t, Spacer(1, 8)]


def render_key_figures(block: dict, styles: dict) -> list:
    """
    Render a horizontal strip of stat cards, max 4 per row.
    Each card shows a label (small, silver) above a value (large, navy bold).
    Items beyond 4 wrap onto a second row so cells are never too narrow to read.
    """
    items = block.get('items', [])
    if not items:
        return []

    # Cap columns at 4 so each cell is at least ~130pt wide (readable)
    MAX_PER_ROW = 4
    out = []

    # Chunk items into rows of MAX_PER_ROW
    for chunk_start in range(0, len(items), MAX_PER_ROW):
        chunk = items[chunk_start:chunk_start + MAX_PER_ROW]
        col_w = FRAME_W / len(chunk)

        row = []
        for item in chunk:
            # Use 11pt for value to keep long strings (e.g. "$100,000–$300,000") on one line
            cell_content = (
                f'<font name="Montserrat-Medium" size="7.5" color="#8A9BB0">{item.get("label","")}</font>'
                f'<br/>'
                f'<font name="Montserrat-Bold" size="11" color="#1C3557">{item.get("value","")}</font>'
            )
            row.append(Paragraph(cell_content, styles['body']))

        t = Table([row], colWidths=[col_w] * len(chunk))
        t.setStyle(TableStyle([
            ('BACKGROUND',    (0, 0), (-1, -1), OFFWHITE),
            ('TOPPADDING',    (0, 0), (-1, -1), 10),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
            ('LEFTPADDING',   (0, 0), (-1, -1), 10),
            ('RIGHTPADDING',  (0, 0), (-1, -1), 10),
            ('LINEABOVE',     (0, 0), (-1, 0),  1.5, GOLD),
            ('LINEBELOW',     (0, 0), (-1, -1), 0.4, SILVER),
            ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
            ('ALIGN',         (0, 0), (-1, -1), 'LEFT'),
        ]))

        out.extend([t, Spacer(1, 4)])

    out.append(Spacer(1, 6))
    return out


def render_block(block: dict, styles: dict) -> list:
    """
    Dispatcher: routes a block dict to the correct renderer based on 'type'.
    Unknown block types are skipped with a stderr warning.
    """
    t = block.get('type')
    if t == 'paragraph':
        return render_paragraph(block, styles)
    if t == 'bullets':
        return render_bullets(block, styles)
    if t == 'table':
        return render_table(block, styles)
    if t == 'callout':
        return render_callout(block, styles)
    if t == 'key_figures':
        return render_key_figures(block, styles)
    print(f'[pdf] Warning: unknown block type "{t}" — skipped', file=sys.stderr)
    return []


# ── Section renderers ──────────────────────────────────────────────────────────

def render_toc(sections: list, styles: dict) -> list:
    """
    Render the Table of Contents as a styled two-column table.
    Page numbers are omitted in v1 (Platypus two-pass build is future work).
    """
    out = []
    out.append(Paragraph('SECTION 2', styles['section_label']))
    out.append(Paragraph('Table of Contents', styles['section_heading']))

    # Gold underline under heading
    rule = Table([['']], colWidths=[2.4 * inch])
    rule.setStyle(TableStyle([
        ('LINEBELOW', (0, 0), (-1, -1), 2, GOLD),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    out.append(rule)
    out.append(Spacer(1, 14))

    # Build TOC rows — left column is a section symbol + number,
    # right column is the section title. We do NOT show page numbers here
    # because Platypus requires a two-pass build to resolve them accurately.
    toc_rows = []
    for s in sections:
        # Skip standalone sections rendered outside the main sections loop
        if s.get('id') in ('what_changed', 'sources'):
            continue
        num   = Paragraph(str(s.get("number", "")), styles['toc_number'])
        title = Paragraph(s['title'], styles['toc_entry'])
        toc_rows.append([num, title])

    # Append what_changed and sources as final TOC entries if they exist in sections
    for s in sections:
        if s.get('id') in ('what_changed', 'sources'):
            num   = Paragraph(str(s.get("number", "")), styles['toc_number'])
            title = Paragraph(s['title'], styles['toc_entry'])
            toc_rows.append([num, title])

    toc_table = Table(toc_rows, colWidths=[0.55 * inch, FRAME_W - 0.55 * inch])
    toc_table.setStyle(TableStyle([
        ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING',   (0, 0), (-1, -1), 0),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 0),
        ('TOPPADDING',    (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('LINEBELOW',     (0, 0), (-1, -1), 0.3, OFFWHITE),
    ]))
    out.append(toc_table)

    return out


def render_score_breakdown(score: dict, styles: dict) -> list:
    """
    Render the viability score factor breakdown table.
    Included in the Executive Summary section.
    Shows each factor's label, weighted score, weight, and rationale.
    """
    out = []
    out.append(Spacer(1, 10))
    out.append(Paragraph('Viability Score Breakdown', styles['subheading']))

    headers = ['Factor', 'Score', 'Weight', 'Rationale']
    # Factor: 1.3 inch (fits "Market Demand" at 9pt)
    # Score:  0.65 inch (fits "Score" header at 9pt bold without wrap)
    # Weight: 0.75 inch (fits "Weight" header at 9pt bold without wrap)
    # Rationale: remainder — still ~330pt, more than enough for long text.
    col_widths = [1.3 * inch, 0.65 * inch, 0.75 * inch, FRAME_W - 2.70 * inch]

    rows = []
    for f in score.get('factors', []):
        score_val = f'{f["score"]} / 5'
        weight_val = f'{int(f["weight"] * 100)}%'
        rows.append([f['label'], score_val, weight_val, f.get('rationale', '')])

    # Overall row at bottom
    rows.append(['Overall', f'{score["overall"]} / 5', '', score['verdict']])

    def wrap_header(h):
        return Paragraph(h, styles['table_header'])

    def wrap_cell(v, i):
        # Last row (overall) gets bold navy text
        if i == len(rows) - 1:
            return Paragraph(f'<b>{v}</b>', styles['table_body'])
        return Paragraph(str(v), styles['table_body'])

    table_data = [[wrap_header(h) for h in headers]]
    for i, row in enumerate(rows):
        table_data.append([wrap_cell(v, i) for v in row])

    # Alternate rows + highlight overall row
    row_styles = []
    for i in range(len(rows)):
        bg = WHITE if i % 2 == 0 else OFFWHITE
        row_styles.append(('BACKGROUND', (0, i + 1), (-1, i + 1), bg))
    # Overall row gets navy background, white text
    overall_idx = len(rows)
    row_styles.append(('BACKGROUND', (0, overall_idx), (-1, overall_idx), NAVY))
    row_styles.append(('TEXTCOLOR',  (0, overall_idx), (-1, overall_idx), WHITE))

    t = Table(table_data, colWidths=col_widths)
    t.setStyle(TableStyle([
        ('BACKGROUND',    (0, 0), (-1, 0),  GOLD),
        ('TEXTCOLOR',     (0, 0), (-1, 0),  NAVY),
        ('TOPPADDING',    (0, 0), (-1, 0),  7),
        ('BOTTOMPADDING', (0, 0), (-1, 0),  7),
        ('LINEBELOW',     (0, 0), (-1, 0),  1.5, NAVY),
        ('FONTNAME',      (0, 1), (-1, -1), 'Montserrat-Regular'),
        ('FONTSIZE',      (0, 1), (-1, -1), 9),
        ('TOPPADDING',    (0, 1), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 6),
        ('GRID',          (0, 0), (-1, -1), 0.4, SILVER),
        ('ALIGN',         (0, 0), (-1, -1), 'LEFT'),
        ('LEFTPADDING',   (0, 0), (-1, -1), 8),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 8),
        ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
        *row_styles,
    ]))

    out.append(t)
    out.append(Spacer(1, 10))
    return out


def render_section_heading(section: dict, styles: dict) -> list:
    """
    Render the section number label + heading + gold underline rule.
    Kept together with KeepTogether so heading never orphans at page bottom.
    """
    label   = Paragraph(f'SECTION {section.get("number", "")}', styles['section_label'])
    heading = Paragraph(section['title'], styles['section_heading'])

    # Gold underline — width approximated from heading text length
    heading_w = min(len(section['title']) * 11, FRAME_W * 0.6)
    rule = Table([['']], colWidths=[heading_w])
    rule.setStyle(TableStyle([
        ('LINEBELOW',     (0, 0), (-1, -1), 2, GOLD),
        ('TOPPADDING',    (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))

    return [KeepTogether([label, heading, rule, Spacer(1, 12)])]


def render_section(section: dict, styles: dict, score: dict = None) -> list:
    """
    Render a complete report section: heading + all content blocks.
    If this is the Executive Summary and a score is provided, the score
    breakdown table is inserted after the first paragraph block.
    """
    out = render_section_heading(section, styles)

    is_exec_summary  = section.get('id') == 'executive_summary'
    score_inserted   = False

    for block in section.get('blocks', []):
        out.extend(render_block(block, styles))

        # Insert score breakdown table after the first paragraph in exec summary
        if is_exec_summary and not score_inserted and block.get('type') == 'paragraph' and score:
            out.extend(render_score_breakdown(score, styles))
            score_inserted = True

    return out


def render_what_changed(changes: list, styles: dict) -> list:
    """
    Render the 'What Changed This Month' section.
    Only called on run 2+ when changes is a non-empty list.
    """
    fake_section = {
        'id': 'what_changed',
        'title': 'What Changed This Month',
        'number': 14,
    }
    out = render_section_heading(fake_section, styles)

    out.append(Paragraph(
        'The following changes were identified since the previous report:',
        styles['body_first'],
    ))
    out.append(Spacer(1, 6))

    for item in changes:
        out.append(Paragraph(f'• {item}', styles['changed']))

    return out


def render_sources(sources: list, styles: dict) -> list:
    """
    Render the Sources section, grouped by agent name.
    Each source shows its title + URL.
    """
    fake_section = {
        'id': 'sources',
        'title': 'Sources',
        'number': 15,
    }
    out = render_section_heading(fake_section, styles)

    # Group by agent_name
    groups: dict[str, list] = {}
    for s in sources:
        agent = s.get('agent_name', 'other')
        groups.setdefault(agent, []).append(s)

    # Human-readable agent name mapping
    agent_labels = {
        'research_market_overview': 'Market Overview',
        'research_competitors':     'Competitor Analysis',
        'research_regulatory':      'Regulatory Landscape',
        'research_production':      'Production & Equipment',
        'research_packaging':       'Packaging',
        'research_distribution':    'Distribution Strategy',
        'research_marketing':       'Marketing & Influencers',
        'research_financials':      'Financial Projections',
        'research_origin_ops':      'Origin Operations',
        'research_legal':           'Legal',
    }

    for agent, srcs in groups.items():
        label = agent_labels.get(agent, agent)
        out.append(Paragraph(label, styles['source_group']))
        for s in srcs:
            if s.get('title'):
                out.append(Paragraph(s['title'], styles['source_title']))
            out.append(Paragraph(s.get('url', ''), styles['source_url']))
            out.append(Spacer(1, 4))

    return out


# ── Admin formatting notes callout ─────────────────────────────────────────────

def render_admin_notes(notes: str, styles) -> list:
    """
    Render a visible amber callout containing the admin's formatting notes.
    Only appears in regen runs where formatting_notes was injected into the content JSON.
    Placed on page 2 before the TOC so it's immediately visible on review.
    """
    label = Paragraph('<b>Admin Review Notes</b>', styles['subheading'])
    body  = Paragraph(notes, styles['body'])

    inner = Table(
        [[label], [body]],
        colWidths=[PAGE_W - MARGIN_L - MARGIN_R],
    )
    inner.setStyle(TableStyle([
        ('BACKGROUND',  (0, 0), (-1, -1), HexColor('#FFF8E1')),
        ('LEFTPADDING',  (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING',   (0, 0), (0, 0),   10),
        ('BOTTOMPADDING',(0, -1),(-1, -1), 10),
        ('BOX',         (0, 0), (-1, -1), 1.5, HexColor('#C8A94A')),
        ('ROWBACKGROUNDS', (0, 0), (-1, -1), [HexColor('#FFF8E1')]),
    ]))

    return [inner, Spacer(1, 16)]


# ── PDF builder ────────────────────────────────────────────────────────────────

def build_pdf(content: dict, output_path: str):
    """
    Orchestrate the full PDF build from the parsed content dict.
    Creates the ReportDocument, builds the story (flowable list),
    and calls doc.build() to produce the PDF file.
    """
    meta   = content['meta']
    score  = content['viability_score']
    styles = build_styles()

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)

    # Instantiate our custom doc template
    doc = ReportDocument(
        output_path,
        meta=meta,
        score=score,
        pagesize=letter,
        leftMargin=0, rightMargin=0,
        topMargin=0,  bottomMargin=0,
    )
    doc.build_page_templates()

    # ── Build the story ────────────────────────────────────────────────────────
    story = []

    # Page 1 is the cover (drawn entirely by the cover PageTemplate callback).
    # Switch to interior template before the PageBreak so page 2 uses 'report'.
    story.append(NextPageTemplate('report'))
    story.append(PageBreak())

    # Admin formatting notes — only present when regenPdfFromStorage() injects them.
    # Shown at the top of page 2 so Brendon sees the review notes immediately on open.
    formatting_notes = content.get('formatting_notes')
    if formatting_notes:
        story.extend(render_admin_notes(formatting_notes, styles))

    # Page 2 — Table of Contents
    story.extend(render_toc(content['sections'], styles))
    story.append(PageBreak())

    # Pages 3+ — Content sections.
    # Skip 'what_changed' and 'sources' here — they are rendered via their own
    # dedicated calls below. The assembler may include them as regular sections,
    # which would cause duplicate pages without this filter.
    STANDALONE_IDS = {'what_changed', 'sources'}
    for section in content['sections']:
        if section.get('id') in STANDALONE_IDS:
            continue
        # Inject score breakdown into Executive Summary
        section_score = score if section.get('id') == 'executive_summary' else None
        story.extend(render_section(section, styles, score=section_score))
        story.append(PageBreak())

    # What Changed — only on run 2+.
    # No forced PageBreak after it — Sources flows directly below on the same page
    # (both are always short; forcing a break creates a mostly-empty Sources page).
    what_changed = content.get('what_changed')
    if what_changed:
        story.extend(render_what_changed(what_changed, styles))
        story.append(Spacer(1, 24))  # breathing room between the two tail sections

    # Sources — flows on the same page as What Changed (or starts fresh after last section)
    story.extend(render_sources(content.get('sources', []), styles))

    # Build the PDF
    doc.build(story)
    print(f'[pdf] Report saved → {output_path}', file=sys.stderr)


# ── CLI entry point ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Generate a McKeever Consulting viability report PDF')
    parser.add_argument('--report-id', required=True, help='Report UUID (used for logging)')
    parser.add_argument('--content',   required=True, help='Path to the assembler content JSON file')
    parser.add_argument('--output',    required=True, help='Output path for the generated PDF')
    args = parser.parse_args()

    # Load and validate content JSON
    content_path = Path(args.content)
    if not content_path.exists():
        print(f'[pdf] Error: content file not found: {content_path}', file=sys.stderr)
        sys.exit(1)

    with open(content_path, 'r', encoding='utf-8') as f:
        content = json.load(f)

    # Validate required top-level keys
    required = ['meta', 'viability_score', 'sections']
    missing  = [k for k in required if k not in content]
    if missing:
        print(f'[pdf] Error: content JSON missing required keys: {missing}', file=sys.stderr)
        sys.exit(1)

    # Ensure fonts are available
    print(f'[pdf] Preparing fonts …', file=sys.stderr)
    download_fonts()
    register_fonts()

    # Build
    print(f'[pdf] Building report {args.report_id} …', file=sys.stderr)
    build_pdf(content, args.output)
    print(args.output)   # stdout for orchestrator to capture the path


if __name__ == '__main__':
    main()
