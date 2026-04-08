"""
tools/preview_brand.py

Generates a 2-page brand preview PDF for McKeever Consulting.
  Page 1 — Cover page design
  Page 2 — Sample interior report page (Competitor Analysis)

Downloads Montserrat TTF fonts from GitHub on first run, then registers
them with ReportLab. Run this to review the visual identity before
building the full generate_report_pdf.py tool.

Usage:  python tools/preview_brand.py
Output: outputs/mckeever_brand_preview.pdf
"""

import os
import sys
from pathlib import Path

import httpx
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

# ── Brand constants ────────────────────────────────────────────────────────────

NAVY     = HexColor('#1C3557')   # primary — headers, cover bg, headings
GOLD     = HexColor('#C8A94A')   # accent — badges, dividers, table headers
SILVER   = HexColor('#8A9BB0')   # secondary — subheadings, footer text
DARK     = HexColor('#1E1E2E')   # body copy
OFFWHITE = HexColor('#F7F8FA')   # alternating table rows, page bg
WHITE    = white

PAGE_W, PAGE_H = letter          # 612 × 792 points (US Letter)

# ── Font setup ─────────────────────────────────────────────────────────────────

FONTS_DIR = Path('assets/fonts')

# Montserrat weights needed — maps ReportLab name to GitHub raw TTF URL
FONT_FILES = {
    'Montserrat-Regular':   'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Regular.ttf',
    'Montserrat-Medium':    'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Medium.ttf',
    'Montserrat-SemiBold':  'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-SemiBold.ttf',
    'Montserrat-Bold':      'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Bold.ttf',
    'Montserrat-ExtraBold': 'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-ExtraBold.ttf',
}


