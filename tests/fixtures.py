"""Test fixtures for the end-to-end run.

    python tests/fixtures.py samples <outdir>            -> sample.pdf, sample.png
    python tests/fixtures.py leak <in> <out> <mode>      -> simulate a leak
        modes: pdf-screenshot | pdf-page-photo | image-screenshot | image-jpeg | copy
"""
import io
import shutil
import sys

import numpy as np
import pymupdf
from PIL import Image, ImageFilter


def samples(outdir: str) -> None:
    doc = pymupdf.open()
    for n in range(3):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 70), f"MINISTRY BRIEFING - RESTRICTED - page {n + 1}", fontsize=14)
        y = 110
        para = (
            "This briefing outlines the procurement timeline, budget envelope and vendor "
            "shortlist for the coastal radar programme. Distribution is limited to named "
            "recipients. Any reproduction must be reported to the security officer. "
        )
        for i in range(32):
            page.insert_text((60, y), (para * 2)[i * 7 % 120 : i * 7 % 120 + 92], fontsize=10)
            y += 21
    doc.save(f"{outdir}/sample.pdf")

    rng = np.random.default_rng(7)
    base = rng.normal(120, 45, (60, 80, 3)).clip(0, 255).astype(np.uint8)
    im = Image.fromarray(base).resize((1280, 960), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(3))
    arr = np.asarray(im).astype(np.float64) + rng.normal(0, 5, (960, 1280, 3))
    Image.fromarray(arr.clip(0, 255).astype(np.uint8)).save(f"{outdir}/sample.png")


def leak(src: str, dst: str, mode: str) -> None:
    if mode == "copy":
        shutil.copyfile(src, dst)
        return
    if mode.startswith("pdf"):
        doc = pymupdf.open(src)
        dpi = 110 if mode == "pdf-screenshot" else 96
        pix = doc[1].get_pixmap(dpi=dpi)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        if mode == "pdf-page-photo":
            w, h = im.size
            im = im.crop((40, 60, w - 30, h - 80)).resize((int(w * 1.3), int(h * 1.3)), Image.Resampling.BILINEAR)
        im.save(dst, "JPEG", quality=82)
        return
    im = Image.open(src).convert("RGB")
    if mode == "image-screenshot":
        w, h = im.size
        im = im.crop((50, 40, w - 70, h - 25)).resize((int((w - 120) * 0.8), int((h - 65) * 0.8)), Image.Resampling.LANCZOS)
        im.save(dst, "PNG")
    elif mode == "image-jpeg":
        im.save(dst, "JPEG", quality=65)
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    if sys.argv[1] == "samples":
        samples(sys.argv[2])
    else:
        leak(sys.argv[2], sys.argv[3], sys.argv[4])
