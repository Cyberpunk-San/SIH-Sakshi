"""Robustness tests for the watermark engine.  Run:  python -m pytest wm-engine -q"""
import io
import os
import sys

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(__file__))
import engine  # noqa: E402
import pdfmark  # noqa: E402

KEY = b"k" * 32
WM = "0123456789abcdef"


def document_image(w=1240, h=1754) -> Image.Image:
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    rng = np.random.default_rng(1)
    y = 80
    while y < h - 80:
        x = 90
        while x < w - 150:
            wl = int(rng.integers(20, 110))
            d.rectangle([x, y, x + wl, y + 14], fill=(30, 30, 30))
            x += wl + 14
        y += 30
    return im


def photo_image(w=1024, h=768) -> Image.Image:
    rng = np.random.default_rng(2)
    base = rng.normal(128, 40, (h // 16, w // 16, 3)).clip(0, 255).astype(np.uint8)
    im = Image.fromarray(base).resize((w, h), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(2))
    arr = np.asarray(im).astype(np.float64) + rng.normal(0, 6, (h, w, 3))
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def to_bytes(im: Image.Image, fmt="PNG", **kw) -> bytes:
    b = io.BytesIO()
    im.save(b, fmt, **kw)
    return b.getvalue()


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 10 * np.log10(255**2 / mse)


@pytest.fixture(scope="module", params=["document", "photo"])
def marked(request):
    im = document_image() if request.param == "document" else photo_image()
    data, _ = engine.embed_image(to_bytes(im), KEY, WM)
    return im, Image.open(io.BytesIO(data)).convert("RGB")


def check(im: Image.Image):
    r = engine.extract_image(to_bytes(im), KEY)
    assert r["found"], r
    assert r["wm_id"] == WM, r
    return r


def test_invisible(marked):
    orig, wm = (np.asarray(x).astype(np.float64) for x in marked)
    diff = wm - orig
    # Paper is shifted uniformly by ~3 levels (imperceptible); the textured part of
    # the change must stay well under the visibility threshold.
    assert np.abs(diff).max() <= 13
    assert 10 * np.log10(255**2 / np.mean((diff - diff.mean()) ** 2)) > 38.0
    assert psnr(np.asarray(marked[0]), np.asarray(marked[1])) > 34.0


def test_clean_copy(marked):
    check(marked[1])


def test_jpeg_q70(marked):
    check(Image.open(io.BytesIO(to_bytes(marked[1], "JPEG", quality=70))))


def test_crop(marked):
    wm = marked[1]
    check(wm.crop((137, 211, wm.width - 90, wm.height - 160)))


def test_screenshot_scale_up(marked):
    wm = marked[1]
    check(wm.resize((int(wm.width * 1.5), int(wm.height * 1.5)), Image.Resampling.BILINEAR))


def test_scale_down(marked):
    wm = marked[1]
    check(wm.resize((int(wm.width * 0.8), int(wm.height * 0.8)), Image.Resampling.LANCZOS))


def test_wrong_key_finds_nothing(marked):
    r = engine.extract_image(to_bytes(marked[1]), b"x" * 32)
    assert not r["found"] or r["wm_id"] != WM


def test_unmarked_finds_nothing(marked):
    r = engine.extract_image(to_bytes(marked[0]), KEY)
    assert not r["found"]


def test_distinct_sessions_distinct_marks():
    im = photo_image()
    a, _ = engine.embed_image(to_bytes(im), KEY, "00000000000000aa")
    b, _ = engine.embed_image(to_bytes(im), KEY, "00000000000000bb")
    assert engine.extract_image(a, KEY)["wm_id"] == "00000000000000aa"
    assert engine.extract_image(b, KEY)["wm_id"] == "00000000000000bb"


def make_pdf() -> bytes:
    import pymupdf

    doc = pymupdf.open()
    for n in range(2):
        page = doc.new_page(width=595, height=842)
        text = ("Confidential briefing paragraph %d. " % n) * 12
        y = 72
        for _ in range(30):
            page.insert_text((60, y), text[:90], fontsize=10)
            y += 22
    return doc.tobytes()


@pytest.mark.parametrize("mode", ["preserve", "flatten"])
def test_pdf_roundtrip(mode):
    data = make_pdf()
    marked_pdf = pdfmark.embed_pdf(data, KEY, WM, mode=mode)
    r = pdfmark.extract_pdf(marked_pdf, KEY)
    assert r["found"] and r["wm_id"] == WM, r
    assert pdfmark.extract_pdf(data, KEY)["found"] is False


@pytest.mark.parametrize("mode", ["preserve", "flatten"])
def test_pdf_page_screenshot(mode):
    import pymupdf

    marked_pdf = pdfmark.embed_pdf(make_pdf(), KEY, WM, mode=mode)
    doc = pymupdf.open(stream=marked_pdf, filetype="pdf")
    pix = doc[0].get_pixmap(dpi=110)  # a viewer screenshot at an arbitrary zoom
    shot = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    check(Image.open(io.BytesIO(to_bytes(shot, "JPEG", quality=85))))