def download_fonts():
    """Download Montserrat TTF files from GitHub if not already present locally."""
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in FONT_FILES.items():
        path = FONTS_DIR / f'{name}.ttf'
        if path.exists():
            print(f'[fonts] Already have {name}', file=sys.stderr)
            continue
        print(f'[fonts] Downloading {name} …', file=sys.stderr)
        resp = httpx.get(url, follow_redirects=True, timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(f'Font download failed for {name}: HTTP {resp.status_code}')
        path.write_bytes(resp.content)
        print(f'[fonts] Saved → {path}', file=sys.stderr)


def register_fonts():
    """Register all Montserrat weights with ReportLab's pdfmetrics registry."""
    for name in FONT_FILES:
        path = FONTS_DIR / f'{name}.ttf'
        pdfmetrics.registerFont(TTFont(name, str(path)))
    print('[fonts] All weights registered', file=sys.stderr)


# ── Shared drawing helpers ─────────────────────────────────────────────────────

def draw_wordmark(c, x, y, primary_color=WHITE, accent_color=GOLD, size=30):
    """
    Draw the McKeever Consulting wordmark at (x, y).
    'McKeever' in ExtraBold at `size`, 'CONSULTING' tracked out below in Medium,
    finished with a gold rule. x/y is the baseline of the 'McKeever' line.
    """
    # "McKeever" — ExtraBold, larger, primary colour
    c.setFont('Montserrat-ExtraBold', size)
    c.setFillColor(primary_color)
    c.drawString(x, y, 'McKeever')
    mck_w = c.stringWidth('McKeever', 'Montserrat-ExtraBold', size)

    # "CONSULTING" — Medium, spaced-out letterforms, gold, below McKeever
    sub_size = round(size * 0.38)
    sub_y    = y - (size * 0.56)
    # Simulate letter tracking by spacing out the string manually
    sub_text = 'C O N S U L T I N G'
    c.setFont('Montserrat-Medium', sub_size)
    c.setFillColor(accent_color)
    c.drawString(x, sub_y, sub_text)
    sub_w = c.stringWidth(sub_text, 'Montserrat-Medium', sub_size)

    # Gold rule under "CONSULTING"
    rule_w = max(mck_w, sub_w)
    rule_y = sub_y - 5
    c.setStrokeColor(accent_color)
    c.setLineWidth(1.2)
    c.line(x, rule_y, x + rule_w, rule_y)


def draw_page_header(c, page_num):
    """
    Thin navy bar across the top of an interior page.
    Left: compact wordmark. Right: page number.
    """
    bar_h = 30
    bar_y  = PAGE_H - bar_h

    # Navy bar
    c.setFillColor(NAVY)
    c.rect(0, bar_y, PAGE_W, bar_h, fill=1, stroke=0)

    # Compact wordmark — two lines inside the bar
    c.setFont('Montserrat-Bold', 11)
    c.setFillColor(WHITE)
    c.drawString(0.4 * inch, bar_y + 10, 'McKeever')

    c.setFont('Montserrat-Medium', 6.5)
    c.setFillColor(GOLD)
    c.drawString(0.4 * inch, bar_y + 2.5, 'C O N S U L T I N G')

    # Page number, right-aligned
    c.setFont('Montserrat-Regular', 9)
    c.setFillColor(WHITE)
    c.drawRightString(PAGE_W - 0.4 * inch, bar_y + 10, f'Page {page_num}')


def draw_page_footer(c):
    """Thin silver rule + confidentiality text + placeholder URL."""
    footer_y = 0.38 * inch
    c.setStrokeColor(SILVER)
    c.setLineWidth(0.4)
    c.line(0.5 * inch, footer_y + 9, PAGE_W - 0.5 * inch, footer_y + 9)

    c.setFont('Montserrat-Regular', 7)
    c.setFillColor(SILVER)
    c.drawString(0.5 * inch, footer_y, 'Confidential — Prepared by McKeever Consulting')
    c.drawRightString(PAGE_W - 0.5 * inch, footer_y, 'mckeeverconsulting.com')


# ── Page 1: Cover ──────────────────────────────────────────────────────────────

def draw_cover(c):
    """
    Full navy cover page.
    Top: report type label + gold rule.
    Centre: proposition title, subtitle, viability score badge.
    Bottom: McKeever Consulting wordmark + confidential line.
    """
    # Full-page navy background
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # ── Report type label ──────────────────────────────────────────────────────
    label_y = PAGE_H - 1.1 * inch
    c.setFont('Montserrat-Medium', 8.5)
    c.setFillColor(GOLD)
    c.drawCentredString(PAGE_W / 2, label_y, 'B U S I N E S S   V I A B I L I T Y   R E P O R T')

    # Gold rule under label
    c.setStrokeColor(GOLD)
    c.setLineWidth(0.8)
    c.line(1.4 * inch, label_y - 8, PAGE_W - 1.4 * inch, label_y - 8)

    # ── Proposition title ──────────────────────────────────────────────────────
    title_y = PAGE_H - 2.7 * inch
    c.setFont('Montserrat-ExtraBold', 30)
    c.setFillColor(WHITE)
    c.drawCentredString(PAGE_W / 2, title_y, 'Camel Milk Export')

    c.setFont('Montserrat-Bold', 18)
    c.setFillColor(SILVER)
    c.drawCentredString(PAGE_W / 2, title_y - 38, 'United States Market Entry')

    # ── Viability score badge ──────────────────────────────────────────────────
    badge_w, badge_h = 188, 72
    badge_x = (PAGE_W - badge_w) / 2
    badge_y = PAGE_H - 4.6 * inch

    c.setFillColor(GOLD)
    c.roundRect(badge_x, badge_y, badge_w, badge_h, radius=8, fill=1, stroke=0)

    # Verdict label inside badge
    c.setFont('Montserrat-Bold', 10)
    c.setFillColor(NAVY)
    c.drawCentredString(PAGE_W / 2, badge_y + badge_h - 20, 'VIABILITY VERDICT')

    # Thin separator inside badge
    c.setStrokeColor(NAVY)
    c.setLineWidth(0.4)
    c.line(badge_x + 16, badge_y + badge_h - 25, badge_x + badge_w - 16, badge_y + badge_h - 25)

    # Score
    c.setFont('Montserrat-ExtraBold', 26)
    c.setFillColor(NAVY)
    c.drawCentredString(PAGE_W / 2, badge_y + 24, 'MODERATE  3.2 / 5.0')

    # ── Report date ────────────────────────────────────────────────────────────
    c.setFont('Montserrat-Regular', 10)
    c.setFillColor(SILVER)
    c.drawCentredString(PAGE_W / 2, PAGE_H - 5.9 * inch, 'April 2026')

    # ── Subtle divider above wordmark ──────────────────────────────────────────
    c.setStrokeColor(HexColor('#2D4A6A'))  # slightly lighter than navy — barely visible
    c.setLineWidth(0.5)
    c.line(1.4 * inch, 2.4 * inch, PAGE_W - 1.4 * inch, 2.4 * inch)

    # ── Centred McKeever Consulting wordmark ───────────────────────────────────
    # Calculate width of "McKeever" so we can centre the wordmark block
    wm_size = 32
    mck_w   = c.stringWidth('McKeever', 'Montserrat-ExtraBold', wm_size)
    wm_x    = (PAGE_W - mck_w) / 2
    draw_wordmark(c, wm_x, 2.0 * inch, primary_color=WHITE, accent_color=GOLD, size=wm_size)

    # ── Confidential footer ────────────────────────────────────────────────────
    c.setFont('Montserrat-Regular', 7)
    c.setFillColor(HexColor('#4A6080'))
    c.drawCentredString(PAGE_W / 2, 0.4 * inch, 'CONFIDENTIAL — Prepared exclusively for Brendon McKeever')


# ── Page 2: Interior sample ────────────────────────────────────────────────────

def draw_interior_sample(c):
    """
    Sample interior page showing: section heading, body paragraphs,
    a formatted data table, and a key-finding callout box.
    """
    draw_page_header(c, page_num=5)

    margin_l  = 0.6 * inch
    margin_r  = PAGE_W - 0.6 * inch
    content_w = margin_r - margin_l
    y         = PAGE_H - 0.9 * inch   # cursor — moves down as we add elements

    # ── Section label + heading ────────────────────────────────────────────────
    y -= 0.35 * inch
    c.setFont('Montserrat-SemiBold', 8)
    c.setFillColor(GOLD)
    c.drawString(margin_l, y, 'SECTION 5')

    y -= 24
    c.setFont('Montserrat-Bold', 20)
    c.setFillColor(NAVY)
    c.drawString(margin_l, y, 'Competitor Analysis')

    # Gold underline — only as wide as the heading text
    heading_w = c.stringWidth('Competitor Analysis', 'Montserrat-Bold', 20)
    y -= 6
    c.setStrokeColor(GOLD)
    c.setLineWidth(2)
    c.line(margin_l, y, margin_l + heading_w, y)

    # ── Body paragraphs ────────────────────────────────────────────────────────
    y -= 22
    c.setFont('Montserrat-Regular', 10)
    c.setFillColor(DARK)

    body = [
        'The US dehydrated camel milk market currently has three established players and two',
        'emerging brands targeting health-conscious consumers. Market concentration is moderate,',
        'leaving meaningful room for a well-positioned new entrant with a credible origin story',
        'and strong regulatory compliance.',
        '',
        'Desert Farms holds the largest share through Amazon and Whole Foods distribution.',
        'Camelicious has a premium positioning but limited US retail presence. No current',
        'competitor sources exclusively from the Horn of Africa — a clear differentiation',
        'opportunity on provenance and traditional practice.',
    ]

    line_h = 15.5
    for line in body:
        c.drawString(margin_l, y, line)
        y -= line_h

    # ── Competitors table ──────────────────────────────────────────────────────
    y -= 0.3 * inch

    table_data = [
        ['Competitor',      'Origin', 'Price / 100g', 'Distribution',         'Confidence'],
        ['Desert Farms',    'USA',    '$4.20',         'Amazon, Whole Foods',  'High'],
        ['Camelicious',     'UAE',    '$5.80',         'Specialty retail',     'High'],
        ['Camel Culture',   'USA',    '$3.90',         'Direct / online',      'Medium'],
        ['Shumei Natural',  'Japan',  '$6.20',         'Online only',          'Low'],
    ]

    col_widths = [1.55*inch, 0.75*inch, 1.0*inch, 1.85*inch, 0.85*inch]

    table = Table(table_data, colWidths=col_widths)
    table.setStyle(TableStyle([
        # Header row — gold bg, navy text, bold
        ('BACKGROUND',    (0, 0), (-1, 0), GOLD),
        ('TEXTCOLOR',     (0, 0), (-1, 0), NAVY),
        ('FONTNAME',      (0, 0), (-1, 0), 'Montserrat-Bold'),
        ('FONTSIZE',      (0, 0), (-1, 0), 8.5),
        ('TOPPADDING',    (0, 0), (-1, 0), 7),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 7),

        # Data rows — alternating white / off-white
        ('BACKGROUND',    (0, 1), (-1, 1), WHITE),
        ('BACKGROUND',    (0, 2), (-1, 2), OFFWHITE),
        ('BACKGROUND',    (0, 3), (-1, 3), WHITE),
        ('BACKGROUND',    (0, 4), (-1, 4), OFFWHITE),
        ('FONTNAME',      (0, 1), (-1, -1), 'Montserrat-Regular'),
        ('FONTSIZE',      (0, 1), (-1, -1), 9),
        ('TEXTCOLOR',     (0, 1), (-1, -1), DARK),
        ('TOPPADDING',    (0, 1), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 6),

        # Grid — light silver lines, stronger rule under header
        ('GRID',          (0, 0), (-1, -1), 0.4, SILVER),
        ('LINEBELOW',     (0, 0), (-1, 0),  1.5, NAVY),

        # Padding + alignment
        ('ALIGN',         (0, 0), (-1, -1), 'LEFT'),
        ('LEFTPADDING',   (0, 0), (-1, -1), 8),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 8),
    ]))

    table.wrapOn(c, content_w, 4 * inch)
    table_h = table._height
    table.drawOn(c, margin_l, y - table_h)
    y -= table_h

    # ── Key finding callout box ────────────────────────────────────────────────
    y -= 0.3 * inch
    box_h = 0.72 * inch

    # Light blue-grey background
    c.setFillColor(HexColor('#EEF2F7'))
    c.roundRect(margin_l, y - box_h, content_w, box_h, radius=4, fill=1, stroke=0)

    # Navy left accent bar
    c.setFillColor(NAVY)
    c.rect(margin_l, y - box_h, 4, box_h, fill=1, stroke=0)

    # "Key Finding" label
    c.setFont('Montserrat-SemiBold', 8.5)
    c.setFillColor(NAVY)
    c.drawString(margin_l + 14, y - 16, 'Key Finding')

    # Finding text — two lines
    c.setFont('Montserrat-Regular', 9)
    c.setFillColor(DARK)
    c.drawString(margin_l + 14, y - 30, 'No competitor currently sources from the Horn of Africa — a clear provenance gap')
    c.drawString(margin_l + 14, y - 44, 'that a Somali-origin product can occupy with the right brand story.')

    draw_page_footer(c)


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    output_path = 'outputs/mckeever_brand_preview.pdf'
    os.makedirs('outputs', exist_ok=True)

    print('[preview] Downloading fonts if needed …', file=sys.stderr)
    download_fonts()
    register_fonts()

    print('[preview] Building preview PDF …', file=sys.stderr)
    cv = canvas.Canvas(output_path, pagesize=letter)

    draw_cover(cv)
    cv.showPage()

    draw_interior_sample(cv)
    cv.showPage()

    cv.save()
    print(f'[preview] Done → {output_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
