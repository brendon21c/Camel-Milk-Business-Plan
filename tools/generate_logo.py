"""
generate_logo.py
Generates the B&I Camel Milk brand logo as a PNG file.
Outputs to assets/logo.png — transparent background, 600x600px.

Design:
  - Circular badge, deep jungle green background
  - Sandy gold camel silhouette (dromedary, facing right)
  - "B & I" in Segoe Script Bold, deep green, centered on the camel body

Color palette:
  - Deep jungle green : #1A3C34  (background, text on camel)
  - Sandy gold        : #C9A050  (outer ring, camel)
  - Soft cream        : #F5EDD8  (inner ring accent)
"""

import os
from PIL import Image, ImageDraw, ImageFont

# ── Constants ──────────────────────────────────────────────────────────────────
SIZE       = 600
CENTER     = SIZE // 2
GREEN_DARK = (26,  60,  52)    # deep jungle green — bg and text
SAND_GOLD  = (201, 160, 80)    # sandy gold — ring and camel
CREAM      = (245, 237, 216)   # soft cream — thin inner ring accent

OUTPUT_PATH = "assets/logo.png"


def draw_circle(draw, cx, cy, r, fill=None, outline=None, width=1):
    """Draw a circle centered at (cx, cy) with radius r."""
    draw.ellipse([cx - r, cy - r, cx + r, cy + r],
                 fill=fill, outline=outline, width=width)


def make_camel_silhouette(size):
    """
    Render the dromedary camel emoji (U+1F42A) from Segoe UI Emoji at a large
    size, then convert it to a single-color SAND_GOLD silhouette on a
    transparent background.

    Returns an RGBA Image of dimensions (size x size).
    """
    # ── Render the emoji to a temporary RGBA image ────────────────────────────
    tmp = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tmp)

    try:
        # Segoe UI Emoji supports full-color emoji on Windows
        font = ImageFont.truetype("C:/Windows/Fonts/seguiemj.ttf", int(size * 0.85))
        draw.text((size // 2, size // 2), "\U0001F42A",
                  font=font, anchor="mm", embedded_color=True)
    except Exception as e:
        raise RuntimeError(f"Could not render camel emoji: {e}")

    # ── Convert rendered emoji to a grayscale alpha mask ──────────────────────
    # Any pixel that has meaningful color/alpha becomes part of the silhouette.
    r, g, b, a = tmp.split()
    # Use the alpha channel (or luminance if alpha is flat) as the mask
    mask = a  # pixels that are non-transparent = camel shape

    # ── Paint silhouette in SAND_GOLD using the mask ──────────────────────────
    silhouette = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    colored    = Image.new("RGBA", (size, size), SAND_GOLD + (255,))
    silhouette.paste(colored, mask=mask)

    return silhouette


def build_logo():
    """
    Assemble the full logo:
      1. Transparent background
      2. Outer sandy gold ring
      3. Inner deep green circle
      4. Thin cream accent ring
      5. Camel silhouette centered slightly above canvas center
      6. "B & I" in Segoe Script Bold, dark green, over the camel body
    """
    img  = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── 1. Outer ring (sandy gold) ────────────────────────────────────────────
    draw_circle(draw, CENTER, CENTER, 292, fill=SAND_GOLD)

    # ── 2. Main circle (deep green) ───────────────────────────────────────────
    draw_circle(draw, CENTER, CENTER, 270, fill=GREEN_DARK)

    # ── 3. Thin cream inner accent ring ───────────────────────────────────────
    draw_circle(draw, CENTER, CENTER, 252, outline=CREAM, width=2)

    # ── 4. Camel silhouette ───────────────────────────────────────────────────
    # Render emoji as a SAND_GOLD silhouette on its own 340x340 canvas,
    # then composite it centered onto the main logo image.
    camel_size = 340
    camel_img  = make_camel_silhouette(camel_size)

    # Center the camel tile on the logo canvas.
    # Shift left by 15px to optically balance the camel (head/neck extends right,
    # making the silhouette appear right-heavy when purely tile-centered).
    # Shift down by 18px to sit in the true vertical center of the inner ring.
    camel_x = CENTER - camel_size // 2 - 15
    camel_y = CENTER - camel_size // 2 + 18
    img.alpha_composite(camel_img, dest=(camel_x, camel_y))
    draw = ImageDraw.Draw(img)  # refresh draw handle after composite

    # ── 5. "B & I" monogram in Segoe Script Bold ──────────────────────────────
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/segoescb.ttf", 62)
    except Exception:
        font = ImageFont.truetype("C:/Windows/Fonts/georgiab.ttf", 58)

    text = "B & I"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw   = bbox[2] - bbox[0]
    th   = bbox[3] - bbox[1]

    # Track the camel shift so text stays centered on the body
    text_x = CENTER - tw // 2 - 15 + 28   # camel offset (-15) + body-right offset (+28)
    text_y = CENTER + 18 - 62 - th // 2   # camel offset (+18) + body position (-62)

    # Dark shadow so text reads on both sandy and green areas
    shadow_col = (10, 30, 22, 180)
    img_shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ds = ImageDraw.Draw(img_shadow)
    ds.text((text_x + 2, text_y + 2), text, font=font, fill=shadow_col)
    img = Image.alpha_composite(img, img_shadow)
    draw = ImageDraw.Draw(img)

    # Cream text — readable against both the sandy gold camel and dark green bg
    draw.text((text_x, text_y), text, font=font, fill=CREAM)

    # ── Save ──────────────────────────────────────────────────────────────────
    os.makedirs("assets", exist_ok=True)
    img.save(OUTPUT_PATH, "PNG")
    print(f"Logo saved to {OUTPUT_PATH}")


if __name__ == "__main__":
    build_logo()
