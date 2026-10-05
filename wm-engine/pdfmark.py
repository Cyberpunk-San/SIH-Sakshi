"""
PDF support for the Sakshi watermark engine.

Two modes, chosen by the sender's policy:

* preserve - keeps the original vector PDF (selectable text, small size) and adds a
  full-page, darkening-only overlay image carrying the watermark on every page.
* flatten  - rasterises every page and bakes the watermark into the page pixels.
  Larger files and no text selection, but there is no separate watermark object
  that a recipient could locate and delete.

Extraction renders pages to pixels and runs the same blind detector as images,
so it also works on screenshots or scans of individual pages.
"""
from __future__ import annotations

import io

import numpy as np
import pymupdf
from PIL import Image

import engine

# The watermark lives on a 100-dpi grid (4-px chips = 1 mm on paper). That survives
# on-screen captures at typical zoom levels; flattened pages are rendered at 200 dpi
# for legibility with the pattern enlarged 2x so both modes share the same grid.
PATTERN_DPI = 100
FLATTEN_DPI = 200
FLATTEN_SCALE = FLATTEN_DPI // PATTERN_DPI
OVERLAY_STRENGTH = 3.0  # peak darkening in 8-bit levels; below 3 the 8-bit alpha cannot carry the pattern
MAX_PAGES_TO_SCAN = 8


def _png(rgba: np.ndarray) -> bytes:
    b = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(b, "PNG", optimize=True)
    return b.getvalue()


def _render_rgb(page: "pymupdf.Page", dpi: int) -> np.ndarray:
    pix = page.get_pixmap(dpi=dpi, alpha=False, colorspace=pymupdf.csRGB)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)


def embed_pdf(data: bytes, key: bytes, wm_id: str, mode: str = "preserve") -> bytes:
    src = pymupdf.open(stream=data, filetype="pdf")
    if src.needs_pass:
        raise ValueError("password-protected PDFs are not supported")
    if mode == "flatten":
        out = pymupdf.open()
        for page in src:
            rgb = _render_rgb(page, FLATTEN_DPI)
            marked = engine.embed_array(rgb, key, wm_id, scale=FLATTEN_SCALE)
            buf = io.BytesIO()
            Image.fromarray(marked).save(buf, "JPEG", quality=92, subsampling=0)
            new = out.new_page(width=page.rect.width, height=page.rect.height)
            new.insert_image(new.rect, stream=buf.getvalue())
        out.set_metadata({k: v for k, v in (src.metadata or {}).items() if v and k in ("title", "author", "subject")})
        result = out.tobytes(garbage=3, deflate=True)
        out.close()
        src.close()
        return result

    if mode != "preserve":
        raise ValueError("mode must be 'preserve' or 'flatten'")
    for page in src:
        rect = page.rect
        w = max(1, int(round(rect.width / 72 * PATTERN_DPI)))
        h = max(1, int(round(rect.height / 72 * PATTERN_DPI)))
        overlay = engine.overlay_rgba(w, h, key, wm_id, strength=OVERLAY_STRENGTH)
        page.insert_image(rect, stream=_png(overlay), overlay=True, keep_proportion=False)
    result = src.tobytes(garbage=3, deflate=True)
    src.close()
    return result


def extract_pdf(data: bytes, key: bytes) -> dict:
    doc = pymupdf.open(stream=data, filetype="pdf")
    observations = []
    for i, page in enumerate(doc):
        if i >= MAX_PAGES_TO_SCAN:
            break
        gray = engine.gray_of(_render_rgb(page, PATTERN_DPI))
        obs = engine.observe(gray, key)
        observations.append(obs)
        # Early exit once we have strong evidence from a couple of pages.
        if sum(1 for o in observations if o and o.z >= 9.0) >= 2:
            break
    doc.close()
    result = engine.decode_observations(observations, key)
    result["pages_scanned"] = len(observations)
    return result
